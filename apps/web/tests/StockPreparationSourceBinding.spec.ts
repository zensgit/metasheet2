import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'

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
import { compileSourcePlanDraft, createSyntheticSourcePlanDraft } from '../src/services/integration/stockPreparation/sourcePlanDraft'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import type { IntegrationScope } from '../src/services/integration/workbench'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
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

/** A post-save readback that really does confirm the source the admin just chose. */
function persistedCustomerBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: SCOPE.tenantId,
    workspaceId: SCOPE.workspaceId,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    externalSystemId: CUSTOMER_PLM,
    updatedBy: 'u_admin',
    createdAt: 't0',
    updatedAt: 't1',
    ...overrides,
  }
}

function confirmedCustomerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return bindingPayload({
    effectiveExternalSystemId: CUSTOMER_PLM,
    origin: 'persisted',
    persistedBinding: persistedCustomerBinding(),
    effectiveSourceProblem: null,
    takesEffectWithoutRestart: true,
    ...overrides,
  })
}

interface Behaviour {
  get?: () => Response | Promise<Response>
  post?: () => Response | Promise<Response>
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

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

describe('BOM备料 数据来源 (工作台里选源)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null
  const onBindingRead = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    h.locale = 'zh-CN'
    // A platform admin by default — the tier both source-binding routes require.
    h.permissions = ['integration:admin', 'stock-prep:admin']
    h.apiFetch.mockReset()
    onBindingRead.mockReset()
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
    localStorage.clear()
  })

  async function mountPanel(scope: IntegrationScope = SCOPE): Promise<HTMLDivElement> {
    app = createApp(StockPreparationSourceBindingPanel as Component, { scope, onBindingRead })
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

  function chooseDraftFile(root: HTMLElement, textContent: string): void {
    const input = node(root, 'stock-prep-source-plan-draft-import') as HTMLInputElement
    const file = new File([textContent], 'stock-preparation-plm-role-draft.review.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change'))
  }

  async function fillPrivateDraft(root: HTMLElement, object = 'SYN_PRIVATE_LAYOUT_A'): Promise<void> {
    ;(node(root, 'stock-prep-source-plan-draft-synthetic') as HTMLButtonElement).click()
    const input = node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement
    input.value = object
    input.dispatchEvent(new Event('input'))
    ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
    await flush(2)
    expect(text(root, 'stock-prep-source-plan-draft-json')).toContain(object)
  }

  async function requestBindingConfirmation(root: HTMLElement): Promise<void> {
    const select = node(root, 'stock-prep-source-select') as HTMLSelectElement
    select.value = CUSTOMER_PLM
    select.dispatchEvent(new Event('change'))
    await flush(2)
    ;(node(root, 'stock-prep-source-save') as HTMLButtonElement).click()
    await flush(2)
    expect(node(root, 'stock-prep-source-confirm-save')).not.toBeNull()
  }

  async function confirmSave(root: HTMLElement): Promise<void> {
    await requestBindingConfirmation(root)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush()
  }

  function switchAccount(): void {
    // Match useAuth: its reset event precedes the synchronous token storage write.
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic-user-b-token')
  }

  function expectCleared(root: HTMLElement): void {
    expect(node(root, 'stock-prep-source-current')).toBeNull()
    expect(node(root, 'stock-prep-source-no-restart')).toBeNull()
    expect(node(root, 'stock-prep-source-confirm')).toBeNull()
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(node(root, 'stock-prep-source-unconfirmed')).toBeNull()
    expect(node(root, 'stock-prep-source-error')).toBeNull()
    expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
    expect(node(root, 'stock-prep-source-plan-draft-download')).toBeNull()
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).value).toBe('')
    expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('')
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
    installRoutes({ afterSave: confirmedCustomerPayload() })
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

  it.each([
    ['another workspace', { workspaceId: 'workspace-other' }],
    ['a tenant-level fallback', { workspaceId: null }],
    ['another tenant', { tenantId: 'tenant-other' }],
  ])('S-31: the same effective source from %s can be explicitly bound here, but cancelling never writes', async (_label, bindingScope) => {
    installRoutes({ get: () => envelope(confirmedCustomerPayload({
      persistedBinding: persistedCustomerBinding(bindingScope as Record<string, unknown>),
    })) })
    const root = await mountPanel()
    const save = node(root, 'stock-prep-source-save') as HTMLButtonElement
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).value).toBe(CUSTOMER_PLM)
    expect(save.disabled).toBe(false)
    expect(text(root, 'stock-prep-source-origin')).toContain('不是当前范围的精确绑定')
    expect(text(root, 'stock-prep-source-scope-binding-note')).toContain('在当前范围建立来源绑定，原范围绑定保留')
    expect(text(root, 'stock-prep-source-scope-binding-note')).toContain('不会自动保存或切换范围')
    expect(posted).toHaveLength(0)

    save.click()
    await flush(2)
    expect(text(root, 'stock-prep-source-confirm-text')).toContain('在当前范围建立')
    expect(text(root, 'stock-prep-source-confirm-text')).toContain('原范围绑定保留')
    expect(posted).toHaveLength(0)
    ;(node(root, 'stock-prep-source-cancel') as HTMLButtonElement).click()
    await flush(2)
    expect(node(root, 'stock-prep-source-confirm')).toBeNull()
    expect(posted).toHaveLength(0)
    expect(getCount).toBe(1)
  })

  it('S-32: explicitly establishes the same source in tenant scope only after an exact readback, retaining the original scope', async () => {
    const tenantScope = { tenantId: SCOPE.tenantId, workspaceId: null }
    const originalBinding = persistedCustomerBinding({ workspaceId: SCOPE.tenantId })
    installRoutes({
      get: () => envelope(confirmedCustomerPayload({ persistedBinding: originalBinding })),
      afterSave: confirmedCustomerPayload({ persistedBinding: persistedCustomerBinding({ workspaceId: null }) }),
    })
    const root = await mountPanel(tenantScope)
    expect((node(root, 'stock-prep-source-save') as HTMLButtonElement).disabled).toBe(false)
    expect(posted).toHaveLength(0)
    await confirmSave(root)

    expect(posted).toHaveLength(1)
    expect(posted[0].body).toEqual({ externalSystemId: CUSTOMER_PLM })
    const scopeQuery = new URL(posted[0].url, 'http://synthetic.invalid').searchParams
    expect(scopeQuery.get('tenantId')).toBe(SCOPE.tenantId)
    expect(scopeQuery.has('workspaceId')).toBe(false)
    expect(getCount).toBe(2)
    expect(h.apiFetch).toHaveBeenCalledTimes(3)
    expect(h.apiFetch.mock.calls.every(([, init]) => !init?.method || init.method === 'POST')).toBe(true)
    expect(originalBinding.workspaceId).toBe(SCOPE.tenantId)
    expect(text(root, 'stock-prep-source-saved')).toContain('已保存,并且已经生效')
    expect(node(root, 'stock-prep-source-unconfirmed')).toBeNull()
    expect(node(root, 'stock-prep-source-scope-binding-note')).toBeNull()
    expect((node(root, 'stock-prep-source-save') as HTMLButtonElement).disabled).toBe(true)
    ;(node(root, 'stock-prep-source-save') as HTMLButtonElement).click()
    await flush(2)
    expect(node(root, 'stock-prep-source-confirm')).toBeNull()
    expect(posted).toHaveLength(1)
  })

  it('S-33: an existing exact-scope binding to the same source remains disabled', async () => {
    installRoutes({ get: () => envelope(confirmedCustomerPayload()) })
    const root = await mountPanel()
    const save = node(root, 'stock-prep-source-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    save.click()
    await flush(2)
    expect(node(root, 'stock-prep-source-confirm')).toBeNull()
    expect(node(root, 'stock-prep-source-scope-binding-note')).toBeNull()
    expect(posted).toHaveLength(0)
  })

  it.each([
    ['another tenant', { persistedBinding: persistedCustomerBinding({ tenantId: 'tenant-other' }) }],
    ['another workspace', { persistedBinding: persistedCustomerBinding({ workspaceId: 'workspace-other' }) }],
    ['a tenant-level fallback', { persistedBinding: persistedCustomerBinding({ workspaceId: null }) }],
    ['another persisted action', { persistedBinding: persistedCustomerBinding({ actionId: 'different-action' }) }],
    ['another response action', { actionId: 'different-action' }],
    ['another persisted source', { persistedBinding: persistedCustomerBinding({ externalSystemId: DEMO_SOURCE }) }],
    ['a deployment-default origin', { origin: 'deploy_default' }],
    ['no persisted binding', { persistedBinding: null }],
    ['an omitted persisted workspace', { persistedBinding: persistedCustomerBinding({ workspaceId: undefined }) }],
  ])('S-34: a readback with %s cannot confirm a successful save even when its effective source matches', async (_label, overrides) => {
    installRoutes({ afterSave: confirmedCustomerPayload(overrides as Record<string, unknown>) })
    const root = await mountPanel()
    await confirmSave(root)
    expect(posted).toHaveLength(1)
    expect(posted[0].body).toEqual({ externalSystemId: CUSTOMER_PLM })
    expect(getCount).toBe(2)
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(text(root, 'stock-prep-source-unconfirmed')).toContain('不会自动再次保存')
    await flush(2)
    expect(posted).toHaveLength(1)
    expect(h.apiFetch).toHaveBeenCalledTimes(3)
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
    expect(node(root, 'stock-prep-source-plan-draft')).toBeNull()

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

  // -------------------------------------------------------------------------
  // S-09 (P0-8) — action → result → AUTO-REREAD, no manual refresh.
  // -------------------------------------------------------------------------

  it('S-09: a successful save RE-READS the binding — the panel reflects the new source on its own', async () => {
    installRoutes({
      // The GET after the POST answers with the source that was just chosen — the server's own
      // authority on what the action will now resolve to, not a value this panel invented locally.
      afterSave: bindingPayload({ effectiveExternalSystemId: CUSTOMER_PLM, origin: 'persisted' }),
    })
    const root = await mountPanel()
    expect(text(root, 'stock-prep-source-current-name')).toContain('内置演示源')

    const select = node(root, 'stock-prep-source-select') as HTMLSelectElement
    select.value = CUSTOMER_PLM
    select.dispatchEvent(new Event('change'))
    await flush(2)
    ;(node(root, 'stock-prep-source-save') as HTMLButtonElement).click()
    await flush(2)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush()

    // The new explicit refresh is for an invalidated session. This unchanged-session save still
    // re-reads automatically, without clicking it or trusting the POST's echo.
    expect(getCount).toBe(2)
    expect(text(root, 'stock-prep-source-current-name')).toContain('客户 PLM 只读库')
    expect((node(root, 'stock-prep-source-refresh') as HTMLButtonElement).disabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // S-10 — local, structure-only PLM role draft. This is not a second source
  // binding workflow: it must not read, write, or claim an effective readPlan.
  // -------------------------------------------------------------------------

  it('S-10: produces and downloads only a valid local review draft, without changing the binding', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:source-plan-draft')
    const revokeObjectURL = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    try {
      const root = await mountPanel()
      const callsAfterMount = h.apiFetch.mock.calls.length
      expect(node(root, 'stock-prep-source-plan-draft')).not.toBeNull()
      expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
      expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('')
      expect(text(root, 'stock-prep-source-plan-draft-note')).toContain('只检查结构')
      expect(text(root, 'stock-prep-source-plan-draft-note')).toContain('不是行数')
      expect(text(root, 'stock-prep-source-plan-draft-note')).toContain('未审批不会生效')

      // The only convenience action uses known synthetic identifiers. It neither observes nor
      // changes the server-held binding/read plan, and it makes no request beyond mount's GET.
      ;(node(root, 'stock-prep-source-plan-draft-synthetic') as HTMLButtonElement).click()
      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(h.apiFetch).toHaveBeenCalledTimes(callsAfterMount)
      expect(posted).toEqual([])
      expect(text(root, 'stock-prep-source-current-name')).toContain('内置演示源')
      expect(text(root, 'stock-prep-source-plan-draft-json')).toContain('stock-preparation-plm-role-draft')
      expect(text(root, 'stock-prep-source-plan-draft-review')).toContain('未生效')

      ;(node(root, 'stock-prep-source-plan-draft-download') as HTMLButtonElement).click()
      await flush(2)
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const downloaded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(createObjectURL.mock.calls[0][0])
      })
      expect(JSON.parse(downloaded)).toEqual(JSON.parse(text(root, 'stock-prep-source-plan-draft-json')))
      expect(JSON.parse(downloaded)).toMatchObject({ status: 'confirm-required', validation: 'structure-only' })
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:source-plan-draft')
      expect(posted).toEqual([])

      // Editing is a new candidate: the preceding JSON immediately disappears. An invalid
      // candidate must render compiler feedback and never regain a download control.
      const objectInput = node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement
      objectInput.value = 'unsafe-name!'
      objectInput.dispatchEvent(new Event('input'))
      await flush(2)
      expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
      expect(node(root, 'stock-prep-source-plan-draft-download')).toBeNull()

      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(node(root, 'stock-prep-source-plan-draft-issues')).not.toBeNull()
      expect(text(root, 'stock-prep-source-plan-draft-issues')).toContain('项目路径关联 / 来源表')
      expect(objectInput.getAttribute('aria-invalid')).toBe('true')
      expect(objectInput.getAttribute('aria-describedby')).toBe('stock-prep-source-plan-draft-issues')
      expect(node(root, 'stock-prep-source-plan-draft-download')).toBeNull()
      expect(h.apiFetch).toHaveBeenCalledTimes(callsAfterMount)
      expect(posted).toEqual([])
      expect(node(root, 'stock-prep-source-saved')).toBeNull()
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      anchorClick.mockRestore()
    }
  })

  it('S-11: imports only a valid review envelope locally; invalid JSON keeps the form and clears preview', async () => {
    const root = await mountPanel()
    const callsAfterMount = h.apiFetch.mock.calls.length
    const sourceDraft = createSyntheticSourcePlanDraft()
    sourceDraft.roles.pathExAttr.object = 'IMPORTED_PATH_LINK'
    const source = compileSourcePlanDraft(sourceDraft)
    expect(source.ok).toBe(true)

    chooseDraftFile(root, JSON.stringify(source.envelope))
    await flush()
    expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('IMPORTED_PATH_LINK')
    expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
    expect(h.apiFetch).toHaveBeenCalledTimes(callsAfterMount)
    expect(posted).toEqual([])

    ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
    await flush(2)
    expect(node(root, 'stock-prep-source-plan-draft-json')).not.toBeNull()

    // No parse exception or file text appears in feedback, and the valid current form remains.
    chooseDraftFile(root, '{ private_json_marker')
    await flush()
    expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
    expect(text(root, 'stock-prep-source-plan-draft-issues')).toContain('无法读取')
    expect(root.textContent).not.toContain('private_json_marker')
    expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('IMPORTED_PATH_LINK')
    expect(h.apiFetch).toHaveBeenCalledTimes(callsAfterMount)
    expect(posted).toEqual([])
  })

  it('S-12: ignores an import whose FileReader finishes after a later local edit', async () => {
    type PendingReader = {
      result: string | ArrayBuffer | null
      onload: ((event: ProgressEvent<FileReader>) => void) | null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null
    }
    const pending: PendingReader[] = []
    class DelayedFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null

      readAsText(_file: Blob): void {
        pending.push(this)
      }
    }
    vi.stubGlobal('FileReader', DelayedFileReader)
    try {
      const root = await mountPanel()
      const incoming = createSyntheticSourcePlanDraft()
      incoming.roles.pathExAttr.object = 'LATE_IMPORTED_PATH_LINK'
      const incomingJson = JSON.stringify(compileSourcePlanDraft(incoming).envelope)
      chooseDraftFile(root, incomingJson)
      expect(pending).toHaveLength(1)

      // This is a later local intent, so the old async file result cannot replace it.
      ;(node(root, 'stock-prep-source-plan-draft-synthetic') as HTMLButtonElement).click()
      pending[0].result = incomingJson
      pending[0].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
      await flush(2)
      expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('SYN_pathExAttr')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('S-13: a completed import invalidates an interim preview, while a stale result cannot clear a newer preview', async () => {
    type PendingReader = {
      result: string | ArrayBuffer | null
      onload: ((event: ProgressEvent<FileReader>) => void) | null
    }
    const pending: PendingReader[] = []
    class DelayedFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null

      readAsText(_file: Blob): void {
        pending.push(this)
      }
    }
    vi.stubGlobal('FileReader', DelayedFileReader)
    try {
      const root = await mountPanel()
      ;(node(root, 'stock-prep-source-plan-draft-synthetic') as HTMLButtonElement).click()
      const imported = createSyntheticSourcePlanDraft()
      imported.roles.pathExAttr.object = 'IMPORTED_PATH_LINK'
      const importedJson = JSON.stringify(compileSourcePlanDraft(imported).envelope)

      // Starting an import clears the old preview, but the user can still explicitly preview the
      // old form while readAsText is pending. Completion must clear that interim candidate again.
      chooseDraftFile(root, importedJson)
      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(node(root, 'stock-prep-source-plan-draft-json')).not.toBeNull()
      pending[0].result = importedJson
      pending[0].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
      await flush(2)
      expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('IMPORTED_PATH_LINK')
      expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
      expect(node(root, 'stock-prep-source-plan-draft-download')).toBeNull()

      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(text(root, 'stock-prep-source-plan-draft-json')).toContain('IMPORTED_PATH_LINK')

      // A failed import also invalidates an interim preview but preserves the last editable form.
      chooseDraftFile(root, '{ private_json_marker')
      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(node(root, 'stock-prep-source-plan-draft-json')).not.toBeNull()
      pending[1].result = '{ private_json_marker'
      pending[1].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
      await flush(2)
      expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('IMPORTED_PATH_LINK')
      expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
      expect(node(root, 'stock-prep-source-plan-draft-download')).toBeNull()

      // After another import begins, a real edit advances the generation. Its own new preview is
      // authoritative, so a late reader cannot clear it or replace the edited draft.
      chooseDraftFile(root, importedJson)
      const objectInput = node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement
      objectInput.value = 'NEWER_LOCAL_PATH'
      objectInput.dispatchEvent(new Event('input'))
      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(text(root, 'stock-prep-source-plan-draft-json')).toContain('NEWER_LOCAL_PATH')
      pending[2].result = importedJson
      pending[2].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
      await flush(2)
      expect((node(root, 'stock-prep-source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('NEWER_LOCAL_PATH')
      expect(text(root, 'stock-prep-source-plan-draft-json')).toContain('NEWER_LOCAL_PATH')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(['tenantId', 'workspaceId'] as const)('S-14: changing %s clears private drafts and old binding confirmation on the same mount', async (key) => {
    const scope = reactive({ ...SCOPE })
    const root = await mountPanel(scope)
    await fillPrivateDraft(root)
    await requestBindingConfirmation(root)
    const oldConfirm = node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement
    scope[key] = 'synthetic-other-scope'
    // Even an already-delivered click cannot submit the old pending choice into the new scope.
    oldConfirm.click()
    await flush()
    expectCleared(root)
    expect(posted).toEqual([])
  })

  it('S-15: account switch and permission loss/restoration clear state and recompute the actual access snapshot', async () => {
    const root = await mountPanel()
    await fillPrivateDraft(root)
    await requestBindingConfirmation(root)
    switchAccount()
    await flush()
    expectCleared(root)
    await fillPrivateDraft(root, 'SYN_PRIVATE_LAYOUT_B')
    h.permissions = ['stock-prep:admin']
    notifyAuthPrincipalChange()
    await flush()
    expect(node(root, 'stock-prep-source-readonly')).not.toBeNull()
    expect(node(root, 'stock-prep-source-select')).toBeNull()
    expect(node(root, 'stock-prep-source-plan-draft')).toBeNull()
    expect(root.textContent).not.toContain('SYN_PRIVATE_LAYOUT_B')
    h.permissions = ['integration:admin']
    notifyAuthPrincipalChange()
    await flush()
    expect(node(root, 'stock-prep-source-readonly')).toBeNull()
    expectCleared(root)
    expect(posted).toEqual([])
  })

  it.each(['storage', 'focus'])('S-16: %s detects permission and session changes made outside this tab', async (event) => {
    const root = await mountPanel()
    await fillPrivateDraft(root)
    h.permissions = []
    localStorage.setItem('user_permissions', '[]')
    window.dispatchEvent(new Event(event))
    await flush()
    expect(node(root, 'stock-prep-source-readonly')).not.toBeNull()
    expect(node(root, 'stock-prep-source-current')).toBeNull()
    h.permissions = ['integration:admin']
    localStorage.setItem('user_permissions', '["integration:admin"]')
    window.dispatchEvent(new Event(event))
    await flush()
    expectCleared(root)
  })

  it.each(['scope', 'account', 'silent-token'] as const)('S-17: a late FileReader cannot restore the old %s draft', async (change) => {
    const readers: Array<{ result: string | null; onload: (() => void) | null }> = []
    class DelayedReader {
      result: string | null = null
      onload: (() => void) | null = null
      readAsText(): void { readers.push(this) }
    }
    vi.stubGlobal('FileReader', DelayedReader)
    try {
      const scope = reactive({ ...SCOPE })
      const root = await mountPanel(scope)
      const incoming = createSyntheticSourcePlanDraft()
      incoming.roles.pathExAttr.object = 'SYN_LATE_PREVIOUS_SESSION'
      const incomingJson = JSON.stringify(compileSourcePlanDraft(incoming).envelope)
      chooseDraftFile(root, incomingJson)
      expect(readers).toHaveLength(1)
      if (change === 'scope') scope.workspaceId = 'synthetic-next-workspace'
      else if (change === 'account') switchAccount()
      else localStorage.setItem('auth_token', 'synthetic-silent-next-token')
      await flush(2)
      readers[0].result = incomingJson
      readers[0].onload?.()
      await flush()
      expectCleared(root)
      expect(root.textContent).not.toContain('SYN_LATE_PREVIOUS_SESSION')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(['success', 'failure'] as const)('S-18: a late GET %s is discarded after scope change while its real pending state is retained', async (outcome) => {
    const response = deferredResponse()
    installRoutes({ get: () => response.promise })
    const scope = reactive({ ...SCOPE })
    const root = await mountPanel(scope)
    scope.tenantId = 'synthetic-next-tenant'
    await flush(2)
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(true)
    response.resolve(outcome === 'success' ? envelope(bindingPayload()) : refusal(403, 'DENIED'))
    await flush()
    expectCleared(root)
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(false)
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'] as const)('S-19: a late POST %s never continues with a GET or updates the next session', async (outcome) => {
    const response = deferredResponse()
    installRoutes({ post: () => response.promise })
    const scope = reactive({ ...SCOPE })
    const root = await mountPanel(scope)
    await requestBindingConfirmation(root)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush(2)
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toContain('workspaceId=workspace-default')
    scope.workspaceId = 'synthetic-next-workspace'
    switchAccount()
    await flush(2)
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(true)
    response.resolve(outcome === 'success' ? envelope({ changed: true }) : refusal(403, 'DENIED'))
    await flush()
    expectCleared(root)
    expect(h.apiFetch).toHaveBeenCalledTimes(2)
    expect(getCount).toBe(1)
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(false)
  })

  it('S-20: post-save readback keeps its captured scope and cannot publish across a later account switch', async () => {
    const readback = deferredResponse()
    installRoutes({ get: () => getCount === 1 ? envelope(bindingPayload()) : readback.promise })
    const scope = reactive({ ...SCOPE })
    const root = await mountPanel(scope)
    await requestBindingConfirmation(root)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush(2)
    expect(getCount).toBe(2)
    expect(String(h.apiFetch.mock.calls[2][0])).toContain('workspaceId=workspace-default')
    scope.workspaceId = 'synthetic-next-workspace'
    switchAccount()
    await flush(2)
    readback.resolve(envelope(bindingPayload({ effectiveExternalSystemId: CUSTOMER_PLM })))
    await flush()
    expectCleared(root)
    expect(h.apiFetch).toHaveBeenCalledTimes(3)
  })

  it('S-21: the next user starts empty and can reuse only an explicitly imported downloaded draft', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-review')
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = vi.fn()
    })
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    try {
      const root = await mountPanel()
      await fillPrivateDraft(root)
      ;(node(root, 'stock-prep-source-plan-draft-download') as HTMLButtonElement).click()
      const downloaded = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(createObjectURL.mock.calls[0][0])
      })
      switchAccount()
      await flush()
      expectCleared(root)
      const calls = h.apiFetch.mock.calls.length
      chooseDraftFile(root, downloaded)
      await flush()
      expect(node(root, 'stock-prep-source-plan-draft-json')).toBeNull()
      ;(node(root, 'stock-prep-source-plan-draft-preview') as HTMLButtonElement).click()
      await flush(2)
      expect(JSON.parse(text(root, 'stock-prep-source-plan-draft-json'))).toEqual(JSON.parse(downloaded))
      expect(h.apiFetch).toHaveBeenCalledTimes(calls)
      expect(posted).toEqual([])
    } finally {
      anchor.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('S-22: direct handlers cannot send with lost permission, absent choice, old confirmation or after unmount', async () => {
    const scope = reactive({ ...SCOPE })
    const root = await mountPanel(scope)
    const internal = app!._instance as unknown as {
      setupState: { askToSave: () => void; save: () => Promise<void> }
      exposed: { load: () => Promise<void> }
    }
    const select = node(root, 'stock-prep-source-select') as HTMLSelectElement
    select.value = ''
    select.dispatchEvent(new Event('change'))
    internal.setupState.askToSave()
    await internal.setupState.save()
    expect(posted).toEqual([])
    await requestBindingConfirmation(root)
    scope.workspaceId = 'synthetic-new-workspace'
    await internal.setupState.save()
    expect(posted).toEqual([])
    h.permissions = []
    notifyAuthPrincipalChange()
    await flush()
    const calls = h.apiFetch.mock.calls.length
    internal.setupState.askToSave()
    await internal.setupState.save()
    await internal.exposed.load()
    expect(h.apiFetch).toHaveBeenCalledTimes(calls)
    app!.unmount()
    app = null
    h.permissions = ['integration:admin']
    notifyAuthPrincipalChange()
    await internal.exposed.load()
    internal.setupState.askToSave()
    await internal.setupState.save()
    expect(h.apiFetch).toHaveBeenCalledTimes(calls)
  })

  it('S-23: only explicit refresh loads sources for the new scope, then a fresh choice can be saved', async () => {
    installRoutes({
      get: () => envelope(getCount < 3 ? bindingPayload() : confirmedCustomerPayload({
        persistedBinding: persistedCustomerBinding({ workspaceId: 'synthetic-new-workspace' }),
      })),
    })
    const scope = reactive({ ...SCOPE })
    const root = await mountPanel(scope)
    await requestBindingConfirmation(root)
    scope.workspaceId = 'synthetic-new-workspace'
    switchAccount()
    await flush()
    expectCleared(root)
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
    ;(node(root, 'stock-prep-source-refresh') as HTMLButtonElement).click()
    await flush()
    expect(getCount).toBe(2)
    expect(String(h.apiFetch.mock.calls[1][0])).toContain('workspaceId=synthetic-new-workspace')
    expect(node(root, 'stock-prep-source-current')).not.toBeNull()
    expect(node(root, 'stock-prep-source-confirm')).toBeNull()
    await requestBindingConfirmation(root)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush()
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toContain('workspaceId=synthetic-new-workspace')
    expect(node(root, 'stock-prep-source-saved')).not.toBeNull()
    expect(text(root, 'stock-prep-source-saved')).toContain('不用重启')
    expect(node(root, 'stock-prep-source-unconfirmed')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // S-24..S-27 — a save is "already live / no restart" only after THIS
  // session's readback confirms that exact source. The confirmation note
  // uses the same server flag as the status line.
  // -------------------------------------------------------------------------

  it('S-24: withholds the effective claim until the same-scope readback confirms it', async () => {
    const readback = deferredResponse()
    installRoutes({ get: () => (getCount === 1 ? envelope(bindingPayload()) : readback.promise) })
    const root = await mountPanel()
    await requestBindingConfirmation(root)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush(2)

    expect(posted).toHaveLength(1)
    expect(posted[0].body).toEqual({ externalSystemId: CUSTOMER_PLM })
    expect(posted[0].url).toContain('tenantId=tenant-a')
    expect(posted[0].url).toContain('workspaceId=workspace-default')
    expect(getCount).toBe(2)
    expect(String(h.apiFetch.mock.calls[2][0])).toContain('tenantId=tenant-a')
    expect(String(h.apiFetch.mock.calls[2][0])).toContain('workspaceId=workspace-default')
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(true)
    expect((node(root, 'stock-prep-source-refresh') as HTMLButtonElement).disabled).toBe(true)
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(node(root, 'stock-prep-source-unconfirmed')).toBeNull()
    expect(root.textContent).not.toContain('不用重启')
    expect(root.textContent).not.toContain('已经生效')

    // A successful POST has invalidated the old observation, even while its readback is pending.
    expect(node(root, 'stock-prep-source-current')).toBeNull()
    expect(onBindingRead).toHaveBeenLastCalledWith(null)

    readback.resolve(envelope(confirmedCustomerPayload()))
    await flush()

    expect(text(root, 'stock-prep-source-saved')).toContain('已保存,并且已经生效')
    expect(text(root, 'stock-prep-source-saved')).toContain('不用重启')
    expect(node(root, 'stock-prep-source-unconfirmed')).toBeNull()
    expect(node(root, 'stock-prep-source-error')).toBeNull()
    expect(text(root, 'stock-prep-source-current-name')).toContain('客户 PLM 只读库')
    expect(text(root, 'stock-prep-source-current-id')).toContain(CUSTOMER_PLM)
    expect(node(root, 'stock-prep-source-no-restart')).not.toBeNull()
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(false)
    expect(posted).toHaveLength(1)
    expect(getCount).toBe(2)
  })

  it.each([
    ['a different source', { effectiveExternalSystemId: DEMO_SOURCE }],
    ['an unreadable source', {
      effectiveExternalSystemId: CUSTOMER_PLM,
      effectiveSourceProblem: 'not_active',
      takesEffectWithoutRestart: false,
    }],
    ['no no-restart capability', { effectiveExternalSystemId: CUSTOMER_PLM, takesEffectWithoutRestart: false }],
    ['a non-boolean capability', { effectiveExternalSystemId: CUSTOMER_PLM, takesEffectWithoutRestart: 'true' }],
    ['an object problem', { effectiveExternalSystemId: CUSTOMER_PLM, effectiveSourceProblem: { code: 'not_active' } }],
    ['a boolean problem', { effectiveExternalSystemId: CUSTOMER_PLM, effectiveSourceProblem: true }],
  ] as const)('S-25: readback with %s does not claim the save is effective and does not write again', async (label, overrides) => {
    installRoutes({ afterSave: confirmedCustomerPayload(overrides) })
    const root = await mountPanel()
    await confirmSave(root)

    expect(posted).toHaveLength(1)
    expect(posted[0].body).toEqual({ externalSystemId: CUSTOMER_PLM })
    expect(getCount).toBe(2)
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(root.textContent).not.toContain('不用重启')
    expect(root.textContent).not.toContain('已经生效')
    expect(text(root, 'stock-prep-source-unconfirmed')).toContain('保存请求已经提交')
    expect(text(root, 'stock-prep-source-unconfirmed')).toContain('不会自动再次保存')
    expect(node(root, 'stock-prep-source-error')).toBeNull()
    expect(root.textContent).not.toContain('读取或保存失败')
    expect(root.textContent).not.toContain(PLANTED_DSN)
    if (label === 'a different source') {
      expect(text(root, 'stock-prep-source-current-name')).toContain('内置演示源')
    } else {
      expect(text(root, 'stock-prep-source-current-name')).toContain('客户 PLM 只读库')
    }
    if (label === 'an unreadable source') {
      expect(text(root, 'stock-prep-source-problem')).toContain('还没有启用')
      expect(node(root, 'stock-prep-source-no-restart')).toBeNull()
    }
    if (('takesEffectWithoutRestart' in overrides && overrides.takesEffectWithoutRestart === false) || label === 'a non-boolean capability') {
      expect(root.textContent).not.toContain('不需要重启')
    }
    await flush()
    expect(posted).toHaveLength(1)
    expect(h.apiFetch).toHaveBeenCalledTimes(3)
  })

  it('S-26: a failed readback after a successful save shows a fixed unconfirmed line and does not retry', async () => {
    installRoutes({
      get: () => (getCount === 1 ? envelope(bindingPayload()) : refusal(500, 'INTERNAL_ERROR')),
    })
    const root = await mountPanel()
    await confirmSave(root)

    expect(posted).toHaveLength(1)
    expect(posted[0].body).toEqual({ externalSystemId: CUSTOMER_PLM })
    expect(getCount).toBe(2)
    expect(h.apiFetch).toHaveBeenCalledTimes(3)
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(node(root, 'stock-prep-source-error')).toBeNull()
    expect(root.textContent).not.toContain('读取或保存失败')
    expect(root.textContent).not.toContain('不用重启')
    expect(root.textContent).not.toContain('已经生效')
    expect(text(root, 'stock-prep-source-unconfirmed')).toContain('保存请求已经提交')
    expect(text(root, 'stock-prep-source-unconfirmed')).not.toContain(PLANTED_DSN)
    expect(root.textContent).not.toContain(PLANTED_DSN)
    expect(root.textContent).not.toContain('refused for')
    expect(node(root, 'stock-prep-source-current')).toBeNull()
    expect(onBindingRead).toHaveBeenLastCalledWith(null)
    expect((node(root, 'stock-prep-source-select') as HTMLSelectElement).disabled).toBe(false)
    await flush()
    expect(posted).toHaveLength(1)
    expect(getCount).toBe(2)
  })

  it('S-27: a refused save stays a refusal and does not show the unconfirmed readback line', async () => {
    installRoutes({ post: () => refusal(422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'not_active') })
    const root = await mountPanel()
    await confirmSave(root)

    expect(getCount).toBe(1)
    expect(posted).toHaveLength(1)
    expect(text(root, 'stock-prep-source-error')).toContain('还没有启用')
    expect(text(root, 'stock-prep-source-error')).toContain('HTTP 422')
    expect(node(root, 'stock-prep-source-unconfirmed')).toBeNull()
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(root.textContent).not.toContain('保存请求已经提交')
    expect(root.textContent).not.toContain(PLANTED_DSN)
    expect(root.textContent).not.toContain('refused for')
  })

  it('S-29: an explicit refresh failure withdraws the previous observation, not the local draft', async () => {
    installRoutes({ get: () => getCount === 1 ? envelope(bindingPayload()) : refusal(500, 'INTERNAL_ERROR') })
    const root = await mountPanel()
    await fillPrivateDraft(root)
    expect(onBindingRead.mock.lastCall?.[0]?.effectiveExternalSystemId).toBe(DEMO_SOURCE)
    ;(node(root, 'stock-prep-source-refresh') as HTMLButtonElement).click()
    await flush()
    expect(node(root, 'stock-prep-source-current')).toBeNull()
    expect(node(root, 'stock-prep-source-no-restart')).toBeNull()
    expect(node(root, 'stock-prep-source-saved')).toBeNull()
    expect(onBindingRead).toHaveBeenLastCalledWith(null)
    expect(text(root, 'stock-prep-source-plan-draft-json')).toContain('SYN_PRIVATE_LAYOUT_A')
    expect(text(root, 'stock-prep-source-error')).toContain('500')
    expect(getCount).toBe(2)
    expect(posted).toHaveLength(0)
  })

  it('S-30: a transport-ambiguous save withdraws the old binding and never retries automatically', async () => {
    installRoutes({ post: () => Promise.reject(new TypeError('synthetic connection lost')) })
    const root = await mountPanel()
    await fillPrivateDraft(root)
    await confirmSave(root)
    expect(node(root, 'stock-prep-source-current')).toBeNull()
    expect(onBindingRead).toHaveBeenLastCalledWith(null)
    expect(text(root, 'stock-prep-source-plan-draft-json')).toContain('SYN_PRIVATE_LAYOUT_A')
    expect(root.textContent).not.toContain('synthetic connection lost')
    expect(posted).toHaveLength(1)
    expect(getCount).toBe(1)
  })

  it('S-28: the confirmation note promises no restart only when the server says so', async () => {
    installRoutes({ get: () => envelope(bindingPayload({ takesEffectWithoutRestart: false })) })
    const quiet = await mountPanel()
    await requestBindingConfirmation(quiet)
    expect(node(quiet, 'stock-prep-source-no-restart')).toBeNull()
    expect(text(quiet, 'stock-prep-source-confirm')).not.toContain('不需要重启')
    expect(text(quiet, 'stock-prep-source-confirm')).not.toContain('立即生效')
    expect(text(quiet, 'stock-prep-source-confirm')).toContain('客户 PLM 只读库')

    if (app) app.unmount()
    installRoutes()
    const allowed = await mountPanel()
    await requestBindingConfirmation(allowed)
    expect(text(allowed, 'stock-prep-source-confirm')).toContain('不需要重启')
    expect(text(allowed, 'stock-prep-source-confirm')).toContain('立即生效')
    expect(text(allowed, 'stock-prep-source-no-restart')).toContain('不需要重启')
  })
})

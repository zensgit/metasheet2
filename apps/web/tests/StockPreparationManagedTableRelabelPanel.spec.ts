import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 「把系统表的英文表头改成中文」 — the DOM half (客户反馈 2026-09-24 #4a).
//
// The suite drives the real panel over a mocked `apiFetch`, so the real service
// (managedTableRelabel.ts) runs underneath it.
//
//   RL-01 R-11: the panel renders for stock-prep:admin and for a platform admin — the route's own
//         gate — and renders NOTHING (and calls nothing) for the read / operator / integration:write
//         tiers or a bare user; RL-01b the parent's card class falls through onto its single root
//   RL-02 preview is a DRY RUN: it POSTs `{}` with NO query string, renders the plan's English →
//         Chinese rows, and says nothing has been changed yet
//   RL-03 PREVIEW → CONFIRM → APPLY: 「确认改成中文」 appears only under a dry-run plan with pending
//         renames AND the server switch on, and sends exactly `{ apply: true, planDigest }` of THAT
//         preview; the applied summary replaces the confirm bar and states revertibility exactly
//         (column renames revertible from the config history, table renames not)
//   RL-04 nothing to do → no confirm control; cancel discards a plan without applying
//   RL-05 a refusal renders plain words plus the error CODE — never the server message
//   RL-06 zh and en copy both exist (the same panel under each locale)
//   RL-07 absent / unregistered tables render their plain-language status instead of rows, and
//         "absent" no longer claims there is nothing to do
//   RL-08 SWITCH OFF: the preview renders, no confirm button, and the operator switch is named
//   RL-09 an APPLY failure drops the stale plan — the only way on is a fresh preview (N5)
//   RL-10 a SHEET-name clash reads differently from a COLUMN-name clash (N4)
//   RL-11 the out-of-scope tables and the sandbox coverage are named on the page (S4)

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

import StockPreparationManagedTableRelabelPanel from '../src/components/integration/stockPreparation/StockPreparationManagedTableRelabelPanel.vue'
import { STOCK_PREPARATION_MANAGED_TABLE_RELABEL_ROUTE } from '../src/services/integration/stockPreparation/managedTableRelabel'

const SERVER_MESSAGE = 'refused for tenant_secret:integration-core'
const DIGEST = `sha256:${'d'.repeat(64)}`
const ENABLE_WITH = 'MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED'

function counts(overrides: Record<string, number> = {}): Record<string, number> {
  return { renamed: 0, would_rename: 0, already_target: 0, skipped_name_changed: 0, skipped_name_taken: 0, missing: 0, ...overrides }
}

function planPayload(mode: 'dry_run' | 'apply', options: { pending?: boolean; applyEnabled?: boolean; sheetTaken?: boolean } = {}): Record<string, unknown> {
  const pending = options.pending !== false
  const live = mode === 'apply' ? 'renamed' : (pending ? 'would_rename' : 'already_target')
  const ledgerFields = [
    { fieldId: 'decisionId', from: 'Decision ID', to: '裁决ID', status: live },
    { fieldId: 'status', from: 'Status', to: '状态', status: pending ? 'skipped_name_changed' : 'already_target' },
    { fieldId: 'notes', from: 'Notes', to: '备注', status: pending ? 'skipped_name_taken' : 'already_target' },
    { fieldId: 'conflictType', from: 'Conflict Type', to: '冲突类型', status: 'already_target' },
  ]
  const totalsKey = mode === 'apply' ? 'renamed' : 'would_rename'
  return {
    mode,
    locale: 'zh-CN',
    applyEnabled: options.applyEnabled !== false,
    enableWith: ENABLE_WITH,
    planDigest: DIGEST,
    tables: [
      { kind: 'main', objectId: 'plm_stock_preparation_main', status: 'absent', sheetName: null, fields: [], counts: counts(), revisionCount: 0 },
      {
        kind: 'ledger',
        objectId: 'plm_stock_preparation_confirmation_decision',
        status: 'present',
        sheetName: { from: 'Stock Preparation Confirmation Decision', to: '备料确认账本', status: options.sheetTaken ? 'skipped_name_taken' : live },
        fields: ledgerFields,
        counts: counts(),
        revisionCount: mode === 'apply' ? 2 : 0,
      },
      { kind: 'sandbox', objectIdHash: 'abc123', status: 'scope_unavailable', sheetName: null, fields: [], counts: counts(), revisionCount: 0 },
    ],
    totals: counts(pending ? { [totalsKey]: 2, skipped_name_changed: 1, skipped_name_taken: 1, already_target: 1 } : { already_target: 5 }),
    revisionCount: mode === 'apply' ? 2 : 0,
    hasPendingRenames: mode === 'dry_run' && pending,
    outOfScope: [
      { objectId: 'plm_stock_preparation_bom_snapshot_batch', label: 'PLM BOM Snapshot Batch' },
      { objectId: 'plm_stock_preparation_bom_snapshot_line', label: 'PLM BOM Snapshot Line' },
    ],
  }
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: SERVER_MESSAGE } }), { status })
}

let calls: Array<{ url: string; method: string | undefined; body: unknown }> = []

function installRoutes(behaviour: { preview?: () => Response; apply?: () => Response } = {}): void {
  calls = []
  h.apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, method: init?.method, body })
    if (body && body.apply === true) return behaviour.apply ? behaviour.apply() : envelope(planPayload('apply'))
    return behaviour.preview ? behaviour.preview() : envelope(planPayload('dry_run'))
  })
}

async function flush(cycles = 8): Promise<void> {
  for (let turn = 0; turn < cycles; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

describe('「把系统表的英文表头改成中文」 panel', () => {
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

  async function mountPanel(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationManagedTableRelabelPanel as Component)
    app.mount(container!)
    await flush()
    return container!
  }

  function node(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  }

  async function click(root: HTMLElement, testid: string): Promise<void> {
    const target = node(root, testid)
    expect(target, `${testid} is rendered`).not.toBeNull()
    ;(target as HTMLButtonElement).click()
    await flush()
  }

  it('RL-01 renders for stock-prep:admin and platform admin; nothing for any lower tier', async () => {
    for (const permissions of [['stock-prep:admin'], ['integration:admin']]) {
      h.permissions = permissions
      const root = await mountPanel()
      expect(node(root, 'stock-prep-relabel'), `${permissions.join(',')} sees the panel`).not.toBeNull()
      app!.unmount()
      app = null
    }
    for (const permissions of [['stock-prep:read'], ['stock-prep:read', 'stock-prep:operate'], ['integration:write'], []]) {
      h.permissions = permissions
      const root = await mountPanel()
      expect(node(root, 'stock-prep-relabel'), `${permissions.join(',') || 'bare'} sees nothing`).toBeNull()
      expect(root.innerHTML.trim()).toBe('<!--v-if-->')
      app!.unmount()
      app = null
    }
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it('RL-01b the parent card class falls through onto the single root (the install view relies on it)', async () => {
    app = createApp(StockPreparationManagedTableRelabelPanel as Component, { class: 'stock-prep-install__card' })
    app.mount(container!)
    await flush()
    const panel = node(container!, 'stock-prep-relabel')!
    expect(panel.classList.contains('stock-prep-install__card')).toBe(true)
    expect(panel.classList.contains('stock-prep-relabel')).toBe(true)
  })

  it('RL-02 preview is a dry run: POST {} with no query string, plan rows rendered, nothing applied', async () => {
    const root = await mountPanel()
    expect(h.apiFetch).not.toHaveBeenCalled()
    await click(root, 'stock-prep-relabel-preview')
    expect(calls).toEqual([{ url: STOCK_PREPARATION_MANAGED_TABLE_RELABEL_ROUTE, method: 'POST', body: {} }])
    expect(calls[0].url.includes('?')).toBe(false)
    const summary = node(root, 'stock-prep-relabel-summary')!
    expect(summary.dataset.mode).toBe('dry_run')
    expect(summary.textContent).toContain('还没有改动任何东西')
    const rows = [...root.querySelectorAll('[data-testid="stock-prep-relabel-row"]')].map((row) => row.textContent ?? '')
    expect(rows.some((row) => row.includes('Decision ID') && row.includes('裁决ID') && row.includes('将改成中文'))).toBe(true)
    expect(rows.some((row) => row.includes('Stock Preparation Confirmation Decision') && row.includes('备料确认账本'))).toBe(true)
    expect(rows.some((row) => row.includes('Status') && row.includes('已被人改过名'))).toBe(true)
    expect(rows.some((row) => row.includes('Notes') && row.includes('同表已有同名列'))).toBe(true)
    // An already-Chinese column is summarised, not listed.
    expect(rows.some((row) => row.includes('Conflict Type'))).toBe(false)
    expect(node(root, 'stock-prep-relabel-already')!.textContent).toContain('1')
    expect(node(root, 'stock-prep-relabel-confirm-bar')).not.toBeNull()
    expect(node(root, 'stock-prep-relabel-apply-disabled')).toBeNull()
  })

  it('RL-03 preview → confirm → apply sends exactly {apply:true, planDigest} of that preview and states revertibility exactly', async () => {
    const root = await mountPanel()
    await click(root, 'stock-prep-relabel-preview')
    await click(root, 'stock-prep-relabel-apply')
    expect(calls.map((call) => call.body)).toEqual([{}, { apply: true, planDigest: DIGEST }])
    expect(calls.every((call) => call.url === STOCK_PREPARATION_MANAGED_TABLE_RELABEL_ROUTE && call.method === 'POST')).toBe(true)
    const summary = node(root, 'stock-prep-relabel-summary')!
    expect(summary.dataset.mode).toBe('apply')
    expect(summary.textContent).toContain('已改好 2 处')
    expect(summary.textContent).toContain('列名改动可以在那里撤回')
    expect(summary.textContent).toContain('表名改动会记录,但不能从那里撤回')
    expect(node(root, 'stock-prep-relabel-confirm-bar')).toBeNull()
    expect(node(root, 'stock-prep-relabel-apply')).toBeNull()
  })

  it('RL-04 nothing to do → no confirm control; cancel discards the plan without applying', async () => {
    installRoutes({ preview: () => envelope(planPayload('dry_run', { pending: false })) })
    const quiet = await mountPanel()
    await click(quiet, 'stock-prep-relabel-preview')
    expect(node(quiet, 'stock-prep-relabel-summary')!.textContent).toContain('没有需要改的表头')
    expect(node(quiet, 'stock-prep-relabel-apply')).toBeNull()
    app!.unmount()
    app = null

    installRoutes()
    const root = await mountPanel()
    await click(root, 'stock-prep-relabel-preview')
    await click(root, 'stock-prep-relabel-cancel')
    expect(node(root, 'stock-prep-relabel-summary')).toBeNull()
    expect(calls.map((call) => call.body)).toEqual([{}])
  })

  it('RL-05 a refusal renders plain words and the code, never the server message', async () => {
    installRoutes({ preview: () => refusal(403, 'TENANT_CLAIM_REQUIRED') })
    const root = await mountPanel()
    await click(root, 'stock-prep-relabel-preview')
    const error = node(root, 'stock-prep-relabel-error')!
    expect(error.textContent).toContain('重新登录')
    expect(error.textContent).toContain('TENANT_CLAIM_REQUIRED')
    expect(root.innerHTML).not.toContain(SERVER_MESSAGE)
    expect(root.innerHTML).not.toContain('tenant_secret')
    expect(node(root, 'stock-prep-relabel-apply')).toBeNull()
  })

  it('RL-06 the same panel speaks English under the en locale', async () => {
    h.locale = 'en'
    const root = await mountPanel()
    expect(root.textContent).toContain("Rename the system tables' English headers to Chinese")
    await click(root, 'stock-prep-relabel-preview')
    expect(node(root, 'stock-prep-relabel-summary')!.textContent).toContain('Nothing has been changed yet')
    expect(node(root, 'stock-prep-relabel-apply')!.textContent).toContain('Confirm — rename to Chinese')
    expect(root.textContent).not.toContain('将改成中文')
  })

  it('RL-07 absent and unregistered tables say so in words instead of listing rows — and "absent" does not claim nothing is needed', async () => {
    const root = await mountPanel()
    await click(root, 'stock-prep-relabel-preview')
    const main = root.querySelector('[data-testid="stock-prep-relabel-table"][data-kind="main"]') as HTMLElement
    expect(main.dataset.status).toBe('absent')
    expect(main.textContent).toContain('当前登录的租户下没有找到这张表')
    expect(main.textContent).not.toContain('无需处理')
    const sandbox = root.querySelector('[data-testid="stock-prep-relabel-table"][data-kind="sandbox"]') as HTMLElement
    expect(sandbox.dataset.status).toBe('scope_unavailable')
    expect(sandbox.textContent).toContain('为安全起见不动它')
    expect(sandbox.querySelector('[data-testid="stock-prep-relabel-row"]')).toBeNull()
  })

  it('RL-08 SWITCH OFF: the preview renders, no confirm button is offered, and the operator switch is named', async () => {
    installRoutes({ preview: () => envelope(planPayload('dry_run', { applyEnabled: false })) })
    const root = await mountPanel()
    expect(node(root, 'stock-prep-relabel-switch-note')!.textContent).toContain('运维')
    await click(root, 'stock-prep-relabel-preview')
    expect(node(root, 'stock-prep-relabel-summary')!.textContent).toContain('还没有改动任何东西')
    expect(node(root, 'stock-prep-relabel-apply')).toBeNull()
    expect(node(root, 'stock-prep-relabel-confirm-bar')).toBeNull()
    const disabled = node(root, 'stock-prep-relabel-apply-disabled')!
    expect(disabled.textContent).toContain('改名开关还没有打开')
    expect(node(root, 'stock-prep-relabel-enable-with')!.textContent).toBe(`${ENABLE_WITH}=true`)
    expect(calls.map((call) => call.body)).toEqual([{}])
  })

  it('RL-09 an APPLY failure drops the stale plan — only a fresh preview can lead to another apply', async () => {
    for (const [status, code, words] of [
      [409, 'MANAGED_TABLE_RELABEL_PLAN_CHANGED', '请重新预览'],
      [409, 'MANAGED_TABLE_RELABEL_APPLY_DISABLED', '改名开关没有打开'],
      [409, 'RECOVERY_IN_PROGRESS', '正被其他操作占用'],
      [500, 'INTERNAL_ERROR', '不会被重复改动'],
    ] as const) {
      installRoutes({ apply: () => refusal(status, code) })
      const root = await mountPanel()
      await click(root, 'stock-prep-relabel-preview')
      await click(root, 'stock-prep-relabel-apply')
      expect(node(root, 'stock-prep-relabel-error')!.textContent, code).toContain(words)
      expect(node(root, 'stock-prep-relabel-error')!.textContent).toContain(code)
      expect(node(root, 'stock-prep-relabel-summary'), `${code}: the stale plan is gone`).toBeNull()
      expect(node(root, 'stock-prep-relabel-apply'), `${code}: no confirm without a fresh preview`).toBeNull()
      expect(root.innerHTML).not.toContain(SERVER_MESSAGE)
      app!.unmount()
      app = null
    }
  })

  it('RL-10 a SHEET-name clash reads differently from a COLUMN-name clash', async () => {
    installRoutes({ preview: () => envelope(planPayload('dry_run', { sheetTaken: true })) })
    const root = await mountPanel()
    await click(root, 'stock-prep-relabel-preview')
    const sheetRow = root.querySelector('[data-testid="stock-prep-relabel-row"][data-entity="sheet"]') as HTMLElement
    const columnRow = [...root.querySelectorAll('[data-testid="stock-prep-relabel-row"][data-entity="field"]')]
      .find((row) => row.getAttribute('data-status') === 'skipped_name_taken') as HTMLElement
    expect(sheetRow.dataset.status).toBe('skipped_name_taken')
    expect(sheetRow.textContent).toContain('同名的表')
    expect(columnRow.textContent).toContain('同名列')
    expect(sheetRow.textContent).not.toContain('同名列')
  })

  it('RL-11 the out-of-scope tables and the sandbox coverage are named on the page', async () => {
    const root = await mountPanel()
    await click(root, 'stock-prep-relabel-preview')
    const scope = node(root, 'stock-prep-relabel-out-of-scope')!
    expect(scope.textContent).toContain('还没有约定的中文名')
    const labels = [...root.querySelectorAll('[data-testid="stock-prep-relabel-out-of-scope-row"]')].map((row) => row.textContent)
    expect(labels).toEqual(['PLM BOM Snapshot Batch', 'PLM BOM Snapshot Line'])
    expect(node(root, 'stock-prep-relabel-sandbox-coverage')!.textContent).toContain('沙箱写入白名单')
  })
})

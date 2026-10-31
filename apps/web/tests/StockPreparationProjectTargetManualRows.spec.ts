import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as vnode, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 人工补充行 B4 — the project sync panel's manual-rows section (ADR adr-stock-prep-manual-rows-20261030 §4 / §5.3 /
// §8 「B4」; OQ4, OQ6; register R-68).
//
//   MR-CLIENT the two routes: GET with the scope query; POST with EXACTLY `{ confirmProjectNo, policy }` and no
//             query; strict clamps (a malformed answer is refused, never guessed; an unavailable reminder keeps null
//             counts; the id lists are capped)
//   MR-FLOW   a typed number that does not match sends NOTHING; no ADMIN tier sends nothing; a match calls the route
//             with the trimmed numbers; the switch-off 404 is `disabled`, any other refusal keeps its status + code
//   MR-PANEL  the section, for an ADMIN: the switch line (allowed by default / set / off), what turning it off means,
//             the lock-missing / key-missing / archived notes, the typed-confirmation switch and its read-back, the
//             reminder (no record = all zeros, unavailable said as that, the matched rows with "never merges" and
//             「查看这些行」 deep links, the unbound rows with the ADR's handling guidance); a new run re-reads and a newer
//             zero reminder REPLACES an older non-zero one; another project re-reads and a stale answer is dropped; an
//             adopted older sandbox sheet says manual rows are not offered there and offers no switch
//   MR-ALIGN  the two manifest controls render for EXACTLY the actors the SERVER grants (the plugin module, imported
//             live): the READ (the status line and the reminder) for the PULL tier — the 拉取人员 included (OQ4) — and
//             the switch for ADMIN only (OQ6), a reader without it reading who can change it; a non-holder asks no read
//             and, once the panel has seen the sheet, reads who can; the client rows are byte-equal to the plugin's
//             (F-01 for these rows) and sit right after the pilot rows
//   MR-COPY   every new refusal code has its own two-line zh + en sentence; the audit mode rows; the wording rules
//   MR-MOUNT  the sync panel mounts the section ONCE with its five bindings; the section imports nothing from plugins/
//
// Synthetic, obviously-fake project numbers and handles only.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:admin'] as string[],
  roles: [] as string[],
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
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), email: '', roles: h.roles, permissions: h.permissions }),
    hasAdminAccess: () => h.roles.includes('admin'),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationProjectTargetManualRows from '../src/components/integration/stockPreparation/StockPreparationProjectTargetManualRows.vue'
import {
  STOCK_PREP_MANUAL_ROWS_ERROR_CODES,
  STOCK_PREP_MANUAL_ROWS_ID_LIMIT,
  StockPreparationManualRowsCallError,
  clampStockPrepManualRowsSetResult,
  clampStockPrepManualRowsState,
  createStockPreparationManualRowsApi,
  loadStockPreparationManualRows,
  setStockPreparationManualRows,
  stockPrepManualRowsRecordHref,
  type StockPrepManualRowsState,
  type StockPreparationManualRowsApi,
} from '../src/services/integration/stockPreparation/projectManualRows'
import {
  STOCK_PREP_AUDIT_ACTION_MODE_PLAIN,
  STOCK_PREP_AUDIT_ACTION_PLAIN,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_MANUAL_ROWS_PLAIN,
  stockPrepAuditActionPlain,
  stockPrepErrorPlain,
} from '../src/services/integration/stockPreparation/plainLanguage'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
} from '../src/services/integration/stockPreparation/workbenchAccess'

// The SERVER's own manifest and decision, imported live (the F-01 posture).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backendAccess = require('../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs')

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const PROJECT = 'PRJ-SYN-MR-01'
const OTHER_PROJECT = 'PRJ-SYN-MR-02'
const SHEET = 'sheet_syn_mr'
const FILL_VIEW = 'view_syn_mr_fill'
const MANUAL_ROWS_CAPABILITIES = ['projectTarget.manualRowsRead', 'projectTarget.manualRowsSet']

const NO_RECORD = { status: 'none', at: null, mode: null, rowCount: 0, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [] }

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectNo: PROJECT,
    status: 'active',
    sheetId: SHEET,
    viewId: FILL_VIEW,
    manualRowsSupported: true,
    keyColumn: 'present',
    policy: 'allowed',
    policySource: 'default',
    keyLocked: true,
    lastPull: { ...NO_RECORD },
    may: { set: true },
    ...overrides,
  }
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'synthetic refusal' } }), { status })
}

/** The calls the section made to the switch routes, as [path, method, body]. */
function switchCalls(): Array<[string, string, string | null]> {
  return h.apiFetch.mock.calls
    .filter(([path]) => String(path).includes('/target/manual-rows'))
    .map(([path, init]) => [String(path), (init as RequestInit | undefined)?.method ?? 'GET', ((init as RequestInit | undefined)?.body as string | undefined) ?? null])
}

let apps: Array<{ app: VueApp; host: HTMLElement }> = []

function mount(component: Component, props: Record<string, unknown>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component, props)
  app.mount(host)
  apps.push({ app, host })
  return host
}

/** Mount the section through ONE wrapper whose render function reads `props()`: a reactive prop change re-renders it. */
function mountReactive(props: () => Record<string, unknown>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => vnode(StockPreparationProjectTargetManualRows as Component, props()) })
  app.mount(host)
  apps.push({ app, host })
  return host
}

function unmountAll(): void {
  for (const { app, host } of apps) {
    app.unmount()
    host.remove()
  }
  apps = []
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${id}"]`)
}

function serverGranted(roles: readonly string[], permissions: readonly string[]): string[] {
  return backendAccess.grantedStockPrepCapabilities([...permissions, ...roles.map((role) => `role:${role}`)])
}

/**
 * A client double that answers as the server would for THIS actor: the READ for the PULL tier, the SET for ADMIN (403
 * otherwise), and the read's `may.set` only for an ADMIN caller — the server's `callerMaySet` rule.
 */
function gatedApi(state: Record<string, unknown>): StockPreparationManualRowsApi & { getCalls: string[]; setCalls: Array<[string, string, string]> } {
  const getCalls: string[] = []
  const setCalls: Array<[string, string, string]> = []
  const granted = () => serverGranted(h.roles, h.permissions)
  return {
    getCalls,
    setCalls,
    get: vi.fn(async (projectNo: string) => {
      getCalls.push(projectNo)
      const capabilities = granted()
      if (!capabilities.includes('projectTarget.manualRowsRead')) throw new StockPreparationManualRowsCallError(403, 'gate', { code: 'FORBIDDEN' })
      const may = (state.may ?? {}) as { set?: unknown }
      return clampStockPrepManualRowsState({ ...state, may: { set: may.set === true && capabilities.includes('projectTarget.manualRowsSet') } })!
    }),
    set: vi.fn(async (projectNo: string, confirmProjectNo: string, policy: 'allowed' | 'disabled') => {
      setCalls.push([projectNo, confirmProjectNo, policy])
      if (!granted().includes('projectTarget.manualRowsSet')) throw new StockPreparationManualRowsCallError(403, 'gate', { code: 'FORBIDDEN' })
      return clampStockPrepManualRowsSetResult({ ...state, policy, policySource: 'set', written: true, changed: true })!
    }),
  }
}

beforeEach(() => {
  h.locale = 'zh-CN'
  h.permissions = ['stock-prep:admin']
  h.roles = []
  h.apiFetch.mockReset()
})

afterEach(() => {
  unmountAll()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// MR-CLIENT
// ---------------------------------------------------------------------------

describe('MR-CLIENT — the two switch routes', () => {
  it('GET carries the scope query; POST carries exactly { confirmProjectNo, policy } and no query', async () => {
    h.apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => (init?.method === 'POST' ? ok({ ...wire({ policy: 'disabled', policySource: 'set' }), written: true, changed: true }) : ok(wire())))
    const api = createStockPreparationManualRowsApi(SCOPE)
    const state = await api.get(PROJECT)
    expect(state.policy).toBe('allowed')
    const result = await api.set(PROJECT, PROJECT, 'disabled')
    expect(result).toMatchObject({ policy: 'disabled', policySource: 'set', written: true, changed: true })
    expect(switchCalls()).toEqual([
      [`/api/integration/stock-preparation/projects/${PROJECT}/target/manual-rows?tenantId=tenant-syn&workspaceId=workspace-syn`, 'GET', null],
      [`/api/integration/stock-preparation/projects/${PROJECT}/target/manual-rows`, 'POST', JSON.stringify({ confirmProjectNo: PROJECT, policy: 'disabled' })],
    ])
  })

  it('the clamp: the project number is never read back; a malformed answer is refused, not guessed', () => {
    const state = clampStockPrepManualRowsState(wire())!
    expect(state).toEqual({
      status: 'active', sheetId: SHEET, viewId: FILL_VIEW, manualRowsSupported: true, keyColumn: 'present', policy: 'allowed', policySource: 'default', keyLocked: true,
      lastPull: { ...NO_RECORD }, may: { set: true },
    })
    expect('projectNo' in state).toBe(false)
    expect(clampStockPrepManualRowsState({ status: 'absent', projectNo: PROJECT })).toEqual({
      status: 'absent', sheetId: null, viewId: null, manualRowsSupported: null, keyColumn: null, policy: null, policySource: null, keyLocked: null, lastPull: null, may: { set: false },
    })
    for (const bad of [
      null, [], 'text', wire({ status: 'gone' }), wire({ policy: 'ALLOWED' }), wire({ policy: null }), wire({ policySource: 'maybe' }), wire({ keyLocked: 'yes' }),
      wire({ manualRowsSupported: 'yes' }), wire({ manualRowsSupported: undefined }), wire({ manualRowsSupported: null }),
      wire({ keyColumn: 'perhaps' }), wire({ lastPull: null }), wire({ lastPull: { ...NO_RECORD, status: 'later' } }), wire({ lastPull: { ...NO_RECORD, rowCount: -1 } }),
      wire({ lastPull: { ...NO_RECORD, rowCount: 1.5 } }), wire({ lastPull: { ...NO_RECORD, matchedManualRecordIds: [7] } }),
      wire({ lastPull: { ...NO_RECORD, status: 'recorded' } }), wire({ lastPull: { ...NO_RECORD, status: 'recorded', at: 'not a time', mode: 'apply' } }),
    ]) {
      expect(clampStockPrepManualRowsState(bad), JSON.stringify(bad)).toBeNull()
    }
    // `may.set` is the server's word AND the state's: an archived sheet never offers the switch, and neither does a
    // sheet the host never offers manual rows on (an adopted older sandbox sheet).
    expect(clampStockPrepManualRowsState(wire({ status: 'archived', may: { set: true } }))!.may.set).toBe(false)
    expect(clampStockPrepManualRowsState(wire({ manualRowsSupported: false, may: { set: true } }))).toMatchObject({ manualRowsSupported: false, may: { set: false } })
    // A missing key column carries no switch.
    expect(clampStockPrepManualRowsState(wire({ keyColumn: 'missing', policy: null, policySource: null, keyLocked: null, may: { set: false } }))).toMatchObject({ keyColumn: 'missing', policy: null, may: { set: false } })
    // An unavailable reminder keeps NULL counts — it can never be read as zeros.
    expect(clampStockPrepManualRowsState(wire({ lastPull: { status: 'unavailable', at: null, mode: null, rowCount: null, unboundKeyCount: null, matchedManualCount: null, matchedManualRecordIds: [], unboundRecordIds: [] } }))!.lastPull)
      .toEqual({ status: 'unavailable', at: null, mode: null, rowCount: null, unboundKeyCount: null, matchedManualCount: null, matchedManualRecordIds: [], unboundRecordIds: [] })
    // The id lists are capped.
    const many = Array.from({ length: STOCK_PREP_MANUAL_ROWS_ID_LIMIT + 5 }, (_, index) => `rec_syn_${index}`)
    const capped = clampStockPrepManualRowsState(wire({ lastPull: { status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'apply', rowCount: many.length, unboundKeyCount: 0, matchedManualCount: many.length, matchedManualRecordIds: many, unboundRecordIds: [] } }))!
    expect(capped.lastPull!.matchedManualRecordIds).toHaveLength(STOCK_PREP_MANUAL_ROWS_ID_LIMIT)
    // The SET answer must say what it did.
    expect(clampStockPrepManualRowsSetResult(wire())).toBeNull()
    expect(clampStockPrepManualRowsSetResult({ ...wire(), written: true, changed: false })).toMatchObject({ written: true, changed: false })
  })

  it('a refusal surfaces its status and clamped code; a malformed 200 is a malformed error', async () => {
    h.apiFetch.mockImplementation(async () => refused(409, 'STOCK_PREPARATION_PROJECT_ARCHIVED'))
    const api = createStockPreparationManualRowsApi(SCOPE)
    await expect(api.set(PROJECT, PROJECT, 'disabled')).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' })
    h.apiFetch.mockImplementation(async () => ok({ status: 'active' }))
    await expect(api.get(PROJECT)).rejects.toMatchObject({ malformed: true })
  })

  it('the record deep link: the multitable record route under the router base, every segment encoded; null without handles', () => {
    expect(stockPrepManualRowsRecordHref('/', { sheetId: SHEET, viewId: FILL_VIEW }, 'rec_syn_1')).toBe(`/multitable/${SHEET}/${FILL_VIEW}?recordId=rec_syn_1`)
    expect(stockPrepManualRowsRecordHref('/app/', { sheetId: 'sheet a/b', viewId: FILL_VIEW }, 'rec?1')).toBe(`/app/multitable/sheet%20a%2Fb/${FILL_VIEW}?recordId=rec%3F1`)
    expect(stockPrepManualRowsRecordHref('/', { sheetId: null, viewId: FILL_VIEW }, 'rec_syn_1')).toBeNull()
    expect(stockPrepManualRowsRecordHref('/', { sheetId: SHEET, viewId: null }, 'rec_syn_1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MR-FLOW
// ---------------------------------------------------------------------------

describe('MR-FLOW — typed confirmation, the ADMIN mirror, the switch-off answer', () => {
  it('a typed number that does not match sends NOTHING; no ADMIN tier sends nothing; a match sends the trimmed numbers', async () => {
    const api = gatedApi(wire())
    for (const typedNo of ['', `${PROJECT}-X`, PROJECT.toLowerCase(), PROJECT.slice(0, -1), OTHER_PROJECT]) {
      expect(await setStockPreparationManualRows({ api, canSet: true }, PROJECT, typedNo, 'disabled'), typedNo).toEqual({ kind: 'mismatch' })
    }
    expect(await setStockPreparationManualRows({ api, canSet: false }, PROJECT, PROJECT, 'disabled')).toEqual({ kind: 'not_permitted' })
    expect(await setStockPreparationManualRows({ api: null, canSet: true }, PROJECT, PROJECT, 'disabled')).toEqual({ kind: 'not_permitted' })
    expect(api.setCalls).toEqual([])
    const done = await setStockPreparationManualRows({ api, canSet: true }, ` ${PROJECT}`, `${PROJECT} `, 'disabled')
    expect(done.kind).toBe('done')
    expect(api.setCalls).toEqual([[PROJECT, PROJECT, 'disabled']])
  })

  it('the switch-off 404 loads as `disabled`; any other refusal keeps its status and code', async () => {
    const off = { get: vi.fn(async () => { throw new StockPreparationManualRowsCallError(404, 'gate', { code: 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED' }) }), set: vi.fn() }
    expect(await loadStockPreparationManualRows(off, PROJECT)).toEqual({ kind: 'disabled' })
    const other404 = { get: vi.fn(async () => { throw new StockPreparationManualRowsCallError(404, 'gate', { code: 'SOMETHING_ELSE' }) }), set: vi.fn() }
    expect(await loadStockPreparationManualRows(other404, PROJECT)).toEqual({ kind: 'refused', status: 404, code: 'SOMETHING_ELSE' })
    const refusedSet = { get: vi.fn(), set: vi.fn(async () => { throw new StockPreparationManualRowsCallError(409, 'gate', { code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' }) }) }
    expect(await setStockPreparationManualRows({ api: refusedSet, canSet: true }, PROJECT, PROJECT, 'disabled')).toEqual({ kind: 'refused', status: 409, code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' })
  })
})

// ---------------------------------------------------------------------------
// MR-PANEL
// ---------------------------------------------------------------------------

describe('MR-PANEL — the section for an ADMIN', () => {
  function mountSection(state: Record<string, unknown>, props: Record<string, unknown> = {}) {
    const api = gatedApi(state)
    const root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api, ...props })
    return { root, api }
  }

  it('an active sheet, allowed by default, no record: the switch line, its meaning, the offer to turn it off, all-zero reminder', async () => {
    const { root, api } = mountSection(wire())
    await flush()
    expect(api.getCalls).toEqual([PROJECT])
    const status = testid(root, 'stock-prep-project-manual-rows-status')!
    expect(status.dataset.policy).toBe('allowed')
    expect(status.dataset.policySource).toBe('default')
    expect(status.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.status_allowed_default.zh)
    expect(root.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.meaning.zh)
    const button = testid(root, 'stock-prep-project-manual-rows-set') as HTMLButtonElement
    expect(button.dataset.targetPolicy).toBe('disabled')
    expect(button.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.action_disable.zh)
    expect(testid(root, 'stock-prep-project-manual-rows-reminder')!.dataset.lastPull).toBe('none')
    expect(testid(root, 'stock-prep-project-manual-rows-last-pull-none')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.last_pull_none.zh)
    expect(testid(root, 'stock-prep-project-manual-rows-lock-missing')).toBeNull()
    expect(testid(root, 'stock-prep-project-manual-rows-archived')).toBeNull()
  })

  it('the typed confirmation: confirm disabled until the number matches; the POST read-back replaces the line; the result says so', async () => {
    const { root, api } = mountSection(wire())
    await flush()
    ;(testid(root, 'stock-prep-project-manual-rows-set') as HTMLButtonElement).click()
    await flush()
    const prompt = testid(root, 'stock-prep-project-manual-rows-prompt')!
    expect(prompt.dataset.targetPolicy).toBe('disabled')
    expect(prompt.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.confirm_disable.zh)
    expect(testid(root, 'stock-prep-project-manual-rows-project-no')!.textContent).toBe(PROJECT)
    const input = testid(root, 'stock-prep-project-manual-rows-input') as HTMLInputElement
    const confirm = () => testid(root, 'stock-prep-project-manual-rows-confirm') as HTMLButtonElement
    expect(confirm().disabled).toBe(true)
    for (const wrong of [PROJECT.toLowerCase(), `${PROJECT}-X`, PROJECT.slice(0, -1)]) {
      input.value = wrong
      input.dispatchEvent(new Event('input'))
      await flush()
      expect(confirm().disabled, wrong).toBe(true)
    }
    input.value = ` ${PROJECT} `
    input.dispatchEvent(new Event('input'))
    await flush()
    expect(confirm().disabled).toBe(false)
    confirm().click()
    await flush()
    expect(api.setCalls).toEqual([[PROJECT, PROJECT, 'disabled']])
    expect(testid(root, 'stock-prep-project-manual-rows-prompt')).toBeNull()
    const status = testid(root, 'stock-prep-project-manual-rows-status')!
    expect(status.dataset.policy).toBe('disabled')
    expect(status.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.status_disabled.zh)
    expect(testid(root, 'stock-prep-project-manual-rows-result')!.dataset.result).toBe('disabled')
    // The control now offers the way back.
    expect((testid(root, 'stock-prep-project-manual-rows-set') as HTMLButtonElement).dataset.targetPolicy).toBe('allowed')
  })

  it('a refused switch shows its sentence and code and re-reads the server state; cancel sends nothing', async () => {
    const api: StockPreparationManualRowsApi = {
      get: vi.fn(async () => clampStockPrepManualRowsState(wire())!),
      set: vi.fn(async () => { throw new StockPreparationManualRowsCallError(409, 'gate', { code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' }) }),
    }
    const root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api })
    await flush()
    ;(testid(root, 'stock-prep-project-manual-rows-set') as HTMLButtonElement).click()
    await flush()
    ;(testid(root, 'stock-prep-project-manual-rows-cancel') as HTMLButtonElement).click()
    await flush()
    expect(api.set).not.toHaveBeenCalled()
    ;(testid(root, 'stock-prep-project-manual-rows-set') as HTMLButtonElement).click()
    await flush()
    const input = testid(root, 'stock-prep-project-manual-rows-input') as HTMLInputElement
    input.value = PROJECT
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(testid(root, 'stock-prep-project-manual-rows-confirm') as HTMLButtonElement).click()
    await flush()
    const result = testid(root, 'stock-prep-project-manual-rows-result')!
    expect(result.dataset.result).toBe('refused')
    expect(result.textContent).toContain(STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_PROJECT_ARCHIVED.zh)
    expect(result.querySelector('code')!.textContent).toBe('STOCK_PREPARATION_PROJECT_ARCHIVED')
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('a recorded reminder: the count, the same-material rows (never merged) with their deep links, the unbound rows with the ADR guidance', async () => {
    const lastPull = {
      status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'apply', rowCount: 4, unboundKeyCount: 2, matchedManualCount: 1,
      matchedManualRecordIds: ['rec_syn_m1'], unboundRecordIds: ['rec_syn_u1', 'rec_syn_u2'],
    }
    const { root } = mountSection(wire({ lastPull }))
    await flush()
    expect(testid(root, 'stock-prep-project-manual-rows-reminder')!.dataset.lastPull).toBe('recorded')
    const count = testid(root, 'stock-prep-project-manual-rows-count')!
    expect(count.dataset.count).toBe('4')
    expect(count.textContent).toContain('4 行人工补充行')
    const matched = testid(root, 'stock-prep-project-manual-rows-matched')!
    expect(matched.dataset.count).toBe('1')
    expect(matched.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.reminder_explain.zh)
    expect(matched.textContent).toContain('不会自动合并')
    expect(Array.from(root.querySelectorAll('[data-testid="stock-prep-project-manual-rows-matched-link"]')).map((a) => (a as HTMLAnchorElement).getAttribute('href')))
      .toEqual([`/multitable/${SHEET}/${FILL_VIEW}?recordId=rec_syn_m1`])
    const unbound = testid(root, 'stock-prep-project-manual-rows-unbound')!
    expect(unbound.dataset.count).toBe('2')
    const guidance = testid(root, 'stock-prep-project-manual-rows-unbound-guidance')!.textContent ?? ''
    for (const clause of ['有建行人的,可以直接删除', '没有建行人的,要在补锁之前把唯一键改掉', '补锁之后,只能由负责人批准后做数据库处理']) {
      expect(guidance, clause).toContain(clause)
    }
    expect(Array.from(root.querySelectorAll('[data-testid="stock-prep-project-manual-rows-unbound-link"]')).map((a) => (a as HTMLAnchorElement).getAttribute('href')))
      .toEqual([`/multitable/${SHEET}/${FILL_VIEW}?recordId=rec_syn_u1`, `/multitable/${SHEET}/${FILL_VIEW}?recordId=rec_syn_u2`])
    for (const link of root.querySelectorAll('a')) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    }
  })

  it('a recorded zero reminder shows the count and no matched / unbound block; unavailable is said as that, never as zeros', async () => {
    let mounted = mountSection(wire({ lastPull: { ...NO_RECORD, status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'dry_run' } }))
    await flush()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-count')!.dataset.count).toBe('0')
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-matched')).toBeNull()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-unbound')).toBeNull()
    unmountAll()
    mounted = mountSection(wire({ lastPull: { status: 'unavailable', at: null, mode: null, rowCount: null, unboundKeyCount: null, matchedManualCount: null, matchedManualRecordIds: [], unboundRecordIds: [] } }))
    await flush()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-reminder')!.dataset.lastPull).toBe('unavailable')
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-last-pull-unavailable')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.last_pull_unavailable.zh)
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-count')).toBeNull()
  })

  it('a newer pull with nothing to say REPLACES an older non-zero reminder: the count reads 0 and the matched / unbound blocks are gone', async () => {
    // B1 overwrites the record with zeros when a later pull reads no manual and no unbound row; the panel must say
    // what the server holds NOW, never keep the older pull's counts (verifier mutation V06).
    const older = {
      status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'apply', rowCount: 3, unboundKeyCount: 2, matchedManualCount: 1,
      matchedManualRecordIds: ['rec_syn_m1'], unboundRecordIds: ['rec_syn_u1', 'rec_syn_u2'],
    }
    const newer = { ...NO_RECORD, status: 'recorded', at: '2026-10-31T02:03:04.000Z', mode: 'dry_run' }
    const answers = [wire({ lastPull: older }), wire({ lastPull: newer })]
    let reads = 0
    const api: StockPreparationManualRowsApi = {
      get: vi.fn(async () => {
        reads += 1
        return clampStockPrepManualRowsState(answers[Math.min(reads, answers.length) - 1])!
      }),
      set: vi.fn(),
    }
    const props = ref<{ lastRun: unknown }>({ lastRun: null })
    const host = mountReactive(() => ({ projectNo: PROJECT, lastRun: props.value.lastRun, scope: SCOPE, api }))
    await flush()
    expect(reads).toBe(1)
    expect(testid(host, 'stock-prep-project-manual-rows-count')!.dataset.count).toBe('3')
    expect(testid(host, 'stock-prep-project-manual-rows-matched')).not.toBeNull()
    expect(testid(host, 'stock-prep-project-manual-rows-unbound')).not.toBeNull()
    // The panel's next run: the server now answers the newer, all-zero record.
    props.value = { lastRun: { run: 2 } }
    await flush()
    expect(reads).toBe(2)
    expect(testid(host, 'stock-prep-project-manual-rows-reminder')!.dataset.lastPull).toBe('recorded')
    const count = testid(host, 'stock-prep-project-manual-rows-count')!
    expect(count.dataset.count, 'the newer record replaced the older counts').toBe('0')
    expect(count.textContent).toContain('0 行人工补充行')
    expect(testid(host, 'stock-prep-project-manual-rows-matched'), 'no same-material block from the older pull').toBeNull()
    expect(testid(host, 'stock-prep-project-manual-rows-unbound'), 'no unbound block from the older pull').toBeNull()
    expect(host.querySelectorAll('a').length, 'no deep link to an older pull\'s rows').toBe(0)
  })

  it('archived: the line and the archived note, no switch; lock missing and key missing are said; set allowed offers the way back', async () => {
    let mounted = mountSection(wire({ status: 'archived', may: { set: false } }))
    await flush()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-status')).not.toBeNull()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-archived')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.archived.zh)
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-set')).toBeNull()
    unmountAll()
    mounted = mountSection(wire({ keyLocked: false }))
    await flush()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-lock-missing')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.lock_missing.zh)
    unmountAll()
    mounted = mountSection(wire({ keyColumn: 'missing', policy: null, policySource: null, keyLocked: null, may: { set: false } }))
    await flush()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-status')!.dataset.keyColumn).toBe('missing')
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-key-missing')).not.toBeNull()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-set')).toBeNull()
    unmountAll()
    mounted = mountSection(wire({ policy: 'disabled', policySource: 'set' }))
    await flush()
    expect(testid(mounted.root, 'stock-prep-project-manual-rows-status')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.status_disabled.zh)
    expect((testid(mounted.root, 'stock-prep-project-manual-rows-set') as HTMLButtonElement).textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.action_allow.zh)
  })

  it('an adopted older sandbox sheet: says manual rows are not offered there, no switch state and no switch even for an ADMIN; the reminder still shows', async () => {
    const lastPull = {
      status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'apply', rowCount: 1, unboundKeyCount: 1, matchedManualCount: 0,
      matchedManualRecordIds: [], unboundRecordIds: ['rec_syn_u1'],
    }
    // The server answers `manualRowsSupported: false` and never `may.set` there; the clamp would refuse the offer anyway.
    const { root } = mountSection(wire({ manualRowsSupported: false, may: { set: false }, lastPull }))
    await flush()
    const status = testid(root, 'stock-prep-project-manual-rows-status')!
    expect(status.dataset.supported).toBe('no')
    expect(status.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.not_supported.zh)
    expect(status.textContent).not.toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.status_allowed_default.zh)
    expect(testid(root, 'stock-prep-project-manual-rows-not-supported')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.not_supported.zhNext!)
    expect(root.textContent).not.toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.meaning.zh)
    expect(testid(root, 'stock-prep-project-manual-rows-set')).toBeNull()
    expect(testid(root, 'stock-prep-project-manual-rows-set-admin-only'), 'not "ask an admin": nobody can set it here').toBeNull()
    expect(testid(root, 'stock-prep-project-manual-rows-unbound')!.dataset.count).toBe('1')
  })

  it('the switch off (404 DISABLED) and an absent project render nothing; another refusal says it cannot read, with its code', async () => {
    const off: StockPreparationManualRowsApi = { get: vi.fn(async () => { throw new StockPreparationManualRowsCallError(404, 'gate', { code: 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED' }) }), set: vi.fn() }
    let root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api: off })
    await flush()
    expect(root.textContent!.trim()).toBe('')
    unmountAll()
    root = mountSection({ status: 'absent' }).root
    await flush()
    expect(root.textContent!.trim()).toBe('')
    unmountAll()
    const down: StockPreparationManualRowsApi = { get: vi.fn(async () => { throw new StockPreparationManualRowsCallError(501, 'gate', { code: 'STOCK_PREP_MANUAL_ROWS_HOST_UNSUPPORTED' }) }), set: vi.fn() }
    root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api: down })
    await flush()
    const failed = testid(root, 'stock-prep-project-manual-rows-read-failed')!
    expect(failed.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.read_failed.zh)
    expect(failed.querySelector('code')!.textContent).toBe('STOCK_PREP_MANUAL_ROWS_HOST_UNSUPPORTED')
  })

  it('no project, an inert mount: no read at all; the production client reads through apiFetch when not inert', async () => {
    let mounted = mountSection(wire(), { projectNo: '   ' })
    await flush()
    expect(mounted.api.getCalls).toEqual([])
    unmountAll()
    mounted = mountSection(wire(), { inert: true })
    await flush()
    expect(mounted.api.getCalls).toEqual([])
    expect(mounted.root.textContent!.trim()).toBe('')
    unmountAll()
    h.apiFetch.mockImplementation(async () => ok(wire()))
    const root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    expect(switchCalls()).toEqual([[`/api/integration/stock-preparation/projects/${PROJECT}/target/manual-rows?tenantId=tenant-syn&workspaceId=workspace-syn`, 'GET', null]])
    expect(testid(root, 'stock-prep-project-manual-rows-status')).not.toBeNull()
  })

  it('a new run re-reads; another project re-reads, drops the open confirmation, and a stale answer never lands', async () => {
    let releaseFirst: (value: StockPrepManualRowsState) => void = () => {}
    const reads: string[] = []
    const api: StockPreparationManualRowsApi = {
      get: vi.fn((projectNo: string) => {
        reads.push(projectNo)
        if (reads.length === 3) return new Promise<StockPrepManualRowsState>((resolve) => { releaseFirst = resolve })
        return Promise.resolve(clampStockPrepManualRowsState(wire({ sheetId: `sheet_for_${projectNo}` }))!)
      }),
      set: vi.fn(),
    }
    const props = ref<{ projectNo: string; lastRun: unknown }>({ projectNo: PROJECT, lastRun: null })
    const host = mountReactive(() => ({ projectNo: props.value.projectNo, lastRun: props.value.lastRun, scope: SCOPE, api }))
    await flush()
    expect(reads).toEqual([PROJECT])
    props.value = { ...props.value, lastRun: { run: 1 } }
    await flush()
    expect(reads).toEqual([PROJECT, PROJECT])
    // Open the confirmation, then switch project while a read for the new project... is overtaken by a newer one.
    ;(testid(host, 'stock-prep-project-manual-rows-set') as HTMLButtonElement).click()
    await flush()
    expect(testid(host, 'stock-prep-project-manual-rows-prompt')).not.toBeNull()
    props.value = { ...props.value, projectNo: OTHER_PROJECT }
    await flush()
    expect(testid(host, 'stock-prep-project-manual-rows-prompt'), 'the confirmation belonged to the old project').toBeNull()
    props.value = { ...props.value, projectNo: PROJECT }
    await flush()
    // The OTHER_PROJECT read (the 3rd) is still pending; the newer read (PROJECT, allowed) has landed. Resolving the
    // stale one now — with a DIFFERENT switch state — must not overwrite the newer answer.
    expect(reads).toEqual([PROJECT, PROJECT, OTHER_PROJECT, PROJECT])
    expect(testid(host, 'stock-prep-project-manual-rows-status')!.dataset.policy).toBe('allowed')
    releaseFirst(clampStockPrepManualRowsState(wire({ sheetId: 'sheet_stale', policy: 'disabled', policySource: 'set' }))!)
    await flush()
    expect(testid(host, 'stock-prep-project-manual-rows-status')!.dataset.policy, 'the stale answer did not land').toBe('allowed')
  })
})

// ---------------------------------------------------------------------------
// MR-ALIGN
// ---------------------------------------------------------------------------

describe('MR-ALIGN — the two manifest controls render for exactly the actors the server grants', () => {
  const ACTORS: Array<{ name: string; roles: string[]; permissions: string[] }> = [
    { name: 'logged-in', roles: [], permissions: [] },
    { name: 'read-only', roles: [], permissions: ['stock-prep:read'] },
    { name: 'floor', roles: [], permissions: ['stock-prep:read', 'stock-prep:operate'] },
    { name: 'puller', roles: [], permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] },
    { name: 'workbench-admin', roles: [], permissions: ['stock-prep:admin'] },
    { name: 'platform-admin', roles: ['admin'], permissions: ['integration:admin'] },
    { name: 'pull-orphan', roles: [], permissions: ['stock-prep:pull'] },
    { name: 'operate-orphan', roles: [], permissions: ['stock-prep:operate'] },
    { name: 'wildcard (grants nothing here)', roles: [], permissions: ['stock-prep:*'] },
  ]

  it('the client rows are BYTE-EQUAL to the plugin module rows (F-01 for these rows) and sit right after the pilot rows', () => {
    const pick = (rows: readonly { capability: string }[]) => rows.filter((row) => MANUAL_ROWS_CAPABILITIES.includes(row.capability))
    const server = pick(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES)
    expect(server.map((row: { capability: string }) => row.capability)).toEqual(MANUAL_ROWS_CAPABILITIES)
    expect(JSON.stringify(pick(STOCK_PREP_WORKBENCH_CAPABILITIES))).toBe(JSON.stringify(server))
    // The READ is the PULL tier (OQ4: the reminder is for the people who pull); the SET is ADMIN (OQ6).
    expect(server.map((row: { code: string; method: string; control: string }) => [row.code, row.method, row.control])).toEqual([
      ['stock-prep:pull', 'GET', 'stock-prep-project-manual-rows-status'],
      ['stock-prep:admin', 'POST', 'stock-prep-project-manual-rows-set'],
    ])
    const order = STOCK_PREP_WORKBENCH_CAPABILITIES.map((row) => row.capability)
    const at = order.indexOf('projectTarget.pilotEnable')
    expect(order.slice(at, at + 3)).toEqual(['projectTarget.pilotEnable', ...MANUAL_ROWS_CAPABILITIES])
    expect(order).toEqual(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES.map((row: { capability: string }) => row.capability))
  })

  it('the switch line (with the reminder) and the switch button render iff the SERVER grants them; a reader without the SET reads who can change it; a non-holder asks no read and reads who can', async () => {
    // A reminder with something to say, so "the reader sees the reminder" is a rendered count, not an empty block.
    const lastPull = {
      status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'apply', rowCount: 2, unboundKeyCount: 1, matchedManualCount: 1,
      matchedManualRecordIds: ['rec_syn_m1'], unboundRecordIds: ['rec_syn_u1'],
    }
    let rendered = 0
    let readersWithoutSet = 0
    for (const actor of ACTORS) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      const granted = serverGranted(actor.roles, actor.permissions)
      expect(grantedStockPrepCapabilities({ roles: actor.roles, permissions: actor.permissions }).filter((id) => MANUAL_ROWS_CAPABILITIES.includes(id)), actor.name)
        .toEqual(granted.filter((id: string) => MANUAL_ROWS_CAPABILITIES.includes(id)))
      const api = gatedApi(wire({ lastPull }))
      const root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api, projectSheetKnown: true })
      await flush()
      const reads = granted.includes('projectTarget.manualRowsRead')
      const sets = granted.includes('projectTarget.manualRowsSet')
      const statusRendered = testid(root, 'stock-prep-project-manual-rows-status') !== null
      const setRendered = testid(root, 'stock-prep-project-manual-rows-set') !== null
      expect(statusRendered, `${actor.name}: status line`).toBe(reads)
      expect(setRendered, `${actor.name}: switch button`).toBe(sets)
      if (!reads) {
        expect(api.getCalls, `${actor.name}: a non-holder asks no read (it would 403)`).toEqual([])
        expect(testid(root, 'stock-prep-project-manual-rows-admin-only')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.admin_only.zh)
        expect(testid(root, 'stock-prep-project-manual-rows-reminder'), `${actor.name}: no reminder without the read`).toBeNull()
      } else {
        expect(testid(root, 'stock-prep-project-manual-rows-admin-only')).toBeNull()
        // OQ4: every reader sees the reminder — the count, the same-material block and the unbound block.
        expect(testid(root, 'stock-prep-project-manual-rows-count')!.dataset.count, `${actor.name}: the reminder's count`).toBe('2')
        expect(testid(root, 'stock-prep-project-manual-rows-matched'), `${actor.name}: the same-material block`).not.toBeNull()
        expect(testid(root, 'stock-prep-project-manual-rows-unbound'), `${actor.name}: the unbound block`).not.toBeNull()
        // R-11 / OQ6: a reader without the SET sees no switch and the reason in words; a holder of the SET does not.
        const reason = testid(root, 'stock-prep-project-manual-rows-set-admin-only')
        if (sets) {
          expect(reason, `${actor.name}: no "ask an admin" line for an admin`).toBeNull()
        } else {
          expect(reason!.textContent, `${actor.name}: who can change it`).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.set_admin_only.zh)
          readersWithoutSet += 1
        }
      }
      rendered += Number(statusRendered) + Number(setRendered)
      unmountAll()
    }
    // Anti-vacuity: the 拉取人员 sees the status line (1); stock-prep:admin and the platform admin see both (2 × 2).
    expect(rendered).toBe(5)
    expect(readersWithoutSet, 'the 拉取人员 is the one reader without the SET').toBe(1)
    // Without a seen sheet, a non-holder gets no sentence at all (a deployment without project sheets says nothing).
    h.roles = []
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    const root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api: gatedApi(wire()) })
    await flush()
    expect(root.textContent!.trim()).toBe('')
  })

  it('the client mirror: a 拉取人员 is never offered the switch, even by an answer that says may.set', async () => {
    h.roles = []
    h.permissions = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']
    // A (misbehaving) answer that offers the switch to this caller: the client's own SET mirror still hides it.
    const api: StockPreparationManualRowsApi = { get: vi.fn(async () => clampStockPrepManualRowsState(wire({ may: { set: true } }))!), set: vi.fn() }
    const root = mount(StockPreparationProjectTargetManualRows as Component, { scope: SCOPE, projectNo: PROJECT, api, projectSheetKnown: true })
    await flush()
    expect(testid(root, 'stock-prep-project-manual-rows-status')).not.toBeNull()
    expect(testid(root, 'stock-prep-project-manual-rows-set')).toBeNull()
    expect(testid(root, 'stock-prep-project-manual-rows-set-admin-only')!.textContent).toContain(STOCK_PREP_MANUAL_ROWS_PLAIN.set_admin_only.zh)
    expect(api.set).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// MR-COPY
// ---------------------------------------------------------------------------

describe('MR-COPY — the sentences', () => {
  it('every new refusal code has its own two-line zh + en sentence (never the generic one)', () => {
    const generic = stockPrepErrorPlain('NO_SUCH_CODE_EVER')
    for (const code of STOCK_PREP_MANUAL_ROWS_ERROR_CODES) {
      const entry = STOCK_PREP_ERROR_PLAIN[code]
      expect(entry, code).toBeTruthy()
      for (const key of ['zh', 'en', 'zhNext', 'enNext'] as const) {
        expect(String(entry[key] ?? '').trim().length, `${code}.${key}`).toBeGreaterThan(0)
      }
      expect(stockPrepErrorPlain(code)).not.toEqual(generic)
    }
  })

  it('the audit modes: both switch modes read their own line under project_fields_update; the S3 mode keeps the action line; the action table is unchanged', () => {
    expect(Object.keys(STOCK_PREP_AUDIT_ACTION_MODE_PLAIN.project_fields_update).sort()).toEqual(['manual_rows_allowed', 'manual_rows_disabled'])
    expect(stockPrepAuditActionPlain('project_fields_update', 'manual_rows_allowed')!.zh).toContain('打开了「允许人工补充行」')
    expect(stockPrepAuditActionPlain('project_fields_update', 'manual_rows_disabled')!.zh).toContain('关闭了「允许人工补充行」')
    expect(stockPrepAuditActionPlain('project_fields_update', 'updated')).toBe(STOCK_PREP_AUDIT_ACTION_PLAIN.project_fields_update)
    expect(stockPrepAuditActionPlain('project_fields_update', null)).toBe(STOCK_PREP_AUDIT_ACTION_PLAIN.project_fields_update)
    // The modes are the ones the plugin writes (read as TEXT: that module pulls a heavy dependency chain).
    const routes = readFileSync(join(__dirname, '../../../plugins/plugin-integration-core/lib/http-routes.cjs'), 'utf8')
    const modes = /const STOCK_PREPARATION_MANUAL_ROWS_AUDIT_MODES = Object\.freeze\(\{\s*allowed: '([a-z_]+)',\s*disabled: '([a-z_]+)',\s*\}\)/.exec(routes)
    expect(modes?.slice(1)).toEqual(['manual_rows_allowed', 'manual_rows_disabled'])
  })

  it('every panel sentence has zh and en; the wording rules hold', () => {
    for (const [id, entry] of Object.entries(STOCK_PREP_MANUAL_ROWS_PLAIN)) {
      expect(entry.zh.trim().length, `${id}.zh`).toBeGreaterThan(0)
      expect(entry.en.trim().length, `${id}.en`).toBeGreaterThan(0)
    }
    expect(STOCK_PREP_MANUAL_ROWS_PLAIN.reminder_explain.zh).toContain('不会自动合并')
    expect(STOCK_PREP_MANUAL_ROWS_PLAIN.reminder_explain.en).toContain('never merges')
    expect(STOCK_PREP_MANUAL_ROWS_PLAIN.meaning.zh).toContain('已有的人工补充行照旧可以修改、删除')
    expect(STOCK_PREP_MANUAL_ROWS_PLAIN.confirm_disable.zh).toContain('已有的人工补充行不受影响')
    for (const sentence of Object.values(STOCK_PREP_MANUAL_ROWS_PLAIN)) {
      expect(sentence.zh.includes('合并') && !sentence.zh.includes('不会自动合并'), 'no sentence promises a merge').toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// MR-MOUNT
// ---------------------------------------------------------------------------

describe('MR-MOUNT — one mount point in the sync panel; nothing from plugins/', () => {
  const panel = readFileSync(join(__dirname, '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'), 'utf8')
  const section = readFileSync(join(__dirname, '../src/components/integration/stockPreparation/StockPreparationProjectTargetManualRows.vue'), 'utf8')
  const service = readFileSync(join(__dirname, '../src/services/integration/stockPreparation/projectManualRows.ts'), 'utf8')

  it('the sync panel mounts the section exactly once, with its five bindings', () => {
    expect(panel.match(/<StockPreparationProjectTargetManualRows\b/g)).toHaveLength(1)
    const tag = panel.slice(panel.indexOf('<StockPreparationProjectTargetManualRows'), panel.indexOf('/>', panel.indexOf('<StockPreparationProjectTargetManualRows')) + 2)
    expect(tag).toContain(':project-no="submittedProjectNo || props.projectNo"')
    expect(tag).toContain(':scope="scope"')
    expect(tag).toContain(':last-run="report"')
    expect(tag).toContain(':project-sheet-known="Boolean(afterState && afterState.status !== \'absent\')"')
    expect(tag).toContain(':inert="Boolean(props.api || props.targetApi)"')
  })

  it('neither the section nor its service imports anything from plugins/ (the main image builds apps/web alone)', () => {
    for (const source of [section, service]) {
      expect(source).not.toMatch(/from ['"][^'"]*plugins\//)
      expect(source).not.toMatch(/require\(['"][^'"]*plugins\//)
    }
  })
})

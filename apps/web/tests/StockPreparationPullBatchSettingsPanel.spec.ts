import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as vnode, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// 批次标识 BI-7 — 数据来源与体检's pull-batch settings panel (batch-identifier design §5.5 / §7.1 / §11; coordinator
// rulings C2 / C6 / C8 / C10; register R-65).
//
//   PBS-VOCAB     the pinned web vocabulary (keys, values, built-in defaults = the 10-27 design, fixed facts, locks) is
//                 deep-equal to the plugin's pure module and ledger store, imported LIVE; the C2 removals stay removed;
//                 every settings code is the plugin's own spelling
//   PBS-CLIENT    the GET carries the scope query; the POSTs carry NO query and exactly the closed body; strict clamps
//                 (a token outside the vocabulary, another vocabulary / fixed fact, a half-captured row, a `may.set`
//                 the row's state contradicts are all refused, never painted)
//   PBS-INVISIBLE (C6) ANY 404 (SETTINGS_DISABLED, PROJECT_SHEETS_DISABLED, a host without the route) renders nothing
//                 — no card, no line; nothing renders while the read is in flight; a caller below ADMIN asks nothing
//   PBS-RENDER    the four settings with their labels and 「（默认）」 marks, the source badge (built-in / the tenant's
//                 version), the four 「不可配置」 facts, the rule-F help taken from the ANSWER (C10's caveat)
//   PBS-SAVE      Save disabled with no change; one changed key sends exactly { expectedVersion, <key> }; a version
//                 conflict says so and re-reads; success says 「已保存（第 N 版）」 and re-reads
//   PBS-SHEETS    one row per state: not captured (「安装时采用」), unlocked (edit control), locked (「已锁定」 + 「锁定于」),
//                 archived, landing / placement applied or not
//   PBS-SHEET-EDIT a typed mismatch sends nothing; a match sends { confirmProjectNo, expectedVersion, <changed> } to the
//                 project's path with no query; CONFIG_LOCKED names the locked keys in words and re-reads; NOT_CAPTURED
//   PBS-STRADDLE  a per-sheet form belongs to the scope and session it was opened under: a scope move or a session
//                 switch closes it (re-read); a save click after another tab replaced the session writes nothing; an
//                 answer landing after a switch is not painted; an unmounted panel no longer listens
//   PBS-ALIGN     the client rows are byte-equal to the plugin's (live), one consecutive slice right after the pull-batch
//                 status row; the three controls render for EXACTLY the actors the server grants
//   PBS-COPY      every settings code has its own two-line zh + en copy (one entry per code); the two audit modes read
//                 their own lines under project_fields_update and are the store's spellings
//   PBS-MOUNT     the install view mounts the panel exactly once, outside the wizard; nothing imports from plugins/
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

import StockPreparationPullBatchSettingsPanel from '../src/components/integration/stockPreparation/StockPreparationPullBatchSettingsPanel.vue'
import {
  STOCK_PREP_PULL_BATCH_BUILT_IN_SETTINGS,
  STOCK_PREP_PULL_BATCH_CONFIG_LOCKS,
  STOCK_PREP_PULL_BATCH_FIXED_FACTS,
  STOCK_PREP_PULL_BATCH_SETTINGS_ERROR_CODES,
  STOCK_PREP_PULL_BATCH_SETTING_KEYS,
  STOCK_PREP_PULL_BATCH_SETTING_VALUES,
  STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS,
  changedPullBatchSettingsPatch,
  clampStockPrepPullBatchSettingsState,
  createStockPreparationPullBatchSettingsApi,
  loadStockPreparationPullBatchSettings,
} from '../src/services/integration/stockPreparation/pullBatchSettings'
import {
  STOCK_PREP_AUDIT_ACTION_MODE_PLAIN,
  STOCK_PREP_AUDIT_ACTION_PLAIN,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_PULL_BATCH_SETTINGS_PLAIN,
  stockPrepAuditActionPlain,
  stockPrepErrorPlain,
} from '../src/services/integration/stockPreparation/plainLanguage'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const nodeRequire = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../plugins/plugin-integration-core/lib/'
/* eslint-disable @typescript-eslint/no-explicit-any */
const PB = nodeRequire(`${PLUGIN_LIB}stock-preparation-pull-batch.cjs`) as any
const ST = nodeRequire(`${PLUGIN_LIB}stock-preparation-pull-batch-store.cjs`) as any
const SETTINGS = nodeRequire(`${PLUGIN_LIB}stock-preparation-pull-batch-settings.cjs`) as any
const backendAccess = nodeRequire(`${PLUGIN_LIB}stock-preparation-workbench-access.cjs`) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const SETTINGS_URL = '/api/integration/stock-preparation/pull-batch/settings'
const PBS_CAPABILITIES = ['pullBatch.settingsRead', 'pullBatch.settingsSet', 'projectTarget.pullBatchSettingsSet']

function sheetRow(projectNo: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectNo,
    sheetId: `sheet_syn_${projectNo.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    registryStatus: 'active',
    captured: { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: null, placement: 'left' },
    labelLocale: 'zh-CN',
    historyStatus: 'born_empty',
    locks: { firstPullBatchRule: false, labelFormat: false, landing: false, placement: true },
    lockedAt: null,
    version: 0,
    may: { set: true },
    ...over,
  }
}

const UNCAPTURED = {
  captured: null, labelLocale: null, historyStatus: null, locks: null, lockedAt: null, version: null, may: { set: false },
}

/** A GET answer built from the plugin's own modules (the server's answer shape). */
function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vocabulary: JSON.parse(JSON.stringify(PB.PULL_BATCH_CONFIG_VALUES)),
    builtIn: { ...PB.DEFAULT_PULL_BATCH_CONFIG },
    tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG }, source: 'built_in', version: 0 },
    fixedFacts: { ...PB.PULL_BATCH_FIXED_FACTS },
    locks: { ...PB.PULL_BATCH_CONFIG_LOCKS },
    sheetKeys: [...ST.PULL_BATCH_SHEET_SETTING_KEYS],
    help: JSON.parse(JSON.stringify(PB.PULL_BATCH_SETTINGS_HELP)),
    sheets: [
      sheetRow('S-01'),
      sheetRow('S-02', {
        captured: { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal', landing: 'promote_prep_fill', placement: 'right' },
        locks: { firstPullBatchRule: true, labelFormat: true, landing: true, placement: true },
        lockedAt: '2026-11-07T02:00:00.000Z', historyStatus: 'backfilled', labelLocale: 'en', version: 3, may: { set: false },
      }),
      sheetRow('S-03', UNCAPTURED),
      sheetRow('S-04', { registryStatus: 'archived', may: { set: false } }),
    ],
    unregisteredLedgerRowCount: 0,
    may: { setTenant: true },
    ...over,
  }
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refused(status: number, code: string, details?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'synthetic refusal', ...(details ? { details } : {}) } }), { status })
}

type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>
function serve(responder: Responder): void {
  h.apiFetch.mockImplementation(async (input: string, init?: RequestInit) => responder(String(input), init))
}

/** The calls the panel made, as [url, method, body]. */
function calls(): Array<[string, string, unknown]> {
  return h.apiFetch.mock.calls.map(([url, init]) => {
    const request = init as RequestInit | undefined
    return [String(url), request?.method ?? 'GET', request?.body ? JSON.parse(String(request.body)) : null]
  })
}

let apps: Array<{ app: VueApp; host: HTMLElement }> = []

function mount(props: Record<string, unknown> = { scope: SCOPE }): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(StockPreparationPullBatchSettingsPanel as Component, props)
  app.mount(host)
  apps.push({ app, host })
  return host
}

function mountReactive(props: () => Record<string, unknown>): { host: HTMLElement; app: VueApp } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => vnode(StockPreparationPullBatchSettingsPanel as Component, props()) })
  app.mount(host)
  apps.push({ app, host })
  return { host, app }
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

function testid(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${id}"]`)
}

function all(root: ParentNode, id: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(`[data-testid="${id}"]`))
}

function rowOf(root: HTMLElement, projectNo: string): HTMLElement {
  const row = root.querySelector(`[data-testid="stock-prep-pull-batch-settings-sheet-row"][data-project="${projectNo}"]`)
  expect(row, projectNo).not.toBeNull()
  return row as HTMLElement
}

function choose(root: ParentNode, testId: string, key: string, value: string): void {
  const label = root.querySelector(`[data-testid="${testId}"][data-key="${key}"][data-value="${value}"]`)
  const input = label?.querySelector('input') as HTMLInputElement
  input.checked = true
  input.dispatchEvent(new Event('change'))
}

function type(root: ParentNode, value: string): void {
  const input = testid(root, 'stock-prep-pull-batch-settings-sheet-input') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function serverGranted(roles: readonly string[], permissions: readonly string[]): string[] {
  return backendAccess.grantedStockPrepCapabilities([...permissions, ...roles.map((role) => `role:${role}`)])
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
// PBS-VOCAB
// ---------------------------------------------------------------------------

describe('PBS-VOCAB — the web vocabulary is the plugin\'s (live)', () => {
  it('keys, values, built-in defaults, fixed facts, locks and the per-sheet keys deep-equal the pure module and the store', () => {
    expect(JSON.parse(JSON.stringify(STOCK_PREP_PULL_BATCH_SETTING_VALUES))).toEqual(JSON.parse(JSON.stringify(PB.PULL_BATCH_CONFIG_VALUES)))
    expect([...STOCK_PREP_PULL_BATCH_SETTING_KEYS]).toEqual([...PB.PULL_BATCH_CONFIG_KEYS])
    expect([...STOCK_PREP_PULL_BATCH_SETTING_KEYS]).toEqual([...ST.PULL_BATCH_SETTING_KEYS])
    expect([...STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS]).toEqual([...ST.PULL_BATCH_SHEET_SETTING_KEYS])
    expect({ ...STOCK_PREP_PULL_BATCH_BUILT_IN_SETTINGS }).toEqual({ ...PB.DEFAULT_PULL_BATCH_CONFIG })
    expect({ ...STOCK_PREP_PULL_BATCH_BUILT_IN_SETTINGS }).toEqual({ firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: 'promote_prep_fill', placement: 'left' })
    expect({ ...STOCK_PREP_PULL_BATCH_FIXED_FACTS }).toEqual({ ...PB.PULL_BATCH_FIXED_FACTS })
    expect({ ...STOCK_PREP_PULL_BATCH_CONFIG_LOCKS }).toEqual({ ...PB.PULL_BATCH_CONFIG_LOCKS })
  })

  it('the C2 removals stay removed', () => {
    expect(STOCK_PREP_PULL_BATCH_SETTING_VALUES.firstPullBatchRule).not.toContain('off')
    expect(STOCK_PREP_PULL_BATCH_SETTING_VALUES.labelFormat).not.toContain('date')
    for (const removed of ['formalExport', 'trashedRowsAreEvidence', 'pullBatchMeaning', 'firstPullBatchColumn']) {
      expect(STOCK_PREP_PULL_BATCH_SETTING_KEYS as readonly string[]).not.toContain(removed)
    }
  })

  it('every settings code is the plugin\'s own spelling (pure module, store, route helper)', () => {
    expect([...STOCK_PREP_PULL_BATCH_SETTINGS_ERROR_CODES].sort()).toEqual([
      SETTINGS.STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED_CODE,
      SETTINGS.STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE_CODE,
      PB.PULL_BATCH_ERROR_CODES.STORE_FAILED,
      PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID,
      PB.PULL_BATCH_ERROR_CODES.CONFIG_LOCKED,
      ST.SETTINGS_VERSION_CONFLICT_CODE,
      ST.SETTINGS_NOT_CAPTURED_CODE,
    ].sort())
  })
})

// ---------------------------------------------------------------------------
// PBS-CLIENT
// ---------------------------------------------------------------------------

describe('PBS-CLIENT — the three routes and the clamps', () => {
  it('GET with the scope query; the two POSTs with no query and exactly the closed body', async () => {
    serve((url, init) => (init?.method === 'POST'
      ? ok(url.includes('/projects/') ? { sheet: sheetRow('S-01', { version: 1 }), written: true } : { tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, placement: 'right' }, source: 'tenant', version: 1 }, written: true, changedKeys: ['placement'] })
      : ok(answer())))
    const api = createStockPreparationPullBatchSettingsApi(SCOPE)
    await api.get()
    await api.setTenant(0, { placement: 'right' })
    await api.setSheet('S-01', 'S-01', 0, { labelFormat: 'ordinal' })
    expect(calls()).toEqual([
      [`${SETTINGS_URL}?tenantId=tenant-syn&workspaceId=workspace-syn`, 'GET', null],
      [SETTINGS_URL, 'POST', { expectedVersion: 0, placement: 'right' }],
      ['/api/integration/stock-preparation/projects/S-01/target/pull-batch/settings', 'POST', { confirmProjectNo: 'S-01', expectedVersion: 0, labelFormat: 'ordinal' }],
    ])
  })

  it('a malformed answer is refused, never painted', () => {
    expect(clampStockPrepPullBatchSettingsState(answer())).not.toBeNull()
    const bad: Array<[string, Record<string, unknown>]> = [
      ['a token outside the vocabulary', { tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, firstPullBatchRule: 'off' }, source: 'tenant', version: 1 } }],
      ['another vocabulary', { vocabulary: { ...PB.PULL_BATCH_CONFIG_VALUES, labelFormat: ['ordinal_date', 'ordinal', 'date'] } }],
      ['another fixed fact', { fixedFacts: { ...PB.PULL_BATCH_FIXED_FACTS, formalExport: 'included' } }],
      ['another built-in', { builtIn: { ...PB.DEFAULT_PULL_BATCH_CONFIG, placement: 'right' } }],
      ['a non-integer version', { tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG }, source: 'tenant', version: 1.5 } }],
      ['a half-captured row', { sheets: [sheetRow('S-01', { captured: null })] }],
      ['a may.set the state contradicts', { sheets: [sheetRow('S-01', { locks: { firstPullBatchRule: true, labelFormat: true, landing: false, placement: true } })] }],
      ['an archived row offered for edit', { sheets: [sheetRow('S-01', { registryStatus: 'archived' })] }],
      ['help missing', { help: { firstPullBatchRule: { material: { 'zh-CN': 'x', en: 'x' } } } }],
    ]
    for (const [label, over] of bad) expect(clampStockPrepPullBatchSettingsState(answer(over)), label).toBeNull()
  })

  it('changedPullBatchSettingsPatch keeps only the moved keys', () => {
    expect(changedPullBatchSettingsPatch({ ...PB.DEFAULT_PULL_BATCH_CONFIG }, { ...PB.DEFAULT_PULL_BATCH_CONFIG })).toEqual({})
    expect(changedPullBatchSettingsPatch({ ...PB.DEFAULT_PULL_BATCH_CONFIG }, { ...PB.DEFAULT_PULL_BATCH_CONFIG, placement: 'right' })).toEqual({ placement: 'right' })
  })
})

// ---------------------------------------------------------------------------
// PBS-INVISIBLE
// ---------------------------------------------------------------------------

describe('PBS-INVISIBLE (C6) — off is invisible', () => {
  for (const code of ['STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED', 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED', 'VERIFY_UNMOCKED_ROUTE']) {
    it(`a 404 ${code} renders nothing — no card, no line`, async () => {
      serve(() => refused(404, code))
      const host = mount({ scope: SCOPE, class: 'stock-prep-install__card' })
      await flush()
      expect(host.innerHTML.replace(/<!--[\s\S]*?-->/g, '').trim()).toBe('')
      expect(host.querySelector('.stock-prep-install__card')).toBeNull()
      expect(await loadStockPreparationPullBatchSettings(createStockPreparationPullBatchSettingsApi(SCOPE))).toEqual({ kind: 'disabled' })
    })
  }

  it('nothing renders while the read is in flight', async () => {
    let release: (value: Response) => void = () => {}
    serve(() => new Promise<Response>((resolve) => { release = resolve }))
    const host = mount()
    await flush()
    expect(host.innerHTML.replace(/<!--[\s\S]*?-->/g, '').trim()).toBe('')
    release(ok(answer()))
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-status')).not.toBeNull()
  })

  it('a caller below stock-prep:admin makes ZERO requests and renders nothing', async () => {
    for (const permissions of [[], ['stock-prep:read'], ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']]) {
      h.permissions = permissions
      h.apiFetch.mockReset()
      serve(() => ok(answer()))
      const host = mount()
      await flush()
      expect(h.apiFetch).not.toHaveBeenCalled()
      expect(host.innerHTML.replace(/<!--[\s\S]*?-->/g, '').trim()).toBe('')
    }
  })

  it('a non-404 refusal is one plain line with the copyable code', async () => {
    serve(() => refused(503, 'STOCK_PREP_PULL_BATCH_STORE_FAILED'))
    const host = mount()
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-status')).toBeNull()
    const line = testid(host, 'stock-prep-pull-batch-settings-refused')!
    expect(line.textContent).toContain(STOCK_PREP_PULL_BATCH_SETTINGS_PLAIN.read_refused.zh)
    expect(line.textContent).toContain('STOCK_PREP_PULL_BATCH_STORE_FAILED')
  })
})

// ---------------------------------------------------------------------------
// PBS-RENDER
// ---------------------------------------------------------------------------

describe('PBS-RENDER — the four settings, the source, the fixed facts, the help', () => {
  it('labels, options, 「（默认）」 marks on the built-in values, the built-in source badge', async () => {
    serve(() => ok(answer()))
    const host = mount()
    await flush()
    const root = testid(host, 'stock-prep-pull-batch-settings-status')!
    expect(root.dataset.source).toBe('built_in')
    expect(root.textContent).toContain('批次标识设置')
    expect(testid(host, 'stock-prep-pull-batch-settings-source')!.textContent).toContain('当前:系统默认(10-27 方案)')
    const settings = all(host, 'stock-prep-pull-batch-settings-setting')
    expect(settings.map((node) => node.dataset.key)).toEqual(['firstPullBatchRule', 'labelFormat', 'landing', 'placement'])
    expect(settings.map((node) => node.querySelector('legend')!.textContent!.trim())).toEqual(['首次批次判定', '批次格式', '打开表时的默认视图', '两列位置'])
    const options = all(host, 'stock-prep-pull-batch-settings-option').map((node) => `${node.dataset.key}=${node.dataset.value}`)
    expect(options).toEqual([
      'firstPullBatchRule=material', 'firstPullBatchRule=predecessor_suffix', 'labelFormat=ordinal_date', 'labelFormat=ordinal',
      'landing=promote_prep_fill', 'landing=keep_current', 'placement=left', 'placement=right',
    ])
    for (const [key, value] of Object.entries(PB.DEFAULT_PULL_BATCH_CONFIG)) {
      const option = host.querySelector(`[data-testid="stock-prep-pull-batch-settings-option"][data-key="${key}"][data-value="${value}"]`)!
      expect(option.querySelector('[data-testid="stock-prep-pull-batch-settings-default-mark"]'), `${key}=${value}`).not.toBeNull()
      expect((option.querySelector('input') as HTMLInputElement).checked).toBe(true)
    }
    expect(all(host, 'stock-prep-pull-batch-settings-default-mark')).toHaveLength(4)
    expect(host.textContent).toContain('按物料')
    expect(host.textContent).toContain('按位置')
    expect(host.textContent).toContain('第2批（2026-11-07）')
    expect(testid(host, 'stock-prep-pull-batch-settings-help')!.textContent).toContain('不表示这一行已经备过料')
    expect(host.querySelector('[data-testid="stock-prep-pull-batch-settings-help"][data-key="placement"]')!.textContent).toContain('这里的默认值不能代替那次选择')
  })

  it('the rule-F help is the ANSWER\'s (C10: today\'s 有效 state), not a web copy', async () => {
    const help = JSON.parse(JSON.stringify(PB.PULL_BATCH_SETTINGS_HELP))
    serve(() => ok(answer({ help })))
    const host = mount()
    await flush()
    const ruleF = host.querySelector('[data-testid="stock-prep-pull-batch-settings-rule-help"][data-value="predecessor_suffix"]')!
    expect(ruleF.textContent).toContain('今天的「有效」状态')
    expect(ruleF.textContent).toBe(PB.PULL_BATCH_SETTINGS_HELP.firstPullBatchRule.predecessor_suffix['zh-CN'])
    unmountAll()
    help.firstPullBatchRule.predecessor_suffix['zh-CN'] = '按位置：合成的帮助文本。'
    serve(() => ok(answer({ help })))
    const again = mount()
    await flush()
    expect(again.querySelector('[data-testid="stock-prep-pull-batch-settings-rule-help"][data-value="predecessor_suffix"]')!.textContent).toBe('按位置：合成的帮助文本。')
  })

  it('the tenant source badge carries its version; the four 「不可配置」 facts', async () => {
    serve(() => ok(answer({ tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, labelFormat: 'ordinal' }, source: 'tenant', version: 4 } })))
    const host = mount()
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-source')!.textContent).toContain('当前:本租户设置(第 4 版)')
    expect((host.querySelector('[data-testid="stock-prep-pull-batch-settings-option"][data-key="labelFormat"][data-value="ordinal"] input') as HTMLInputElement).checked).toBe(true)
    const facts = all(host, 'stock-prep-pull-batch-settings-fixed-fact')
    expect(facts.map((node) => node.dataset.fact)).toEqual(['pullBatchMeaning', 'formalExport', 'trashedRowsAreEvidence', 'firstPullBatchColumn'])
    for (const node of facts) expect(node.textContent).toContain('不可配置')
    expect(facts[0].textContent).toContain('本次拉取 = 建立这一行的那次拉取')
    expect(facts[1].textContent).toContain('正式导出不含这两列')
    expect(facts[2].textContent).toContain('回收站里的行不算「出现过」')
    expect(facts[3].textContent).toContain('首次批次列总是显示')
  })

  it('English locale reads the English lines', async () => {
    h.locale = 'en'
    serve(() => ok(answer()))
    const host = mount()
    await flush()
    expect(host.textContent).toContain('Pull-batch settings')
    expect(host.querySelector('[data-testid="stock-prep-pull-batch-settings-rule-help"][data-value="predecessor_suffix"]')!.textContent).toBe(PB.PULL_BATCH_SETTINGS_HELP.firstPullBatchRule.predecessor_suffix.en)
  })
})

// ---------------------------------------------------------------------------
// PBS-SAVE
// ---------------------------------------------------------------------------

describe('PBS-SAVE — the tenant default', () => {
  it('Save is disabled with no change; changing only the placement sends exactly { expectedVersion, placement }; success says the version and re-reads', async () => {
    let version = 0
    serve((url, init) => {
      if (init?.method === 'POST') {
        version += 1
        return ok({ tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, placement: 'right' }, source: 'tenant', version }, written: true, changedKeys: ['placement'] })
      }
      return ok(answer(version ? { tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, placement: 'right' }, source: 'tenant', version } } : {}))
    })
    const host = mount()
    await flush()
    const save = testid(host, 'stock-prep-pull-batch-settings-set') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    choose(host, 'stock-prep-pull-batch-settings-option', 'placement', 'right')
    await flush()
    expect(save.disabled).toBe(false)
    save.click()
    await flush()
    const posts = calls().filter(([, method]) => method === 'POST')
    expect(posts).toEqual([[SETTINGS_URL, 'POST', { expectedVersion: 0, placement: 'right' }]])
    expect(testid(host, 'stock-prep-pull-batch-settings-result')!.dataset.result).toBe('saved')
    expect(testid(host, 'stock-prep-pull-batch-settings-result')!.textContent).toContain('已保存(第 1 版)')
    expect(calls().filter(([, method]) => method === 'GET')).toHaveLength(2)
    expect(testid(host, 'stock-prep-pull-batch-settings-source')!.textContent).toContain('第 1 版')
  })

  it('a version conflict says so and re-reads', async () => {
    serve((_url, init) => (init?.method === 'POST' ? refused(409, 'STOCK_PREP_PULL_BATCH_SETTINGS_VERSION_CONFLICT') : ok(answer())))
    const host = mount()
    await flush()
    choose(host, 'stock-prep-pull-batch-settings-option', 'firstPullBatchRule', 'predecessor_suffix')
    await flush()
    ;(testid(host, 'stock-prep-pull-batch-settings-set') as HTMLButtonElement).click()
    await flush()
    const line = testid(host, 'stock-prep-pull-batch-settings-result')!
    expect(line.dataset.result).toBe('conflict')
    expect(line.textContent).toContain('设置刚被别人改过,请刷新后再改。')
    expect(calls().filter(([, method]) => method === 'GET')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// PBS-SHEETS
// ---------------------------------------------------------------------------

describe('PBS-SHEETS — one row per state', () => {
  it('not captured / unlocked / locked / archived, landing and placement applied or not; the edit control only on the unlocked active row', async () => {
    serve(() => ok(answer()))
    const host = mount()
    await flush()
    const rows = all(host, 'stock-prep-pull-batch-settings-sheet-row')
    expect(rows.map((row) => row.dataset.project)).toEqual(['S-01', 'S-02', 'S-03', 'S-04'])
    const lock = (projectNo: string) => rowOf(host, projectNo).querySelector('[data-testid="stock-prep-pull-batch-settings-sheet-lock"]') as HTMLElement
    expect(lock('S-01').dataset.lock).toBe('unlocked')
    expect(lock('S-01').textContent).toContain('未锁定:本表还没有批次,可改')
    expect(lock('S-02').dataset.lock).toBe('locked')
    expect(lock('S-02').textContent).toContain('已锁定:本表已有批次标签,改了会让一张表混用两种含义')
    expect(rowOf(host, 'S-02').querySelector('[data-testid="stock-prep-pull-batch-settings-sheet-locked-at"]')!.textContent).toMatch(/^锁定于 2026-11-07 \d\d:\d\d$/)
    expect(lock('S-03').dataset.lock).toBe('not_captured')
    expect(lock('S-03').textContent).toContain('安装时采用')
    expect(rowOf(host, 'S-03').textContent).toContain('这张表还没有记下设置')
    expect(lock('S-04').dataset.lock).toBe('archived')
    expect(lock('S-04').textContent).toContain('已归档')
    expect((rowOf(host, 'S-01').querySelector('[data-testid="stock-prep-pull-batch-settings-sheet-landing"]') as HTMLElement).textContent).toContain('尚未应用(安装时按默认值)')
    expect((rowOf(host, 'S-01').querySelector('[data-testid="stock-prep-pull-batch-settings-sheet-placement"]') as HTMLElement).textContent).toContain('已应用,已锁定')
    expect(rowOf(host, 'S-02').textContent).toContain('English')
    expect(rowOf(host, 'S-01').textContent).toContain('中文')
    expect(rowOf(host, 'S-03').textContent).toContain('—')
    const editors = all(host, 'stock-prep-project-pull-batch-settings-set')
    expect(editors).toHaveLength(1)
    expect(rowOf(host, 'S-01').contains(editors[0])).toBe(true)
    // Values-free in the DOM: no sheet handle is rendered.
    expect(host.innerHTML).not.toContain('sheet_syn_')
  })
})

// ---------------------------------------------------------------------------
// PBS-SHEET-EDIT
// ---------------------------------------------------------------------------

describe('PBS-SHEET-EDIT — one captured, unlocked sheet', () => {
  async function openForm(host: HTMLElement): Promise<void> {
    ;(testid(host, 'stock-prep-project-pull-batch-settings-set') as HTMLButtonElement).click()
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-form')).not.toBeNull()
  }

  it('a typed mismatch sends nothing; a match sends { confirmProjectNo, expectedVersion, firstPullBatchRule } to the project path with no query', async () => {
    serve((_url, init) => (init?.method === 'POST'
      ? ok({ sheet: sheetRow('S-01', { captured: { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal_date', landing: null, placement: 'left' }, version: 1 }), written: true })
      : ok(answer())))
    const host = mount()
    await flush()
    await openForm(host)
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-form')!.textContent).toContain('请输入项目号 S-01 以确认')
    const save = testid(host, 'stock-prep-pull-batch-settings-sheet-save') as HTMLButtonElement
    choose(host, 'stock-prep-pull-batch-settings-sheet-option', 'firstPullBatchRule', 'predecessor_suffix')
    type(host, 'S-0')
    await flush()
    expect(save.disabled).toBe(true)
    save.click()
    await flush()
    expect(calls().filter(([, method]) => method === 'POST')).toEqual([])
    type(host, ' S-01 ')
    await flush()
    expect(save.disabled).toBe(false)
    save.click()
    await flush()
    expect(calls().filter(([, method]) => method === 'POST')).toEqual([
      ['/api/integration/stock-preparation/projects/S-01/target/pull-batch/settings', 'POST', { confirmProjectNo: 'S-01', expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' }],
    ])
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-form')).toBeNull()
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-result')!.dataset.result).toBe('saved')
  })

  it('CONFIG_LOCKED names the locked keys in words and re-reads; NOT_CAPTURED has its own line', async () => {
    let refusal: Response = refused(409, 'STOCK_PREP_PULL_BATCH_CONFIG_LOCKED', { locked: ['labelFormat', 'notAKey'] })
    serve((_url, init) => (init?.method === 'POST' ? refusal : ok(answer())))
    const host = mount()
    await flush()
    await openForm(host)
    choose(host, 'stock-prep-pull-batch-settings-sheet-option', 'labelFormat', 'ordinal')
    type(host, 'S-01')
    await flush()
    ;(testid(host, 'stock-prep-pull-batch-settings-sheet-save') as HTMLButtonElement).click()
    await flush()
    const line = testid(host, 'stock-prep-pull-batch-settings-sheet-result')!
    expect(line.dataset.result).toBe('locked')
    expect(line.textContent).toContain('「批次格式」 已锁定,不能再改。')
    expect(line.textContent).not.toContain('notAKey')
    expect(calls().filter(([, method]) => method === 'GET')).toHaveLength(2)
    refusal = refused(409, 'STOCK_PREP_PULL_BATCH_SETTINGS_NOT_CAPTURED')
    await openForm(host)
    choose(host, 'stock-prep-pull-batch-settings-sheet-option', 'labelFormat', 'ordinal')
    type(host, 'S-01')
    await flush()
    ;(testid(host, 'stock-prep-pull-batch-settings-sheet-save') as HTMLButtonElement).click()
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-result')!.dataset.result).toBe('not_captured')
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-result')!.textContent).toContain('这张表还没有记下设置;请改默认值,安装时会采用。')
  })
})

// ---------------------------------------------------------------------------
// PBS-STRADDLE
// ---------------------------------------------------------------------------

describe('PBS-STRADDLE — a per-sheet form acts only for the scope and session it was opened under', () => {
  beforeEach(() => {
    localStorage.setItem('auth_token', 'synthetic-session-pbs-a')
  })
  afterEach(() => {
    localStorage.removeItem('auth_token')
  })

  function serveDefault(): void {
    serve((_url, init) => (init?.method === 'POST' ? ok({ sheet: sheetRow('S-01', { version: 1 }), written: true }) : ok(answer())))
  }

  async function openTyped(host: HTMLElement): Promise<void> {
    ;(testid(host, 'stock-prep-project-pull-batch-settings-set') as HTMLButtonElement).click()
    await flush()
    choose(host, 'stock-prep-pull-batch-settings-sheet-option', 'labelFormat', 'ordinal')
    type(host, 'S-01')
    await flush()
    expect((testid(host, 'stock-prep-pull-batch-settings-sheet-save') as HTMLButtonElement).disabled).toBe(false)
  }

  it('a scope move (tenant, then workspace) closes the form, re-reads and writes nothing', async () => {
    serveDefault()
    const props = ref<{ scope: Record<string, string> }>({ scope: { ...SCOPE } })
    const { host } = mountReactive(() => ({ scope: props.value.scope }))
    await flush()
    for (const scope of [{ ...SCOPE, tenantId: 'tenant-syn-other' }, { ...SCOPE, workspaceId: 'workspace-syn-other' }]) {
      props.value = { scope: { ...SCOPE } }
      await flush()
      await openTyped(host)
      const gets = calls().filter(([, method]) => method === 'GET').length
      props.value = { scope }
      await flush()
      expect(testid(host, 'stock-prep-pull-batch-settings-sheet-form'), JSON.stringify(scope)).toBeNull()
      expect(calls().filter(([, method]) => method === 'GET').length).toBe(gets + 1)
    }
    expect(calls().filter(([, method]) => method === 'POST')).toEqual([])
  })

  it('another principal takes the session (notified): the form closes, the panel re-reads, nothing is written', async () => {
    serveDefault()
    const host = mount()
    await flush()
    await openTyped(host)
    localStorage.setItem('auth_token', 'synthetic-session-pbs-b')
    notifyAuthPrincipalChange()
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-form')).toBeNull()
    expect(calls().filter(([, method]) => method === 'GET')).toHaveLength(2)
    expect(calls().filter(([, method]) => method === 'POST')).toEqual([])
  })

  it('another tab replaced the session (no notification): the save click is a cancel — nothing is written', async () => {
    serveDefault()
    const host = mount()
    await flush()
    await openTyped(host)
    localStorage.setItem('auth_token', 'synthetic-session-pbs-c')
    ;(testid(host, 'stock-prep-pull-batch-settings-sheet-save') as HTMLButtonElement).click()
    await flush()
    expect(calls().filter(([, method]) => method === 'POST')).toEqual([])
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-form')).toBeNull()
  })

  it('an answer that lands after a session switch is not painted', async () => {
    let release: (value: Response) => void = () => {}
    serve((_url, init) => (init?.method === 'POST' ? new Promise<Response>((resolve) => { release = resolve }) : ok(answer())))
    const host = mount()
    await flush()
    await openTyped(host)
    ;(testid(host, 'stock-prep-pull-batch-settings-sheet-save') as HTMLButtonElement).click()
    await flush()
    localStorage.setItem('auth_token', 'synthetic-session-pbs-d')
    release(ok({ sheet: sheetRow('S-01', { version: 1 }), written: true }))
    await flush()
    expect(testid(host, 'stock-prep-pull-batch-settings-sheet-result')).toBeNull()
  })

  it('an unmounted panel no longer listens', async () => {
    serveDefault()
    const { app } = mountReactive(() => ({ scope: SCOPE }))
    await flush()
    const before = h.apiFetch.mock.calls.length
    app.unmount()
    apps = apps.filter((entry) => entry.app !== app)
    localStorage.setItem('auth_token', 'synthetic-session-pbs-e')
    notifyAuthPrincipalChange()
    await flush()
    expect(h.apiFetch.mock.calls.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// PBS-ALIGN
// ---------------------------------------------------------------------------

describe('PBS-ALIGN — the three controls render for exactly the actors the server grants', () => {
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

  it('the client rows are BYTE-EQUAL to the plugin\'s and sit as one consecutive slice right after the pull-batch status row', () => {
    const pick = (rows: readonly { capability: string }[]) => rows.filter((row) => PBS_CAPABILITIES.includes(row.capability))
    const server = pick(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES)
    expect(server.map((row: { capability: string }) => row.capability)).toEqual(PBS_CAPABILITIES)
    expect(JSON.stringify(pick(STOCK_PREP_WORKBENCH_CAPABILITIES))).toBe(JSON.stringify(server))
    expect(server.map((row: { code: string; method: string; control: string }) => [row.code, row.method, row.control])).toEqual([
      ['stock-prep:admin', 'GET', 'stock-prep-pull-batch-settings-status'],
      ['stock-prep:admin', 'POST', 'stock-prep-pull-batch-settings-set'],
      ['stock-prep:admin', 'POST', 'stock-prep-project-pull-batch-settings-set'],
    ])
    const order = STOCK_PREP_WORKBENCH_CAPABILITIES.map((row) => row.capability)
    const at = order.indexOf('projectTarget.pullBatchRead')
    expect(order.slice(at, at + 4)).toEqual(['projectTarget.pullBatchRead', ...PBS_CAPABILITIES])
    expect(order).toEqual(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES.map((row: { capability: string }) => row.capability))
  })

  it('status / save / per-sheet edit render iff the SERVER grants them; a non-holder asks nothing', async () => {
    let rendered = 0
    for (const actor of ACTORS) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      h.apiFetch.mockReset()
      serve(() => ok(answer()))
      const granted = serverGranted(actor.roles, actor.permissions)
      expect(grantedStockPrepCapabilities({ roles: actor.roles, permissions: actor.permissions }).filter((id) => PBS_CAPABILITIES.includes(id)), actor.name)
        .toEqual(granted.filter((id: string) => PBS_CAPABILITIES.includes(id)))
      const host = mount()
      await flush()
      expect(testid(host, 'stock-prep-pull-batch-settings-status') !== null, `${actor.name}: status`).toBe(granted.includes('pullBatch.settingsRead'))
      expect(testid(host, 'stock-prep-pull-batch-settings-set') !== null, `${actor.name}: save`).toBe(granted.includes('pullBatch.settingsSet'))
      expect(testid(host, 'stock-prep-project-pull-batch-settings-set') !== null, `${actor.name}: per-sheet edit`).toBe(granted.includes('projectTarget.pullBatchSettingsSet'))
      if (!granted.includes('pullBatch.settingsRead')) expect(h.apiFetch, `${actor.name}: no request`).not.toHaveBeenCalled()
      else rendered += 1
      unmountAll()
    }
    expect(rendered, 'anti-vacuity: both admins render').toBe(2)
  })
})

// ---------------------------------------------------------------------------
// PBS-COPY
// ---------------------------------------------------------------------------

describe('PBS-COPY — the sentences', () => {
  it('every settings code has its own two-line zh + en copy', () => {
    const generic = stockPrepErrorPlain('SOMETHING_NOBODY_THREW')
    for (const code of STOCK_PREP_PULL_BATCH_SETTINGS_ERROR_CODES) {
      const entry = STOCK_PREP_ERROR_PLAIN[code]
      expect(entry, code).toBeTruthy()
      for (const key of ['zh', 'en', 'zhNext', 'enNext'] as const) {
        expect(String(entry[key] ?? '').trim().length, `${code}.${key}`).toBeGreaterThan(0)
      }
      expect(stockPrepErrorPlain(code)).not.toEqual(generic)
    }
  })

  it('one entry per code: the plain table literal spells each settings code exactly once', () => {
    const source = readFileSync(join(__dirname, '../src/services/integration/stockPreparation/plainLanguage.ts'), 'utf8')
    for (const code of STOCK_PREP_PULL_BATCH_SETTINGS_ERROR_CODES) {
      expect(source.match(new RegExp(`^  ${code}: Object\\.freeze\\(`, 'gm')), code).toHaveLength(1)
    }
  })

  it('the two audit modes read their own lines under project_fields_update and are the store\'s spellings', () => {
    expect(Object.values(ST.PULL_BATCH_STORE_AUDIT.modes)).toEqual(expect.arrayContaining(['pull_batch_settings_tenant_updated', 'pull_batch_settings_sheet_updated']))
    expect(ST.PULL_BATCH_STORE_AUDIT.settingsAction).toBe('project_fields_update')
    expect(stockPrepAuditActionPlain('project_fields_update', ST.PULL_BATCH_STORE_AUDIT.modes.tenantSettingsUpdated)!.zh).toBe('改了批次标识的默认设置')
    expect(stockPrepAuditActionPlain('project_fields_update', ST.PULL_BATCH_STORE_AUDIT.modes.sheetSettingsUpdated)!.zh).toBe('改了一个项目表的批次标识设置')
    expect(Object.keys(STOCK_PREP_AUDIT_ACTION_MODE_PLAIN.project_fields_update)).toContain(ST.PULL_BATCH_STORE_AUDIT.modes.tenantSettingsUpdated)
    expect(stockPrepAuditActionPlain('project_fields_update', 'updated')).toBe(STOCK_PREP_AUDIT_ACTION_PLAIN.project_fields_update)
  })

  it('every panel sentence has zh and en', () => {
    for (const [id, entry] of Object.entries(STOCK_PREP_PULL_BATCH_SETTINGS_PLAIN)) {
      expect(entry.zh.trim().length, `${id}.zh`).toBeGreaterThan(0)
      expect(entry.en.trim().length, `${id}.en`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// PBS-MOUNT
// ---------------------------------------------------------------------------

describe('PBS-MOUNT — one mount point on 数据来源与体检; nothing from plugins/', () => {
  const view = readFileSync(join(__dirname, '../src/components/integration/stockPreparation/StockPreparationInstallView.vue'), 'utf8').replace(/\r\n/g, '\n')
  const panel = readFileSync(join(__dirname, '../src/components/integration/stockPreparation/StockPreparationPullBatchSettingsPanel.vue'), 'utf8')
  const service = readFileSync(join(__dirname, '../src/services/integration/stockPreparation/pullBatchSettings.ts'), 'utf8')

  it('the install view mounts the panel exactly once, with the card class and the scope, inside the non-wizard block', () => {
    expect(view.match(/<StockPreparationPullBatchSettingsPanel\b/g)).toHaveLength(1)
    expect(view).toContain('<StockPreparationPullBatchSettingsPanel class="stock-prep-install__card" :scope="props.scope" />')
    const at = view.indexOf('<StockPreparationPullBatchSettingsPanel')
    const block = view.lastIndexOf('<template v-if="props.mode !== \'wizard\'">', at)
    const blockEnd = view.indexOf('\n    </template>\n', block)
    expect(block).toBeGreaterThan(-1)
    expect(at).toBeLessThan(blockEnd)
    // Right after the relabel panel (the other self-gated ADMIN card of this region).
    expect(view.indexOf('<StockPreparationManagedTableRelabelPanel')).toBeLessThan(at)
  })

  it('neither the panel nor its service imports anything from plugins/ (the main image builds apps/web alone)', () => {
    for (const source of [panel, service]) {
      expect(source).not.toMatch(/from ['"][^'"]*plugins\//)
      expect(source).not.toMatch(/require\(['"][^'"]*plugins\//)
    }
  })
})

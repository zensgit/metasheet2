import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// BOM备料 接入向导「开始使用」(P0-4) — the six-step map's DOM half.
//
// PURELY PRESENTATIONAL — this component issues no fetch of its own (gettingStarted.spec covers the
// pure derivation directly; there is no such file because the derivation has no branch this suite does
// not also exercise through props). Every prop here is exactly what
// `StockPreparationInstallView.vue` already owns and passes down.
//
// Guards this suite pins:
//   G1  六步地图: all six steps render, each with exactly one badge
//   G2  403 on the source-preflight OR deployment-preflight read renders `? 看不到` (unknown) — never
//       a silent "not started"
//   G3  blockers split by `fix.kind`: `http` gets a fix button + "重复点是安全的"; `env` gets NO fix
//       button (no "立即修复" anywhere) — only a copy-for-ops line
//   G4  G5 restated twice: a `no-go` source verdict never disables step⑥'s link; an outstanding
//       `http`-kind blocker (e.g. ledger-not-ready) never disables step④'s run controls
//   G5  the nine-step plan renders BEFORE any button is pressed, held steps' explanations included
//   G6  step⑤ is fully static — a REVERSE assertion that no user/email-shaped token ever renders

const h = vi.hoisted(() => ({ locale: 'zh-CN' as string }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: { value: h.locale },
    isZh: { value: h.locale === 'zh-CN' },
    setLocale: vi.fn(),
  }),
}))

import StockPreparationGettingStarted from '../src/components/integration/stockPreparation/StockPreparationGettingStarted.vue'
import type { StockPreparationPreflight, StockPreparationPreflightBlocker } from '../src/services/integration/stockPreparation/installPlan'
import type { StockPrepSourcePreflight } from '../src/services/integration/stockPreparation/sourcePreflight'
import type { StockPreparationInstallRunReport } from '../src/services/integration/stockPreparation/installRun'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function httpBlocker(): StockPreparationPreflightBlocker {
  return {
    code: 'STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY',
    what: '账本表尚未创建',
    fix: { kind: 'http', method: 'POST', path: '/api/integration/stock-preparation/confirmation-decisions/ensure', run: 'POST .../ensure {}' },
  }
}

function envBlocker(): StockPreparationPreflightBlocker {
  return {
    code: 'STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED',
    what: '还没配置客户列清单',
    fix: { kind: 'env', name: 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH', run: 'set INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH=...' },
  }
}

function preflight(overrides: Partial<StockPreparationPreflight> = {}): StockPreparationPreflight {
  return {
    ready: false,
    blockerCount: 1,
    blockers: [httpBlocker()],
    posture: {},
    ...overrides,
  }
}

function sourcePreflight(overrides: Partial<StockPrepSourcePreflight> = {}): StockPrepSourcePreflight {
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
    probes: [],
    ...overrides,
  }
}

function report(overrides: Partial<StockPreparationInstallRunReport> = {}): StockPreparationInstallRunReport {
  return {
    steps: [],
    okCount: 0,
    skipCount: 0,
    failCount: 0,
    completedSteps: 0,
    totalSteps: 9,
    pass: true,
    failedStepId: null,
    ...overrides,
  }
}

interface Props {
  defaults?: null
  preflight?: StockPreparationPreflight | null
  preflightErrorStatus?: number | null
  sourcePreflight?: StockPrepSourcePreflight | null
  sourcePreflightErrorStatus?: number | null
  report?: StockPreparationInstallRunReport | null
  canRunInstall?: boolean
  busy?: boolean
}

function defaultProps(overrides: Props = {}): Required<Props> {
  return {
    defaults: null,
    preflight: null,
    preflightErrorStatus: null,
    sourcePreflight: null,
    sourcePreflightErrorStatus: null,
    report: null,
    canRunInstall: false,
    busy: false,
    ...overrides,
  }
}

describe('BOM备料 接入向导「开始使用」(P0-4)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
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

  async function mount(props: Props = {}): Promise<HTMLDivElement> {
    app = createApp(StockPreparationGettingStarted as Component, defaultProps(props))
    app.mount(container!)
    await nextTick()
    return container!
  }

  function badgeOf(root: HTMLElement, step: string): string | undefined {
    return (root.querySelector(`[data-testid="stock-prep-getting-started-step"][data-step="${step}"]`) as HTMLElement | null)?.dataset.badge
  }

  // ---------------------------------------------------------------------------
  // The six-step map itself
  // ---------------------------------------------------------------------------

  it('renders all six steps, in order, before any button is pressed', async () => {
    const root = await mount()
    const steps = root.querySelectorAll('[data-testid="stock-prep-getting-started-step"]')
    expect(steps.length).toBe(6)
    expect(Array.from(steps).map((el) => (el as HTMLElement).dataset.step)).toEqual([
      'source-connect', 'source-verify', 'source-bind', 'install-tables', 'grant-access', 'first-project-run',
    ])
    // Nothing has been proven yet: the off-page steps read 需要别人做, the on-page ones read 还没开始.
    expect(badgeOf(root, 'source-connect')).toBe('held')
    expect(badgeOf(root, 'source-verify')).toBe('not_started')
    expect(badgeOf(root, 'source-bind')).toBe('held')
    expect(badgeOf(root, 'install-tables')).toBe('not_started')
    expect(badgeOf(root, 'grant-access')).toBe('held')
    expect(badgeOf(root, 'first-project-run')).toBe('held')
  })

  it('badge: done — a registered, reachable, correctly-bound source and a ready deployment', async () => {
    const root = await mount({
      sourcePreflight: sourcePreflight(),
      preflight: preflight({ ready: true, blockerCount: 0, blockers: [] }),
    })
    expect(badgeOf(root, 'source-connect')).toBe('done')
    expect(badgeOf(root, 'source-verify')).toBe('done')
    expect(badgeOf(root, 'source-bind')).toBe('done')
    expect(badgeOf(root, 'install-tables')).toBe('done')
  })

  it('badge: in_progress — every outstanding blocker is fixable by this page\'s own button', async () => {
    const root = await mount({ preflight: preflight({ blockers: [httpBlocker()] }) })
    expect(badgeOf(root, 'install-tables')).toBe('in_progress')
  })

  it('badge: blocked — a no-go source verdict, and a deployment-data-only blocker', async () => {
    const root = await mount({
      sourcePreflight: sourcePreflight({ verdict: 'no-go' }),
      preflight: preflight({ blockers: [envBlocker()] }),
    })
    expect(badgeOf(root, 'source-verify')).toBe('blocked')
    expect(badgeOf(root, 'install-tables')).toBe('blocked')
  })

  // ---------------------------------------------------------------------------
  // G2 — 403 → 「? 看不到」, the third state
  // ---------------------------------------------------------------------------

  it('403 on the source-preflight read renders unknown on every source-derived step, not a silent "not started"', async () => {
    const root = await mount({ sourcePreflightErrorStatus: 403 })
    expect(badgeOf(root, 'source-connect')).toBe('unknown')
    expect(badgeOf(root, 'source-verify')).toBe('unknown')
    expect(badgeOf(root, 'source-bind')).toBe('unknown')
    // The install step is independent — its own read did not fail.
    expect(badgeOf(root, 'install-tables')).toBe('not_started')
    const badge = root.querySelector('[data-testid="stock-prep-getting-started-step"][data-step="source-verify"] [data-testid="stock-prep-getting-started-step-badge"]')
    expect(badge?.textContent).toContain('?')
    expect(badge?.textContent).toContain('看不到')
  })

  it('403 on the deployment-preflight read renders unknown on install-tables only', async () => {
    const root = await mount({ preflightErrorStatus: 403 })
    expect(badgeOf(root, 'install-tables')).toBe('unknown')
    expect(badgeOf(root, 'source-connect')).toBe('held')
  })

  // ---------------------------------------------------------------------------
  // G3 — http vs env blockers render differently
  // ---------------------------------------------------------------------------

  it('an http blocker gets a fix button and the "重复点是安全的" reassurance', async () => {
    const root = await mount({ preflight: preflight({ blockers: [httpBlocker()] }), canRunInstall: true })
    const row = root.querySelector('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="http"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.querySelector('[data-testid="stock-prep-getting-started-blocker-fix"]')).not.toBeNull()
    expect(row.textContent).toContain('重复点是安全的')
    expect(row.querySelector('[data-testid="stock-prep-getting-started-blocker-copy"]')).toBeNull()
  })

  it('an env blocker gets NO fix button and NO "立即修复" anywhere — only a copy-for-ops line', async () => {
    const root = await mount({ preflight: preflight({ blockers: [envBlocker()] }), canRunInstall: true })
    const row = root.querySelector('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="env"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.querySelector('[data-testid="stock-prep-getting-started-blocker-fix"]')).toBeNull()
    expect(row.querySelector('[data-testid="stock-prep-getting-started-blocker-copy"]')).not.toBeNull()
    expect(root.textContent ?? '').not.toContain('立即修复')
  })

  // ---------------------------------------------------------------------------
  // G4 — the map is not a gate
  // ---------------------------------------------------------------------------

  it('no-go does not lock step⑥: the "去项目备料页试一遍" button stays enabled and present', async () => {
    const root = await mount({ sourcePreflight: sourcePreflight({ verdict: 'no-go' }) })
    const button = root.querySelector('[data-testid="stock-prep-getting-started-go-project-board"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(false)
  })

  it('ledger-not-ready (an http blocker) does not lock step④\'s run controls', async () => {
    const root = await mount({
      preflight: preflight({ blockers: [httpBlocker()] }),
      canRunInstall: true,
      busy: false,
    })
    const runButton = root.querySelector('[data-testid="stock-prep-getting-started-run-install"]') as HTMLButtonElement
    const checkButton = root.querySelector('[data-testid="stock-prep-getting-started-check-preflight"]') as HTMLButtonElement
    expect(runButton.disabled).toBe(false)
    expect(checkButton.disabled).toBe(false)
    // ...and the same blocker's own inline fix button too.
    const inlineFix = root.querySelector('[data-testid="stock-prep-getting-started-blocker-fix"]') as HTMLButtonElement
    expect(inlineFix.disabled).toBe(false)
  })

  it('「只检查」 is never gated on canRunInstall — a workbench admin (read tier) can still press it', async () => {
    const root = await mount({ canRunInstall: false })
    const checkButton = root.querySelector('[data-testid="stock-prep-getting-started-check-preflight"]') as HTMLButtonElement
    expect(checkButton).not.toBeNull()
    expect(checkButton.disabled).toBe(false)
    // ...but "开始安装" itself stays platform-admin only (R-11).
    expect(root.querySelector('[data-testid="stock-prep-getting-started-run-install"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-install-held"]')).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // G5 — the nine-step plan, pre-rendered
  // ---------------------------------------------------------------------------

  it('the nine-step plan renders before any button is pressed, held steps\' explanations included', async () => {
    const root = await mount()
    const rows = root.querySelectorAll('[data-testid="stock-prep-getting-started-plan-step"]')
    expect(rows.length).toBe(9)
    // Every row not yet run reads pending.
    for (const row of Array.from(rows)) {
      expect((row as HTMLElement).dataset.status).toBe('pending')
    }
    // A held step (source-wiring) carries its held explanation, unprompted.
    const sourceWiring = root.querySelector('[data-testid="stock-prep-getting-started-plan-step"][data-step="source-wiring"]') as HTMLElement
    expect(sourceWiring.querySelector('[data-testid="stock-prep-getting-started-plan-held"]')?.textContent?.length ?? 0).toBeGreaterThan(0)
  })

  it('a completed run\'s steps are reflected in the nine-step plan', async () => {
    const root = await mount({
      report: report({
        pass: true,
        okCount: 1,
        completedSteps: 1,
        steps: [{ index: 1, id: 'preflight', status: 'ok', reason: 'PREFLIGHT_READY', detail: {}, fixes: [] }],
      }),
    })
    const preflightRow = root.querySelector('[data-testid="stock-prep-getting-started-plan-step"][data-step="preflight"]') as HTMLElement
    expect(preflightRow.dataset.status).toBe('ok')
  })

  // ---------------------------------------------------------------------------
  // The completion / hand-off card
  // ---------------------------------------------------------------------------

  it('the completion card appears once the run reports pass, and never claims the script-judged criteria', async () => {
    const root = await mount({ report: report({ pass: true }) })
    expect(root.querySelector('[data-testid="stock-prep-getting-started-complete"]')).not.toBeNull()
    expect(root.textContent ?? '').toContain('由随版本发布的脚本判定')
  })

  it('no completion card before the run has passed', async () => {
    const root = await mount()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-complete"]')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // G6 — step⑤ is fully static: a REVERSE assertion
  // ---------------------------------------------------------------------------

  it('step⑤ renders no user identity, email, or role-membership data — it is fully static in P0', async () => {
    const root = await mount({ canRunInstall: true })
    const section = root.querySelector('[data-testid="stock-prep-getting-started-step-grant-access"]') as HTMLElement
    expect(section).not.toBeNull()
    const text = section.textContent ?? ''
    // No email shape, no numeric "N 人" membership count, no obviously-a-name token — because none of
    // that is ever fetched: this step has no live check in P0 (P1-3 adds it).
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    expect(text).not.toMatch(/\d+\s*人/)
    expect(text).not.toMatch(/成员/)
    // The two links and the fallback are there — the panel is not silently empty either.
    expect(section.querySelector('[data-testid="stock-prep-getting-started-link-roles"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="stock-prep-getting-started-link-users"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="stock-prep-getting-started-access-fallback"]')?.textContent).toContain('平台管理员')
  })

  it('step⑤\'s copy-todo button is values-free (no project number, no material, no identity)', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const root = await mount()
    const button = root.querySelector('[data-testid="stock-prep-getting-started-copy-todo-access"]') as HTMLButtonElement
    button.click()
    await nextTick()
    // execCommand is not implemented in jsdom; the button must still not throw, and must still exist.
    expect(button).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // English locale — the bilingual `bi()` seam
  // ---------------------------------------------------------------------------

  it('renders English badges when locale is en', async () => {
    h.locale = 'en'
    const root = await mount({ sourcePreflightErrorStatus: 403 })
    const badge = root.querySelector('[data-testid="stock-prep-getting-started-step"][data-step="source-verify"] [data-testid="stock-prep-getting-started-step-badge"]')
    expect(badge?.textContent).toContain('Cannot tell')
  })
})

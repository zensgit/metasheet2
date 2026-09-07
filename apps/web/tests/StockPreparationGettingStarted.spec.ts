import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// BOM备料 接入向导「开始使用」(P0-4) — the six-step map's DOM half.
//
// PURELY PRESENTATIONAL — this component issues no fetch of its own. Every prop here is exactly what
// `StockPreparationInstallView.vue` already owns and passes down.
//
// Guards this suite pins:
//   G1  六步地图: all six steps render, each with exactly one badge, before any button is pressed
//   G2  THE TWO THIRD STATES, kept apart (G4): a read that FAILED — with ANY status, not only 403 —
//       reads 「? 看不到」; a manual probe NOBODY HAS RUN reads 「未检查」. Neither is 「没完成」, and
//       a 500 on either read must never paint a step red.
//   G3  ①③ project the SOURCE-BINDING envelope (R7), so a deployment that has been bound for months
//       reads 已完成 on first paint — and reads 「? 看不到」, never 「需要别人做」, when nobody could
//       read that envelope.
//   G4  blockers split by `fix.kind`: `http` points at the card's single 「开始安装」 and carries the
//       "重复点是安全的" reassurance; `env` gets NO fix path (no "立即修复" anywhere) — copy only
//   G5  G5 restated twice: a `no-go` source verdict never disables step⑥'s button; an outstanding
//       `http`-kind blocker (e.g. ledger-not-ready) never disables step④'s run controls
//   G6  the held steps' explanations render BEFORE any button is pressed, and the nine-step STATUS
//       list is NOT duplicated here (the install panel below owns it)
//   G7  step⑤'s LIVE role-catalog check (P1-3): four verdicts, none of them 「没完成」, plus a REVERSE
//       assertion that no user/email-shaped token ever renders in ANY of them
//   G8  every copy payload is values-free, asserted on the STRING that reaches the clipboard
//   G9  G1「每屏一个主操作位」: at most one `--primary` button per rendering
//   G10 the hand-off card says only what `report.pass` supports — no trial run, no landing tab

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  copied: [] as string[],
  copyResult: true,
  /**
   * The step⑤ role-catalog read's answer. `null` means the read NEVER SETTLES, which is deliberately
   * the default: every case written before P1-3 asserts this component's FIRST PAINT, and a first
   * paint is by definition the state before any read has come back. Cases that are about the check
   * itself set this and then flush.
   */
  readiness: null as Record<string, unknown> | null,
  readinessCalls: 0,
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: { value: h.locale },
    isZh: { value: h.locale === 'zh-CN' },
    setLocale: vi.fn(),
  }),
}))

// The clipboard seam. Real payloads are asserted here rather than "the button still exists": a copy
// button whose content is never read by a test is a values-free claim nobody checks.
vi.mock('../src/views/plm/plmClipboard', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    h.copied.push(text)
    return h.copyResult
  }),
}))

// The step⑤ read's seam. The SERVICE's own behaviour (403/network/shape → unknown, the 合取, the
// zero-identity projection) is pinned in StockPreparationOnboardingReadiness.spec.ts; here only the
// four verdicts' DOM matters, so the module is replaced with a controllable answer.
vi.mock('../src/services/integration/stockPreparation/onboardingReadiness', async () => {
  const actual = await vi.importActual<typeof import('../src/services/integration/stockPreparation/onboardingReadiness')>(
    '../src/services/integration/stockPreparation/onboardingReadiness',
  )
  return {
    ...actual,
    readStockPrepOnboardingReadiness: vi.fn(async () => {
      h.readinessCalls += 1
      if (h.readiness === null) return new Promise(() => {}) as never
      return h.readiness as never
    }),
  }
})

import StockPreparationGettingStarted from '../src/components/integration/stockPreparation/StockPreparationGettingStarted.vue'
import type { StockPreparationPreflight, StockPreparationPreflightBlocker } from '../src/services/integration/stockPreparation/installPlan'
import type { StockPrepSourcePreflight } from '../src/services/integration/stockPreparation/sourcePreflight'
import type { StockPreparationInstallRunReport } from '../src/services/integration/stockPreparation/installRun'
import { STOCK_PREPARATION_INSTALL_STEPS } from '../src/services/integration/stockPreparation/installRun'
import type { StockPrepGettingStartedBinding } from '../src/services/integration/stockPreparation/gettingStarted'

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

function binding(overrides: Partial<StockPrepGettingStartedBinding> = {}): StockPrepGettingStartedBinding {
  return { effectiveExternalSystemId: 'plm-1', eligibleSourceCount: 1, ...overrides }
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
  binding?: StockPrepGettingStartedBinding | null
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
    binding: null,
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
    h.copied = []
    h.copyResult = true
    h.readiness = null
    h.readinessCalls = 0
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

  /** Let the mounted step⑤ read settle and the DOM catch up. */
  async function flushReadiness(): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve()
      await nextTick()
    }
  }

  /** The projection's shape, as `onboardingReadiness.ts` returns it. */
  function readiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { state: 'ready', roles: [{ name: '备料一线', memberCount: 6 }], roleCount: 1, memberTotal: 6, adminRoleCount: 0, status: null, ...overrides }
  }

  async function mountWithReadiness(answer: Record<string, unknown>, props: Props = {}): Promise<HTMLDivElement> {
    h.readiness = answer
    const root = await mount(props)
    await flushReadiness()
    return root
  }

  function accessBlock(root: HTMLElement): HTMLElement {
    return root.querySelector('[data-testid="stock-prep-getting-started-access-state"]') as HTMLElement
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
    // NOTHING HAS BEEN READ YET, and the three ways of not knowing stay apart (G4):
    // the binding envelope has not arrived → 「? 看不到」; the two manual probes have not been run →
    // 「未检查」; the two off-page steps are somebody's work → 「需要别人做」. None of them is
    // 「还没开始」, a word this vocabulary deliberately does not contain.
    expect(badgeOf(root, 'source-connect')).toBe('unknown')
    expect(badgeOf(root, 'source-verify')).toBe('not_checked')
    expect(badgeOf(root, 'source-bind')).toBe('unknown')
    expect(badgeOf(root, 'install-tables')).toBe('not_checked')
    expect(badgeOf(root, 'grant-access')).toBe('held')
    expect(badgeOf(root, 'first-project-run')).toBe('held')
    expect(root.textContent ?? '').not.toContain('还没开始')
  })

  it('progress counts only 已完成 — 未检查 / 看不到 / 需要别人做 are not progress', async () => {
    const empty = await mount()
    expect(empty.querySelector('[data-testid="stock-prep-getting-started-progress"]')?.textContent).toContain('0/6')
    if (app) app.unmount()
    app = null
    const wired = await mount({
      binding: binding(),
      sourcePreflight: sourcePreflight(),
      preflight: preflight({ ready: true, blockerCount: 0, blockers: [] }),
    })
    // ①②③④ done; ⑤⑥ are held by construction in P0, so 6/6 is unreachable and 4/6 is the truth.
    expect(wired.querySelector('[data-testid="stock-prep-getting-started-progress"]')?.textContent).toContain('4/6')
  })

  // ---------------------------------------------------------------------------
  // G3 — ①③ project the source-binding envelope, not the source preflight's topology check
  // ---------------------------------------------------------------------------

  it('an already-bound deployment reads 已完成 on ①③ from the binding envelope alone — no preflight needed', async () => {
    // This is the "已经装好、天天在跑" deployment: nobody has pressed either preflight button today.
    const root = await mount({ binding: binding({ eligibleSourceCount: 2 }) })
    expect(badgeOf(root, 'source-connect')).toBe('done')
    expect(badgeOf(root, 'source-bind')).toBe('done')
    // ...and the two manual probes still read 未检查, not 卡住了.
    expect(badgeOf(root, 'source-verify')).toBe('not_checked')
    expect(badgeOf(root, 'install-tables')).toBe('not_checked')
  })

  it('the binding envelope answers with 0 eligible / nothing bound → 需要别人做, not 已完成', async () => {
    const root = await mount({ binding: binding({ effectiveExternalSystemId: null, eligibleSourceCount: 0 }) })
    expect(badgeOf(root, 'source-connect')).toBe('held')
    expect(badgeOf(root, 'source-bind')).toBe('held')
  })

  it('no binding answer at all (a workbench admin, whose panel never calls the route) reads 「? 看不到」', async () => {
    const root = await mount({ binding: null, sourcePreflight: sourcePreflight() })
    expect(badgeOf(root, 'source-connect')).toBe('unknown')
    expect(badgeOf(root, 'source-bind')).toBe('unknown')
    // The source preflight, which this caller CAN see the result of, is unaffected.
    expect(badgeOf(root, 'source-verify')).toBe('done')
  })

  it('the evidence column quotes the envelope it came from', async () => {
    const root = await mount({ binding: binding({ eligibleSourceCount: 3 }), preflight: preflight() })
    const evidence = (step: string) => (root.querySelector(
      `[data-testid="stock-prep-getting-started-step"][data-step="${step}"] [data-testid="stock-prep-getting-started-step-evidence"]`,
    ) as HTMLElement | null)?.textContent ?? ''
    expect(evidence('source-connect')).toContain('已登记 3 条')
    expect(evidence('source-bind')).toContain('已绑定')
    expect(evidence('install-tables')).toContain('还差 1 件事')
  })

  // ---------------------------------------------------------------------------
  // Badges
  // ---------------------------------------------------------------------------

  it('badge: done — a bound source, a go verdict and a ready deployment', async () => {
    const root = await mount({
      binding: binding(),
      sourcePreflight: sourcePreflight(),
      preflight: preflight({ ready: true, blockerCount: 0, blockers: [] }),
    })
    expect(badgeOf(root, 'source-connect')).toBe('done')
    expect(badgeOf(root, 'source-verify')).toBe('done')
    expect(badgeOf(root, 'source-bind')).toBe('done')
    expect(badgeOf(root, 'install-tables')).toBe('done')
  })

  it('badge: pending_items — every outstanding blocker is fixable by this page\'s own button', async () => {
    const root = await mount({ preflight: preflight({ blockers: [httpBlocker()] }) })
    expect(badgeOf(root, 'install-tables')).toBe('pending_items')
    // 「还差几件事」, never 「进行中」: nothing is running at this moment.
    const badge = root.querySelector('[data-testid="stock-prep-getting-started-step"][data-step="install-tables"] [data-testid="stock-prep-getting-started-step-badge"]')
    expect(badge?.textContent).toContain('还差')
    expect(badge?.textContent).not.toContain('进行中')
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
  // G2 — a FAILED read is 「? 看不到」 at ANY status, never red and never 未检查
  // ---------------------------------------------------------------------------

  it('403 on the source-preflight read renders unknown on ②, and leaves ①③ to the binding envelope', async () => {
    const root = await mount({ sourcePreflightErrorStatus: 403, binding: binding() })
    expect(badgeOf(root, 'source-verify')).toBe('unknown')
    expect(badgeOf(root, 'source-connect')).toBe('done')
    expect(badgeOf(root, 'source-bind')).toBe('done')
    expect(badgeOf(root, 'install-tables')).toBe('not_checked')
    const badge = root.querySelector('[data-testid="stock-prep-getting-started-step"][data-step="source-verify"] [data-testid="stock-prep-getting-started-step-badge"]')
    expect(badge?.textContent).toContain('?')
    expect(badge?.textContent).toContain('看不到')
  })

  it('a 500 (or a 0 for a network drop) on either read is ALSO 「? 看不到」 — never 卡住了', async () => {
    // The bug this pins: only 403 used to qualify, so a backend that was simply down painted ②④ red
    // and told an administrator to go fix something nobody had checked.
    for (const status of [500, 0, 502]) {
      const root = await mount({ preflightErrorStatus: status, sourcePreflightErrorStatus: status })
      expect(badgeOf(root, 'install-tables')).toBe('unknown')
      expect(badgeOf(root, 'source-verify')).toBe('unknown')
      expect(root.querySelector('[data-testid="stock-prep-getting-started-step"][data-step="install-tables"]')?.getAttribute('data-badge')).not.toBe('blocked')
      if (app) app.unmount()
      app = null
    }
  })

  it('403 on the deployment-preflight read renders unknown on install-tables only', async () => {
    const root = await mount({ preflightErrorStatus: 403, binding: binding() })
    expect(badgeOf(root, 'install-tables')).toBe('unknown')
    expect(badgeOf(root, 'source-connect')).toBe('done')
  })

  // ---------------------------------------------------------------------------
  // G4 — http vs env blockers render differently
  // ---------------------------------------------------------------------------

  it('an http blocker points at the card\'s own button and carries the "重复点是安全的" reassurance', async () => {
    const root = await mount({ preflight: preflight({ blockers: [httpBlocker()] }), canRunInstall: true })
    const row = root.querySelector('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="http"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('重复点是安全的')
    expect(row.querySelector('[data-testid="stock-prep-getting-started-blocker-copy"]')).toBeNull()
    // G1: the action itself is rendered ONCE for this card, at its foot — not per blocker row.
    expect(row.querySelector('button')).toBeNull()
    expect(root.querySelectorAll('[data-testid="stock-prep-getting-started-run-install"]').length).toBe(1)
  })

  it('the http reassurance is suppressed for a reader who cannot see the button it refers to', async () => {
    const root = await mount({ preflight: preflight({ blockers: [httpBlocker()] }), canRunInstall: false })
    expect(root.querySelector('[data-testid="stock-prep-getting-started-blocker-safe-note"]')).toBeNull()
    expect(root.textContent ?? '').not.toContain('重复点是安全的')
  })

  it('an env blocker gets NO fix path and NO "立即修复" anywhere — only a copy-for-ops line', async () => {
    const root = await mount({ preflight: preflight({ blockers: [envBlocker()] }), canRunInstall: true })
    const row = root.querySelector('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="env"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.querySelector('[data-testid="stock-prep-getting-started-blocker-copy"]')).not.toBeNull()
    expect(root.textContent ?? '').not.toContain('立即修复')
  })

  // ---------------------------------------------------------------------------
  // G5 — the map is not a gate
  // ---------------------------------------------------------------------------

  it('no-go does not lock step⑥: the "去项目备料页试一遍" button stays enabled and present', async () => {
    const root = await mount({ sourcePreflight: sourcePreflight({ verdict: 'no-go' }) })
    const button = root.querySelector('[data-testid="stock-prep-getting-started-go-project-board"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(false)
    // ...and the tenancy caveat (wireframe B3's closing ⓘ) is said before the click, not after.
    expect(root.querySelector('[data-testid="stock-prep-getting-started-first-run-tenancy"]')?.textContent).toContain('工厂')
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
  // G9 — one primary action position per screen
  // ---------------------------------------------------------------------------

  it('at most one primary-filled button renders, in every reader\'s view', async () => {
    for (const props of [
      { canRunInstall: true, preflight: preflight() },
      { canRunInstall: false, preflight: preflight() },
      { canRunInstall: true, report: report({ pass: true, skipCount: 5 }) },
    ] as Props[]) {
      const root = await mount(props)
      expect(root.querySelectorAll('.stock-prep-gs__button--primary').length).toBeLessThanOrEqual(1)
      if (app) app.unmount()
      app = null
    }
  })

  // ---------------------------------------------------------------------------
  // G6 — the held steps' explanations, pre-rendered; the status list NOT duplicated
  // ---------------------------------------------------------------------------

  it('the steps that need a person are explained before any button is pressed', async () => {
    const root = await mount()
    const rows = root.querySelectorAll('[data-testid="stock-prep-getting-started-plan-held-step"]')
    const heldDescriptors = STOCK_PREPARATION_INSTALL_STEPS.filter((step) => !step.driven)
    expect(rows.length).toBe(heldDescriptors.length)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of Array.from(rows)) {
      expect((row.querySelector('[data-testid="stock-prep-getting-started-plan-held"]')?.textContent ?? '').length).toBeGreaterThan(0)
    }
    // The summary states the split rather than re-listing nine rows.
    const summary = root.querySelector('[data-testid="stock-prep-getting-started-plan-summary"]')?.textContent ?? ''
    expect(summary).toContain(String(STOCK_PREPARATION_INSTALL_STEPS.length - heldDescriptors.length))
    expect(summary).toContain(String(heldDescriptors.length))
    expect(summary).toContain('跳过不等于失败')
  })

  it('the nine-step STATUS list is not duplicated here — the install panel below owns it', async () => {
    const root = await mount({
      report: report({
        pass: true,
        okCount: 1,
        completedSteps: 1,
        steps: [{ index: 1, id: 'preflight', status: 'ok', reason: 'PREFLIGHT_READY', detail: {}, fixes: [] }],
      }),
    })
    expect(root.querySelectorAll('[data-testid="stock-prep-getting-started-plan-step"]').length).toBe(0)
    expect(root.querySelectorAll('[data-status]').length).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // G10 — the hand-off card claims only what `pass` supports
  // ---------------------------------------------------------------------------

  it('the hand-off card never claims a trial run, and never names a landing tab', async () => {
    // `installRun.ts`: "A run that is all SKIP still passes — held is not broken". So a pass with five
    // SKIPs means tables were created, nothing more. The card must not upgrade that into a trial run,
    // and must not contradict the map above it, where ⑥ still reads 需要别人做.
    const root = await mount({ report: report({ pass: true, okCount: 4, skipCount: 5 }) })
    const card = root.querySelector('[data-testid="stock-prep-getting-started-complete"]') as HTMLElement
    expect(card).not.toBeNull()
    const text = card.textContent ?? ''
    expect(text).not.toContain('真的跑通了一次')
    expect(text).not.toContain('确认队列')
    expect(card.querySelector('[data-testid="stock-prep-getting-started-complete-verdict"]')?.textContent).toContain('没有失败')
    expect(text).toContain('5 步要人来做')
    expect(text).toContain('由随版本发布的脚本判定')
    expect(badgeOf(root, 'first-project-run')).toBe('held')
  })

  it('no hand-off card before the run has passed', async () => {
    const root = await mount()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-complete"]')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // G7 — step⑤'s live role-catalog check (P1-3), four verdicts + the REVERSE assertion
  // ---------------------------------------------------------------------------

  it('step⑤ keeps the three codes, the two links and the hand-off fallback', async () => {
    const root = await mount({ canRunInstall: true })
    const section = root.querySelector('[data-testid="stock-prep-getting-started-step-grant-access"]') as HTMLElement
    expect(section).not.toBeNull()
    const text = section.textContent ?? ''
    // The two codes are named by their real names, not by a third paraphrase (B2).
    expect(text).toContain('stock-prep:read')
    expect(text).toContain('stock-prep:operate')
    expect(text).not.toContain('查看和填写')
    expect(section.querySelector('[data-testid="stock-prep-getting-started-link-roles"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="stock-prep-getting-started-link-users"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="stock-prep-getting-started-access-fallback"]')?.textContent).toContain('平台管理员')
    // F9: the catalog is PLATFORM-wide. Saying 「贵司的配置」 would be false on a multi-tenant host,
    // and the design's own earlier draft said exactly that.
    const scope = section.querySelector('[data-testid="stock-prep-getting-started-access-scope"]')?.textContent ?? ''
    expect(scope).toContain('平台的角色目录')
    expect(scope).not.toContain('租户配置')
    // 2026-09-08 on the customer host: a code ticked straight onto a person is filtered out by the
    // namespace-admission gate and the account still gets refused. The page says so.
    expect(scope).toContain('权限只能通过角色给')
  })

  it('the check runs on mount, before any button on this page has been pressed', async () => {
    await mount()
    expect(h.readinessCalls).toBe(1)
  })

  it('✔ 有角色有人 — names the roles and the headcount, and the map badge flips to 已完成', async () => {
    const root = await mountWithReadiness(readiness({
      roles: [{ name: '备料一线', memberCount: 6 }], roleCount: 1, memberTotal: 6, adminRoleCount: 0,
    }))
    const block = accessBlock(root)
    expect(block.dataset.state).toBe('ready')
    const headline = block.querySelector('[data-testid="stock-prep-getting-started-access-headline"]')?.textContent ?? ''
    expect(headline).toContain('1 个角色')
    expect(headline).toContain('6 人')
    const roles = Array.from(block.querySelectorAll('[data-testid="stock-prep-getting-started-access-role"]'))
    expect(roles).toHaveLength(1)
    expect(roles[0].textContent).toContain('备料一线')
    // A single qualifying role cannot double-count anybody, so that caveat stays off.
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-double-count"]')).toBeNull()
    expect(badgeOf(root, 'grant-access')).toBe('done')
  })

  it('⚠ 有角色但一个人都没有 → NOT ✔ (0 成员 is not ready)', async () => {
    const root = await mountWithReadiness(readiness({
      state: 'no_members', roles: [{ name: '备料一线', memberCount: 0 }], roleCount: 1, memberTotal: 0,
    }))
    const block = accessBlock(root)
    expect(block.dataset.state).toBe('no_members')
    expect(block.dataset.state).not.toBe('ready')
    expect(block.textContent).toContain('一个人都还没有')
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-next"]')?.textContent).toContain('用户管理')
    // 「需要别人做」 — never 已完成, and never 卡住了 (G5: this map is not a gate).
    expect(badgeOf(root, 'grant-access')).toBe('held')
  })

  it('⚠ 还没有任何角色同时持有两码 — says how to build one, naming both codes and both pages', async () => {
    const root = await mountWithReadiness(readiness({
      state: 'no_role', roles: [], roleCount: 0, memberTotal: 0,
    }))
    const block = accessBlock(root)
    expect(block.dataset.state).toBe('no_role')
    const next = block.querySelector('[data-testid="stock-prep-getting-started-access-next"]')?.textContent ?? ''
    expect(next).toContain('角色管理')
    expect(next).toContain('用户管理')
    expect(next).toContain('stock-prep:read')
    expect(next).toContain('stock-prep:operate')
    expect(block.querySelectorAll('[data-testid="stock-prep-getting-started-access-role"]')).toHaveLength(0)
    expect(badgeOf(root, 'grant-access')).toBe('held')
  })

  it('? 看不到 — a caller who cannot read the catalog is told exactly that, and NOT that it is undone', async () => {
    const root = await mountWithReadiness(readiness({
      state: 'unknown', roles: [], roleCount: 0, memberTotal: 0, status: 403,
    }))
    const block = accessBlock(root)
    expect(block.dataset.state).toBe('unknown')
    const text = block.textContent ?? ''
    expect(text).toContain('看不到')
    expect(text).toContain('这不代表没配')
    // The three words this state must never produce.
    expect(text).not.toContain('没完成')
    expect(text).not.toContain('还没开始')
    expect(text).not.toContain('还没配好')
    // …and the status code is NOT rendered as a bare number nobody can act on.
    expect(text).not.toContain('403')
    // The map says 「? 看不到」 too — the card and the badge cannot disagree.
    expect(badgeOf(root, 'grant-access')).toBe('unknown')
    // stock-prep:admin is unknowable too when the catalog is unreadable, so that line stays off.
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-admin-note"]')).toBeNull()
  })

  it('several qualifying roles: the sum is labelled as a sum, and an over-cap catalog says so', async () => {
    const root = await mountWithReadiness(readiness({
      roles: [{ name: '备料一线', memberCount: 6 }, { name: '备料班组长', memberCount: 3 }],
      roleCount: 7,
      memberTotal: 21,
    }))
    const block = accessBlock(root)
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-double-count"]')?.textContent).toContain('数两次')
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-overflow"]')?.textContent).toContain('5 个角色')
  })

  it('the stock-prep:admin line is informational — its absence never changes the verdict', async () => {
    const withAdmin = await mountWithReadiness(readiness({ adminRoleCount: 2 }))
    expect(accessBlock(withAdmin).querySelector('[data-testid="stock-prep-getting-started-access-admin-note"]')?.textContent)
      .toContain('2 个角色')
    if (app) app.unmount()
    app = null
    container!.innerHTML = ''
    h.readinessCalls = 0
    const withoutAdmin = await mountWithReadiness(readiness({ adminRoleCount: 0 }))
    const note = accessBlock(withoutAdmin).querySelector('[data-testid="stock-prep-getting-started-access-admin-note"]')?.textContent ?? ''
    expect(note).toContain('可以不配')
    expect(accessBlock(withoutAdmin).dataset.state).toBe('ready')
  })

  it('「重新检查」 issues the read again', async () => {
    const root = await mountWithReadiness(readiness({ state: 'no_role', roles: [], roleCount: 0, memberTotal: 0 }))
    expect(h.readinessCalls).toBe(1)
    ;(root.querySelector('[data-testid="stock-prep-getting-started-access-recheck"]') as HTMLButtonElement).click()
    await flushReadiness()
    expect(h.readinessCalls).toBe(2)
  })

  it('G5 — no verdict gates anything: every link and button in step⑤ stays live in all four states', async () => {
    for (const state of ['ready', 'no_members', 'no_role', 'unknown'] as const) {
      if (app) app.unmount()
      app = null
      container!.innerHTML = ''
      const root = await mountWithReadiness(readiness({ state, roles: [], roleCount: state === 'ready' ? 1 : 0, memberTotal: state === 'ready' ? 4 : 0 }))
      const section = root.querySelector('[data-testid="stock-prep-getting-started-step-grant-access"]') as HTMLElement
      expect(section.querySelector('[data-testid="stock-prep-getting-started-link-roles"]'), state).not.toBeNull()
      expect((section.querySelector('[data-testid="stock-prep-getting-started-copy-todo-access"]') as HTMLButtonElement).disabled, state).toBe(false)
      // ⑥'s button is on a different card and must not be touched by ⑤'s verdict either.
      expect((root.querySelector('[data-testid="stock-prep-getting-started-go-project-board"]') as HTMLButtonElement).disabled, state).toBe(false)
    }
  })

  // THE REVERSE ASSERTION (设计稿 线框 B2 硬规则): role names and integer counts only. Whatever the
  // verdict, nothing user-shaped may reach the DOM — the projection never carries an identity, so
  // this is a guard against a future widening putting one back.
  it('step⑤ renders NO user identity in any of the four verdicts', async () => {
    const PLANTED = ['u-8f3c19', 'zhang.wei@factory-a.example.com', '张伟']
    for (const state of ['ready', 'no_members', 'no_role', 'unknown'] as const) {
      if (app) app.unmount()
      app = null
      container!.innerHTML = ''
      const root = await mountWithReadiness(readiness({
        state,
        // Only the two fields the projection is allowed to carry, holding values-free content.
        roles: state === 'ready' || state === 'no_members' ? [{ name: '备料一线', memberCount: state === 'ready' ? 6 : 0 }] : [],
        roleCount: state === 'ready' || state === 'no_members' ? 1 : 0,
        memberTotal: state === 'ready' ? 6 : 0,
      }))
      const text = (root.querySelector('[data-testid="stock-prep-getting-started-step-grant-access"]') as HTMLElement).textContent ?? ''
      expect(text, `${state}: no email shape`).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
      for (const planted of PLANTED) {
        expect(text, `${state}: must not render ${planted}`).not.toContain(planted)
      }
      // No user-id-shaped token, and no part/quantity value either (values-free).
      expect(text, state).not.toMatch(/\b(userId|user_id|subjectId|actorId)\b/)
      expect(text, state).not.toMatch(/\d{6,}/)
    }
  })

  // ---------------------------------------------------------------------------
  // G8 — the copy payloads, asserted on the string that reaches the clipboard
  // ---------------------------------------------------------------------------

  const VALUE_SHAPES: Array<[string, RegExp]> = [
    ['an email address', /[\w.+-]+@[\w-]+\.[\w.-]+/],
    ['a bare long digit run (project/part number shape)', /\d{6,}/],
    ['a quantity phrase', /\d+\s*(个|件|pcs)/i],
  ]

  function expectValuesFree(payload: string): void {
    for (const [label, shape] of VALUE_SHAPES) {
      expect(payload, `payload must not contain ${label}: ${payload}`).not.toMatch(shape)
    }
  }

  it('step⑤\'s copy-todo payload is values-free and names the two codes', async () => {
    const root = await mount()
    ;(root.querySelector('[data-testid="stock-prep-getting-started-copy-todo-access"]') as HTMLButtonElement).click()
    await nextTick()
    expect(h.copied).toHaveLength(1)
    const payload = h.copied[0]
    expectValuesFree(payload)
    expect(payload).toContain('stock-prep:read')
    expect(payload).toContain('stock-prep:operate')
  })

  it('the env blocker\'s copy-for-ops payload carries the code, the sentence AND the route\'s own fix line verbatim (I-9)', async () => {
    const root = await mount({ preflight: preflight({ blockers: [envBlocker()] }) })
    ;(root.querySelector('[data-testid="stock-prep-getting-started-blocker-copy"]') as HTMLButtonElement).click()
    await nextTick()
    expect(h.copied).toHaveLength(1)
    const payload = h.copied[0]
    expectValuesFree(payload)
    expect(payload).toContain('STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED')
    expect(payload).toContain(envBlocker().fix!.run)
  })

  it('the hand-off to-do names the outstanding blockers by code, not just "第 4 步卡住了" (线框 F)', async () => {
    const root = await mount({ canRunInstall: false, preflight: preflight({ blockers: [httpBlocker(), envBlocker()] }) })
    ;(root.querySelector('[data-testid="stock-prep-getting-started-copy-todo-install"]') as HTMLButtonElement).click()
    await nextTick()
    const payload = h.copied[0]
    expectValuesFree(payload)
    expect(payload).toContain('STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY')
    expect(payload).toContain('STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED')
  })

  it('the group-chat payload is values-free and does not name a landing tab or claim installation', async () => {
    const root = await mount({ report: report({ pass: true, skipCount: 5 }) })
    ;(root.querySelector('[data-testid="stock-prep-getting-started-copy-handoff"]') as HTMLButtonElement).click()
    await nextTick()
    const payload = h.copied[0]
    expectValuesFree(payload)
    expect(payload).toContain('/stock-prep')
    expect(payload).not.toContain('确认队列')
    expect(payload).not.toContain('装好了')
  })

  it('a host with no copy mechanism at all degrades to "nothing happened" rather than throwing', async () => {
    h.copyResult = false
    const root = await mount()
    const button = root.querySelector('[data-testid="stock-prep-getting-started-copy-todo-access"]') as HTMLButtonElement
    button.click()
    await nextTick()
    expect(button.textContent).toContain('复制一份待办')
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

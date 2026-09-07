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
//   G7  step⑤ is fully static — a REVERSE assertion that no user/email-shaped token ever renders
//   G8  every copy payload is values-free, asserted on the STRING that reaches the clipboard
//   G9  G1「每屏一个主操作位」: at most one `--primary` button per rendering
//   G10 the hand-off card says only what `report.pass` supports — no trial run, no landing tab

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  copied: [] as string[],
  copyResult: true,
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
  // G7 — step⑤ is fully static: a REVERSE assertion
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
    // The two codes are named by their real names, not by a third paraphrase (B2).
    expect(text).toContain('stock-prep:read')
    expect(text).toContain('stock-prep:operate')
    expect(text).not.toContain('查看和填写')
    // The two links and the fallback are there — the panel is not silently empty either.
    expect(section.querySelector('[data-testid="stock-prep-getting-started-link-roles"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="stock-prep-getting-started-link-users"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="stock-prep-getting-started-access-fallback"]')?.textContent).toContain('平台管理员')
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

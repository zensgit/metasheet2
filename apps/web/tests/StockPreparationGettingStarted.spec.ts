import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// BOM备料 接入向导「开始使用」(P0-4) — the seven-step map's DOM half.
//
// PURELY PRESENTATIONAL — this component issues no fetch of its own. Every prop here is exactly what
// `StockPreparationInstallView.vue` already owns and passes down.
//
// Guards this suite pins:
//   G1  七步地图: all seven steps render, each with exactly one badge, before any button is pressed.
//       SEVEN, not six, since 2026-09-10: 整合切片 put 外接数据源 and the connection-draft editor in
//       ONE 数据工厂 section, and the old ① was describing both at once — its sentence was about
//       registering a data source while its badge came from the BINDING envelope, which is silent
//       about whether a data source exists. ①a and ①b now have one read, one badge and one link each.
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
//   G7  step⑤'s LIVE role-catalog check (P1-3): four verdicts, none of them 「没完成」 and none of
//       them 「已完成」 either — the third condition (per-user 「插件使用」 admission) is invisible to
//       this read, so the badge tops out at ⚑ and every actionable verdict names that third step.
//       Plus a REVERSE assertion that no user/email-shaped token ever renders in ANY of them
//   G8  every copy payload is values-free, asserted on the STRING that reaches the clipboard
//   G9  G1「每屏一个主操作位」: at most one `--primary` button per rendering
//   G10 the hand-off card says only what `report.pass` supports — no trial run, no landing tab —
//       and carries step⑤'s live answer, so it can never invite a hand-off the page can already see
//       will land on a 403

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
  /**
   * The step①a data-source-registry read's answer, on the same terms as `readiness` above: `null`
   * means the read NEVER SETTLES, which is the default, so every case written before the ① split
   * keeps asserting a genuine FIRST PAINT.
   */
  registry: null as Record<string, unknown> | null,
  registryCalls: 0,
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

// The step①a read's seam, mocked for the same reason ⑤'s is: the SERVICE's own behaviour
// (403/500/network/HTML/unknown-shape → unknown, the SQL-type filter, the values-free projection) is
// pinned in StockPreparationDataSourceRegistry.spec.ts; here only the badge's DOM matters.
vi.mock('../src/services/integration/stockPreparation/dataSourceRegistry', async () => {
  const actual = await vi.importActual<typeof import('../src/services/integration/stockPreparation/dataSourceRegistry')>(
    '../src/services/integration/stockPreparation/dataSourceRegistry',
  )
  return {
    ...actual,
    readStockPrepDataSourceRegistry: vi.fn(async () => {
      h.registryCalls += 1
      if (h.registry === null) return new Promise(() => {}) as never
      return h.registry as never
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
  return {
    effectiveExternalSystemId: 'plm-1',
    eligibleSourceCount: 1,
    dataSourceBackedSourceCount: 1,
    // The DATA-SOURCE road by default — what ①a/①b are written for. The legacy road has its own
    // case below, and it is the one F06 was about.
    requiredKind: 'data-source:sql-readonly',
    ...overrides,
  }
}

/** The step①a registry projection, as `dataSourceRegistry.ts` returns it. */
function registry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: 'present', sqlCount: 1, totalCount: 1, status: null, ...overrides }
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
  canOpenDataFactory?: boolean
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
    // 整合切片 (2026-09-09): the DEFAULT here mirrors the component's own fail-closed default —
    // a mount that says nothing about 数据工厂 access gets the 「找实施」 sentence, not a link.
    // ①拆分 (2026-09-10): cases that want the LINKED rendering now say `canOpenDataFactory: true`
    // explicitly, which is the honest direction — a `true` default would let a component that lost
    // its gate look correct in every case that did not mention the prop.
    canOpenDataFactory: false,
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
    h.registry = null
    h.registryCalls = 0
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
    return {
      state: 'ready',
      roles: [{ name: '备料一线', memberCount: 6 }],
      roleCount: 1,
      memberTotal: 6,
      adminRoleCount: 0,
      platformAdminRoleCount: 0,
      status: null,
      ...overrides,
    }
  }

  async function mountWithReadiness(answer: Record<string, unknown>, props: Props = {}): Promise<HTMLDivElement> {
    h.readiness = answer
    const root = await mount(props)
    await flushReadiness()
    return root
  }

  /** Same, for step①a's registry read. `flushReadiness` drains both — one microtask pump, two reads. */
  async function mountWithRegistry(answer: Record<string, unknown>, props: Props = {}): Promise<HTMLDivElement> {
    h.registry = answer
    const root = await mount(props)
    await flushReadiness()
    return root
  }

  function accessBlock(root: HTMLElement): HTMLElement {
    return root.querySelector('[data-testid="stock-prep-getting-started-access-state"]') as HTMLElement
  }

  // ---------------------------------------------------------------------------
  // The seven-step map itself
  // ---------------------------------------------------------------------------

  it('renders all seven steps, in order, before any button is pressed', async () => {
    const root = await mount()
    const steps = root.querySelectorAll('[data-testid="stock-prep-getting-started-step"]')
    expect(steps.length).toBe(7)
    expect(Array.from(steps).map((el) => (el as HTMLElement).dataset.step)).toEqual([
      'source-register', 'source-connect', 'source-verify', 'source-bind', 'install-tables', 'grant-access', 'first-project-run',
    ])
    // NOTHING HAS BEEN READ YET, and the three ways of not knowing stay apart (G4):
    // the binding envelope has not arrived → 「? 看不到」; the two manual probes have not been run →
    // 「未检查」; the two off-page steps are somebody's work → 「需要别人做」. None of them is
    // 「还没开始」, a word this vocabulary deliberately does not contain.
    expect(badgeOf(root, 'source-register')).toBe('unknown')
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
    expect(empty.querySelector('[data-testid="stock-prep-getting-started-progress"]')?.textContent).toContain('0/7')
    if (app) app.unmount()
    app = null
    const wiredProps = {
      binding: binding(),
      sourcePreflight: sourcePreflight(),
      preflight: preflight({ ready: true, blockerCount: 0, blockers: [] }),
    }
    // ①a's read never settles here (h.registry === null), so it stays 「? 看不到」 and is NOT
    // progress — which is the point: the denominator grew by one and the numerator did not.
    const wired = await mount(wiredProps)
    expect(wired.querySelector('[data-testid="stock-prep-getting-started-progress"]')?.textContent).toContain('4/7')
    if (app) app.unmount()
    app = null
    // ...and once ①a's read DOES answer 'present', the same deployment reads 5/7. Two steps that
    // used to be one, counted separately: this is the whole reason the split is visible to a reader.
    const withRegistry = await mountWithRegistry(registry(), wiredProps)
    expect(withRegistry.querySelector('[data-testid="stock-prep-getting-started-progress"]')?.textContent).toContain('5/7')
  })

  // ---------------------------------------------------------------------------
  // ① SPLIT (2026-09-10) — ①a and ①b are answered by DIFFERENT reads
  // ---------------------------------------------------------------------------

  it('①a comes from the registry read and ①b from the binding envelope — all four combinations', async () => {
    // (present, bound): both done.
    let root = await mountWithRegistry(registry(), { binding: binding() })
    expect(badgeOf(root, 'source-register')).toBe('done')
    expect(badgeOf(root, 'source-connect')).toBe('done')
    if (app) app.unmount()
    app = null

    // (present, NO binding yet) — THE STATE ONE ROW COULD NOT EXPRESS. A data source is registered
    // and no binding references it: ①a is genuinely done, ①b genuinely is not. The old single step
    // read the binding envelope alone and reported 「需要别人做」 over a sentence about registering.
    root = await mountWithRegistry(registry(), { binding: binding({ effectiveExternalSystemId: null, eligibleSourceCount: 0, dataSourceBackedSourceCount: 0 }) })
    expect(badgeOf(root, 'source-register')).toBe('done')
    expect(badgeOf(root, 'source-connect')).toBe('held')
    if (app) app.unmount()
    app = null

    // (absent, bound) — the legacy-bridge deployment: nothing in `data_sources` this account can
    // see, and a working binding anyway. ①b must NOT be dragged down by ①a.
    root = await mountWithRegistry(registry({ state: 'absent', sqlCount: 0, totalCount: 0 }), { binding: binding() })
    expect(badgeOf(root, 'source-register')).toBe('held')
    expect(badgeOf(root, 'source-connect')).toBe('done')
    if (app) app.unmount()
    app = null

    // (unknown, unknown): the read was refused and the panel never called its route.
    root = await mountWithRegistry(registry({ state: 'unknown', sqlCount: 0, totalCount: 0, status: 403 }), { binding: null })
    expect(badgeOf(root, 'source-register')).toBe('unknown')
    expect(badgeOf(root, 'source-connect')).toBe('unknown')
  })

  it('①a’s evidence is a COUNT scoped to this account, and ①b’s names which road the bindings took', async () => {
    const evidence = (root: HTMLElement, step: string) => (root.querySelector(
      `[data-testid="stock-prep-getting-started-step"][data-step="${step}"] [data-testid="stock-prep-getting-started-step-evidence"]`,
    ) as HTMLElement | null)?.textContent ?? ''

    let root = await mountWithRegistry(registry({ sqlCount: 2, totalCount: 3 }), {
      binding: binding({ eligibleSourceCount: 2, dataSourceBackedSourceCount: 1 }),
    })
    // 「本账号看得到」, not 「这台机器上有」: the list is owner-scoped (#5401), so 0 would mean
    // 「this account sees none」 and promoting that into 「none exists」 would be a claim nobody can back.
    expect(evidence(root, 'source-register')).toContain('2')
    expect(evidence(root, 'source-register')).toContain('本账号')
    expect(evidence(root, 'source-connect')).toContain('已登记 2 条')
    expect(evidence(root, 'source-connect')).toContain('1 条走外接数据源')
    if (app) app.unmount()
    app = null

    // A data-source-road deployment with no data-source-backed candidate YET still reads done on
    // ①b — badging it 「没完成」 would tell an administrator to redo working work. The wording is
    // 「尚未」, not 「都是旧式桥接」: F06 was that the old sentence described a legacy deployment's
    // correct configuration as a shortfall, and the legacy case has its own wording now.
    root = await mountWithRegistry(registry(), { binding: binding({ eligibleSourceCount: 1, dataSourceBackedSourceCount: 0 }) })
    expect(badgeOf(root, 'source-connect')).toBe('done')
    expect(evidence(root, 'source-connect')).toContain('尚未有一条走外接数据源')
    if (app) app.unmount()
    app = null

    // ①a says NOTHING when it cannot tell — the badge already says 「? 看不到」.
    root = await mountWithRegistry(registry({ state: 'unknown', sqlCount: 0, status: 500 }))
    expect(evidence(root, 'source-register')).toBe('')
  })

  // F06 (2026-09-10 对抗复核) — THE FIFTH COMBINATION. A `bridge:legacy-sql-readonly` deployment
  // can never be offered a `data-source:sql-readonly` system (the server narrows `eligibleSources`
  // to the action's own frozen kind), so ①a/①b are not its steps at all. Before the fix this
  // deployment was told to go register a data source the action cannot use, and ①b's evidence
  // described its working configuration as a shortfall.
  it('a legacy-bridge deployment is told ①a/①b do not apply — not told to go register a data source', async () => {
    const legacy = binding({ requiredKind: 'bridge:legacy-sql-readonly', dataSourceBackedSourceCount: 0 })
    // The registry says `absent` — which, on the data-source road, would be 「需要别人做」. Here it
    // must NOT be: the action cannot use a data source, so there is nothing outstanding.
    const root = await mountWithRegistry(registry({ state: 'absent', sqlCount: 0, totalCount: 0 }), { binding: legacy })

    expect(badgeOf(root, 'source-register')).toBe('done')
    expect(badgeOf(root, 'source-connect')).toBe('done')

    // ONE sentence replaces BOTH instructions...
    const notice = root.querySelector('[data-testid="stock-prep-getting-started-step-source-legacy-bridge"]')
    expect(notice, 'the legacy deployment must be told which road it is on').toBeTruthy()
    expect(notice?.textContent).toContain('不适用')
    expect(notice?.textContent).toContain('bridge:legacy-sql-readonly')
    // ...and neither instruction, nor either link, is on screen to be followed.
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-register"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-connect"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-connection-draft"]')).toBeNull()

    // G5: the MAP is untouched — seven rows, and the ✔ on ①a is never bare.
    expect(root.querySelectorAll('[data-testid="stock-prep-getting-started-step"]').length).toBe(7)
    const evidence = (step: string) => (root.querySelector(
      `[data-testid="stock-prep-getting-started-step"][data-step="${step}"] [data-testid="stock-prep-getting-started-step-evidence"]`,
    ) as HTMLElement | null)?.textContent ?? ''
    expect(evidence('source-register')).toContain('不适用')
    // ①b's evidence names the road WITHOUT calling it a shortfall — the exact wording F06 objected to.
    expect(evidence('source-connect')).toContain('本部署就是走旧式桥接')
    expect(evidence('source-connect')).not.toContain('不经外接数据源')
  })

  it('the data-source road is unaffected: requiredKind data-source:sql-readonly still drives ①a/①b', async () => {
    // The negative half of the case above — without it, hard-coding `legacyBridge = true` would pass.
    const root = await mountWithRegistry(registry({ state: 'absent', sqlCount: 0, totalCount: 0 }), { binding: binding() })
    expect(badgeOf(root, 'source-register')).toBe('held')
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-legacy-bridge"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-register"]')).toBeTruthy()
  })

  // Review item 5 — THE PATH NOBODY WAS LOOKING AT. `stock-prep:admin` is the documented reader of
  // 「开始使用」 and holds no `data_sources:read`, so ①a's read 403s EVERY time for them: the badge
  // is permanently 「? 看不到」 and progress tops out at 6/7. That is honest, but an unexplained
  // permanent shrug on the page's primary audience is not. The 403 gets a REASON; other failures
  // keep the bare badge, because for those the page genuinely does not know why.
  it('①a’s 403 says which permission is missing; a 500 stays a bare 「? 看不到」', async () => {
    const evidence = (root: HTMLElement) => (root.querySelector(
      '[data-testid="stock-prep-getting-started-step"][data-step="source-register"] [data-testid="stock-prep-getting-started-step-evidence"]',
    ) as HTMLElement | null)?.textContent ?? ''

    let root = await mountWithRegistry(registry({ state: 'unknown', sqlCount: 0, totalCount: 0, status: 403 }))
    expect(badgeOf(root, 'source-register')).toBe('unknown')
    expect(evidence(root)).toContain('data_sources:read')
    expect(evidence(root)).toContain('实施')
    if (app) app.unmount()
    app = null

    root = await mountWithRegistry(registry({ state: 'unknown', sqlCount: 0, totalCount: 0, status: 500 }))
    expect(badgeOf(root, 'source-register')).toBe('unknown')
    expect(evidence(root), 'a 500 is not a permission story — the page must not invent one').toBe('')
  })

  it('unknown + denied: the ①a card reads as ONE story — why it cannot tell, and who to ask', async () => {
    // The real `stock-prep:admin` combination, both halves at once: the registry read 403s AND the
    // 数据工厂 link is withheld. Asserted on the WHOLE card text, because the failure mode this
    // guards is two correct sentences that contradict each other on one screen.
    const root = await mountWithRegistry(
      registry({ state: 'unknown', sqlCount: 0, totalCount: 0, status: 403 }),
      { canOpenDataFactory: false },
    )
    const row = root.querySelector('[data-testid="stock-prep-getting-started-step"][data-step="source-register"]') as HTMLElement
    const hint = root.querySelector('[data-testid="stock-prep-getting-started-step-source-register"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(hint).toBeTruthy()

    const card = `${row.textContent ?? ''}\n${hint.textContent ?? ''}`
    // ① what the badge says, ② why it says it, ③ what to do about it, ④ who to ask.
    expect(card).toContain('看不到')
    expect(card).toContain('data_sources:read')
    expect(card).toContain('integration:write')
    expect(card).toContain('实施')
    // ...and NOT a link the reader cannot open, nor a claim that the step is unfinished.
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    expect(card).not.toContain('还没登记')
    // Progress is honestly capped, never inflated to hide the hole.
    expect(root.querySelector('[data-testid="stock-prep-getting-started-progress"]')?.textContent).toContain('/7')
  })

  it('①a’s read is issued once on mount and never auto-probes the customer database (D6)', async () => {
    await mountWithRegistry(registry())
    expect(h.registryCalls).toBe(1)
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

  // The hand-off card and step⑤ are two screens apart and used to be able to say opposite things:
  // `report.pass` (= the install run had no failure) says nothing about who may open the page, so a
  // brand-new deployment could read 「还没有任何角色…」 above and 「把地址发给他们」 below.
  it.each([
    ['no_role', '先别急着群发'],
    ['no_members', '先别急着群发'],
  ])('the hand-off card carries step⑤\'s answer: %s → 「%s」', async (state, expected) => {
    const root = await mountWithReadiness(
      readiness({ state, roles: [], roleCount: 0, memberTotal: 0 }),
      { report: report({ pass: true, skipCount: 5 }) },
    )
    const line = root.querySelector('[data-testid="stock-prep-getting-started-complete-access"]')?.textContent ?? ''
    expect(line).toContain(expected)
    // G5 — it warns, it does not gate: both buttons stay live.
    expect((root.querySelector('[data-testid="stock-prep-getting-started-copy-handoff"]') as HTMLButtonElement).disabled).toBe(false)
    expect((root.querySelector('[data-testid="stock-prep-getting-started-copy-link"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('the hand-off card quotes step⑤\'s headcount when it is ready (线框 B3 第 2 行)', async () => {
    const root = await mountWithReadiness(readiness(), { report: report({ pass: true, skipCount: 5 }) })
    const line = root.querySelector('[data-testid="stock-prep-getting-started-complete-access"]')?.textContent ?? ''
    expect(line).toContain('1 个角色')
    expect(line).toContain('6 人')
    // …and still refuses to promise it, because the admission leg is invisible from here too.
    expect(line).toContain('插件使用')
  })

  it('the hand-off card admits it cannot judge access when step⑤ could not be read', async () => {
    const root = await mountWithReadiness(
      readiness({ state: 'unknown', roles: [], roleCount: 0, memberTotal: 0, status: 403 }),
      { report: report({ pass: true, skipCount: 5 }) },
    )
    const line = root.querySelector('[data-testid="stock-prep-getting-started-complete-access"]')?.textContent ?? ''
    expect(line).toContain('本页判断不了')
  })

  it('the group-chat payload does not claim 「可以用了」 until step⑤ says so', async () => {
    const root = await mountWithReadiness(
      readiness({ state: 'no_role', roles: [], roleCount: 0, memberTotal: 0 }),
      { report: report({ pass: true, skipCount: 5 }) },
    )
    ;(root.querySelector('[data-testid="stock-prep-getting-started-copy-handoff"]') as HTMLButtonElement).click()
    await nextTick()
    expect(h.copied[0]).not.toContain('可以用了')
    expect(h.copied[0]).toContain('/stock-prep')
    if (app) app.unmount()
    app = null
    container!.innerHTML = ''
    h.copied = []
    h.readinessCalls = 0
    const ready = await mountWithReadiness(readiness(), { report: report({ pass: true, skipCount: 5 }) })
    ;(ready.querySelector('[data-testid="stock-prep-getting-started-copy-handoff"]') as HTMLButtonElement).click()
    await nextTick()
    expect(h.copied[0]).toContain('可以用了')
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
    // Every way of saying「这是贵司/本租户的配置」, not just the one phrase the first cut banned:
    // `fetchRoleCatalog`'s SQL carries no tenant predicate at all (admin-users.ts), so any of these
    // would be false on a host serving more than one tenant.
    for (const forbidden of ['租户配置', '本租户', '贵司', '您的租户']) {
      expect(scope, `access scope must not claim ${forbidden}`).not.toContain(forbidden)
    }
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
    // THE BADGE IS NOT 已完成, and cannot become it: 「谁能用」 is three conditions and this read sees
    // two. The per-user 「插件使用」 admission (`user_namespace_admissions`) is written by neither
    // `/roles/assign` nor `assignUserRoles`, so a correctly-built role full of people can still be a
    // floor that gets 403 — a ✔ on the map here would be the 假绿 G4 exists to forbid.
    expect(badgeOf(root, 'grant-access')).toBe('held')
    expect(badgeOf(root, 'grant-access')).not.toBe('done')
  })

  it('✔ still names the third condition it cannot see, and does not promise those people can open it', async () => {
    const root = await mountWithReadiness(readiness())
    const block = accessBlock(root)
    const admission = block.querySelector('[data-testid="stock-prep-getting-started-access-admission"]')?.textContent ?? ''
    expect(admission).toContain('插件使用')
    expect(admission).toContain('stock-prep')
    // The sufficiency promise this line replaced: 「角色本身不用再动」/「应该已经能打开了」.
    const next = block.querySelector('[data-testid="stock-prep-getting-started-access-next"]')?.textContent ?? ''
    expect(next).not.toContain('应该已经能打开')
    expect(next).toContain('真的打开一次')
  })

  it('⚠ 有角色但一个人都没有 → NOT ✔ (0 成员 is not ready)', async () => {
    const root = await mountWithReadiness(readiness({
      state: 'no_members', roles: [{ name: '备料一线', memberCount: 0 }], roleCount: 1, memberTotal: 0,
    }))
    const block = accessBlock(root)
    expect(block.dataset.state).toBe('no_members')
    expect(block.dataset.state).not.toBe('ready')
    expect(block.textContent).toContain('一个人都还没有')
    const next = block.querySelector('[data-testid="stock-prep-getting-started-access-next"]')?.textContent ?? ''
    expect(next).toContain('用户管理')
    // …and the step that is missed by default: adding an EXISTING user to a role writes no
    // admission row, so 「放进角色」 alone still leaves them refused.
    expect(next).toContain('插件使用')
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
    // The third thing, named in the how-to itself rather than left to be discovered at the 403.
    expect(next).toContain('插件使用')
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
    // …and so is the admission line: it is advice about a state this page could not read.
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-admission"]')).toBeNull()
    // A 403 IS a permission answer, so this is the one status allowed to say so.
    expect(text).toContain('读不到平台的角色目录')
  })

  it.each([
    ['a 500', 500],
    ['a 502', 502],
    ['a transport failure with no status at all', null],
  ])('? 看不到 after %s does NOT blame the caller\'s permissions', async (_label, status) => {
    const root = await mountWithReadiness(readiness({ state: 'unknown', roles: [], roleCount: 0, memberTotal: 0, status }))
    const text = accessBlock(root).textContent ?? ''
    // The service collapses every unanswered read into ONE state (G4) — but a 500 is not evidence
    // that this account lacks permission, and the reader may well BE the platform administrator the
    // 403 wording would send them to find.
    expect(text).not.toContain('当前账号读不到')
    expect(text).not.toContain('读角色目录要平台管理员')
    expect(text).toContain('看不到')
    expect(text).toContain('可能是网络或服务端')
    // Still not a verdict, and still not a number nobody can act on.
    expect(text).not.toContain('没完成')
    expect(text).not.toMatch(/\b(500|502)\b/)
    expect(badgeOf(root, 'grant-access')).toBe('unknown')
  })

  it('several qualifying roles: the sum is labelled as a sum, and an over-cap catalog says so', async () => {
    // The fixture matches what the projection can actually produce: the cap is 5, so an over-cap
    // catalog arrives as FIVE names plus a true total — an earlier fixture sent two names with a
    // total of seven, a shape no real read can return.
    const root = await mountWithReadiness(readiness({
      roles: [
        { name: '备料一线', memberCount: 6 },
        { name: '备料班组长', memberCount: 3 },
        { name: '备料计划', memberCount: 2 },
        { name: '备料工艺', memberCount: 4 },
        { name: '备料仓管', memberCount: 5 },
      ],
      roleCount: 7,
      memberTotal: 21,
    }))
    const block = accessBlock(root)
    expect(block.querySelectorAll('[data-testid="stock-prep-getting-started-access-role"]')).toHaveLength(5)
    expect(block.querySelector('[data-testid="stock-prep-getting-started-access-double-count"]')?.textContent).toContain('数两次')
    const overflow = block.querySelector('[data-testid="stock-prep-getting-started-access-overflow"]')?.textContent ?? ''
    expect(overflow).toContain('2 个角色')
    // …and says the listed ones are the catalog's first few, not a ranking this page made.
    expect(overflow).toContain('不是「最主要的」')
  })

  it('the stock-prep:admin line describes what that code actually confers — the LARGEST of the three', async () => {
    // stock-preparation-workbench-access.cjs `satisfiesStockPrepAccess` returns true for
    // stock-prep:admin BEFORE it looks at read/operate. Describing it as 「能看安装页(只读)」 would
    // understate a grant in the unsafe direction: its holders can confirm and export.
    const withAdmin = await mountWithReadiness(readiness({ adminRoleCount: 2 }))
    const note = accessBlock(withAdmin).querySelector('[data-testid="stock-prep-getting-started-access-admin-note"]')?.textContent ?? ''
    expect(note).toContain('2 个')
    expect(note).toContain('同时满足 read 和 operate')
    expect(note).toContain('导出')
    // The words the old note used, which read as a view-only badge.
    expect(note).not.toContain('建表仍然是平台管理员的事')
    if (app) app.unmount()
    app = null
    container!.innerHTML = ''
    h.readinessCalls = 0
    const withoutAdmin = await mountWithReadiness(readiness({ adminRoleCount: 0 }))
    const none = accessBlock(withoutAdmin).querySelector('[data-testid="stock-prep-getting-started-access-admin-note"]')?.textContent ?? ''
    expect(none).toContain('不必配它')
    expect(none).toContain('同时满足 read 和 operate')
    expect(accessBlock(withoutAdmin).dataset.state).toBe('ready')
  })

  it('platform-admin roles are named as out-of-scope, not silently dropped', async () => {
    const root = await mountWithReadiness(readiness({ state: 'no_role', roles: [], roleCount: 0, memberTotal: 0, platformAdminRoleCount: 2 }))
    const note = accessBlock(root).querySelector('[data-testid="stock-prep-getting-started-access-platform-admin-note"]')?.textContent ?? ''
    expect(note).toContain('2 个')
    expect(note).toContain('本来就能打开')
    expect(note).toContain('不是一线')
    if (app) app.unmount()
    app = null
    container!.innerHTML = ''
    h.readinessCalls = 0
    const none = await mountWithReadiness(readiness({ platformAdminRoleCount: 0 }))
    expect(accessBlock(none).querySelector('[data-testid="stock-prep-getting-started-access-platform-admin-note"]')).toBeNull()
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
      const hasRoles = state === 'ready' || state === 'no_members'
      const root = await mountWithReadiness(readiness({
        state,
        // The role objects carry the two permitted fields PLUS planted identity fields, so this
        // assertion has something to catch: a future template that renders `role` wholesale, or
        // reaches for a field the projection is not supposed to hand over, turns this red. (The
        // service-side spec proves the real projection strips them; this proves the DOM would not
        // print them even if one got through.)
        roles: hasRoles
          ? [{
            name: '备料一线',
            memberCount: state === 'ready' ? 6 : 0,
            userId: PLANTED[0],
            ownerEmail: PLANTED[1],
            displayName: PLANTED[2],
          }]
          : [],
        roleCount: hasRoles ? 1 : 0,
        memberTotal: state === 'ready' ? 6 : 0,
        actorId: PLANTED[0],
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
    // THREE steps, not two. A to-do that stops at 「把人放进角色」 is followed to the letter and
    // still leaves the floor at 403, because adding an existing user writes no admission row.
    expect(payload).toContain('插件使用')
    expect(payload).toContain('角色管理')
    expect(payload).toContain('用户管理')
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

  it('the hand-off to-do routes the reader to where this wizard ACTUALLY is (P1-1)', async () => {
    // THIS STRING IS PASTED INTO A CHAT WINDOW, so it outlives the screen it was written against and
    // nobody re-reads it when a view moves. It used to say 「打开备料工作台 →『安装 / 体检』→ 最上面
    // 的『开始使用』」, which was true while the wizard rode the install page's first screen; P1-1
    // gave 开始使用 its own rail item and made the install page render without a wizard, so the old
    // wording sent a platform administrator to a page that has none. Pinned here so the NEXT move of
    // this view reddens a test rather than a message somebody already sent.
    const root = await mount({ canRunInstall: false, preflight: preflight({ blockers: [httpBlocker()] }) })
    ;(root.querySelector('[data-testid="stock-prep-getting-started-copy-todo-install"]') as HTMLButtonElement).click()
    await nextTick()
    const payload = h.copied[0]
    expectValuesFree(payload)
    expect(payload).toContain('左栏「开始使用」')
    expect(payload).toContain('第④步')
    expect(payload).toContain('开始安装')
    // The tab it no longer lives on must not be named as the way in.
    expect(payload).not.toContain('安装 / 体检')
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
  // 整合切片 (2026-09-09) + ①拆分 (2026-09-10): the two off-page step-① links
  // ---------------------------------------------------------------------------

  it('①a links to the folded-in 连接管理 section of 数据工厂, not the retired standalone page', async () => {
    // The standalone /data-sources page is gone (it now redirects). A link left on the bare
    // path would still "work" via that redirect, so this pins the DIRECT target: the one step
    // this wizard cannot perform itself must land the reader on the section that can.
    const root = await mount({ canOpenDataFactory: true })
    const link = root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]') as HTMLAnchorElement | null
    expect(link).toBeTruthy()
    const href = link?.getAttribute('href') ?? ''
    expect(href).toContain('/integrations/workbench')
    expect(href).toContain('int-sec-connection')
    expect(href).not.toBe('/data-sources')
    // The label has to name where it goes — an unchanged 「去外接数据源页」 would send the reader
    // looking for a page that no longer exists.
    expect(link?.textContent).toContain('数据工厂')
  })

  it('①a renders the English label for the same folded-in target', async () => {
    h.locale = 'en'
    const root = await mount({ canOpenDataFactory: true })
    const link = root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]') as HTMLAnchorElement | null
    expect(link?.getAttribute('href')).toBe('/integrations/workbench#int-sec-connection')
    expect(link?.textContent).toContain('Data Factory')
  })

  // —— the base slice's three denied cases, now pointing at ①a's half of the split ——
  // The other half of the fold's cost, stated instead of hidden: 数据工厂 carries an
  // `integration:write` route gate that the retired standalone page did not, and a
  // `stock-prep:admin` holder — the documented reader of 「开始使用」 — does not hold it. For them
  // the link would be a redirect dressed as an entry point (R-11 「看得见点不动」), so it is absent
  // and the step says which permission is missing and who to ask.
  it('①a renders a plain-text pointer, not a link, when the principal cannot open 数据工厂', async () => {
    const root = await mount({ canOpenDataFactory: false })
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    const denied = root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources-denied"]')
    expect(denied).toBeTruthy()
    expect(denied?.tagName).not.toBe('A')
    expect(denied?.textContent).toContain('integration:write')
    expect(denied?.textContent).toContain('实施')
    // The STEP itself stays on screen — a reader who cannot do it still has to know it exists.
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-register"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-connect"]')).toBeTruthy()
    // ... and no bare path leaks back in as text.
    expect(root.textContent ?? '').not.toContain('/integrations/workbench')
  })

  it('① fails closed: a host that passes nothing gets the pointer, never the link', async () => {
    // `defaultProps` passes `false`, the same value Vue's Boolean casting produces for an absent
    // prop. Both roads lead to the same denied render — the genuinely-absent road is the case
    // below this one.
    const root = await mount()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources-denied"]')).toBeTruthy()
  })

  it('①a says the same thing in English when the principal cannot open 数据工厂', async () => {
    h.locale = 'en'
    const root = await mount({ canOpenDataFactory: false })
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    const denied = root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources-denied"]')
    expect(denied?.textContent).toContain('integration:write')
    expect(denied?.textContent).toContain('implementer')
  })

  // —— the ① split's own cases ——
  // ①b — THE HALF THAT USED TO HAVE NO ROW OF ITS OWN. Deleting this step (or folding it back into
  // ①a) reddens this case, the seven-step order case, and the four-combination case above.
  it('①b has its own row, its own link into the SAME section, and names 「新增连接草稿」', async () => {
    const root = await mount({ canOpenDataFactory: true })
    const row = root.querySelector('[data-testid="stock-prep-getting-started-step-source-connect"]') as HTMLElement | null
    expect(row, '①b must render its own hint row').toBeTruthy()
    // The sentence has to say WHICH control in that section, because ①a points at the same anchor.
    expect(row?.textContent).toContain('新增连接草稿')
    expect(row?.textContent).toContain('引用')
    const link = root.querySelector('[data-testid="stock-prep-getting-started-link-connection-draft"]') as HTMLAnchorElement | null
    expect(link, '①b must have a link of its own').toBeTruthy()
    expect(link?.getAttribute('href')).toBe('/integrations/workbench#int-sec-connection')
    // ...and it is NOT ①a's element: two steps, two testids, two destinations named in words.
    const registerLink = root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')
    expect(registerLink).toBeTruthy()
    expect(registerLink).not.toBe(link)
  })

  it('①a and ①b render as a bilingual PAIR', async () => {
    h.locale = 'en'
    const root = await mount({ canOpenDataFactory: true })
    const register = root.querySelector('[data-testid="stock-prep-getting-started-step-source-register"]') as HTMLElement
    const draft = root.querySelector('[data-testid="stock-prep-getting-started-step-source-connect"]') as HTMLElement
    expect(register.textContent).toContain('sign-in credentials')
    expect(draft.textContent).toContain('references the data source')
    // No Chinese leaks into the English rendering of either row.
    expect(register.textContent ?? '').not.toContain('外接数据源')
    expect(draft.textContent ?? '').not.toContain('新增连接草稿')
  })

  // R-11 for a LINK, over BOTH halves: a destination this caller cannot open is a sentence, never
  // an anchor — and ①b must carry its own denied node rather than leaning on ①a's.
  it('a caller who cannot open 数据工厂 gets both sentences and NEITHER link', async () => {
    const root = await mount({ canOpenDataFactory: false })
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-link-connection-draft"]')).toBeNull()
    const denyA = root.querySelector('[data-testid="stock-prep-getting-started-link-data-sources-denied"]')
    const denyB = root.querySelector('[data-testid="stock-prep-getting-started-link-connection-draft-denied"]')
    // Both name the permission and who to ask — the pair reads the same way, in two places.
    expect(denyA?.textContent).toContain('integration:write')
    expect(denyB?.textContent).toContain('integration:write')
    expect(denyA?.textContent).toContain('实施')
    expect(denyB?.textContent).toContain('实施')
    expect(denyA).not.toBe(denyB)
    // The MAP is untouched — it is not a gate (G5): both rows still render with their own badges.
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-register"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="stock-prep-getting-started-step-source-connect"]')).toBeTruthy()
    expect(root.querySelectorAll('[data-testid="stock-prep-getting-started-step"]').length).toBe(7)
  })

  it('the link gate is FAIL-CLOSED for BOTH halves when the prop is genuinely absent', async () => {
    // Stronger than the `false` case above: this mounts with the key DELETED, which is what a host
    // that forgets to wire it produces. Vue casts an absent Boolean prop to false, so both denied
    // nodes must appear and neither link may.
    const props = defaultProps() as Record<string, unknown>
    delete props.canOpenDataFactory
    app = createApp(StockPreparationGettingStarted as Component, props)
    app.mount(container!)
    await nextTick()
    expect(container!.querySelector('[data-testid="stock-prep-getting-started-link-data-sources"]')).toBeNull()
    expect(container!.querySelector('[data-testid="stock-prep-getting-started-link-connection-draft"]')).toBeNull()
    expect(container!.querySelector('[data-testid="stock-prep-getting-started-link-data-sources-denied"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="stock-prep-getting-started-link-connection-draft-denied"]')).toBeTruthy()
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

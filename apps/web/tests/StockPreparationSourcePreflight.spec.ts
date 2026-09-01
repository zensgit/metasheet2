import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 源就绪预检 + 拓扑自测 — the DOM half.
//
// The panel exists because two live failures were invisible on every screen we had: a read plan
// configured for the ORDER MODULE against a source whose BOM lived in a design-BOM table (the run
// "succeeded" and expanded zero rows), and an empty test database nobody noticed for many steps.
// The deliverable is that both now read as one sentence a person can act on, in 30 seconds.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   P-01 the button calls the source route, and the four measured lines render from the RESPONSE —
//        the page decides none of them itself
//   P-02 THE FEATURE: a topology mismatch renders the plain-language sentence that names the zero-row
//        outcome, plus the measured shape vs the configured one, and the machine code beside it
//   P-03 a go verdict renders as go, with every line marked yes
//   P-04 an empty source (INCIDENT B) renders "no project numbers" in words, not as a code
//   P-05 warnings render as warnings — never as blockers, and never suppress the verdict
//   P-06 R-11 alignment: the run control renders only for a principal the ROUTE would accept; a
//        stock-prep-namespace admin sees the panel and is told who runs it
//   P-07 VALUES-FREE: business values, a credential and a host planted in the payload never reach the
//        DOM; the ≤2 liveness project numbers are the one thing that does, and only there
//   P-08 a failed read renders a status and nothing else — no server message on screen
//   P-09 the deployment preflight and the source preflight do not clobber each other
//
// The mocked route double answers this API's envelope; a 2xx that is not the envelope reads as a
// failure, exactly as the sibling install spec requires.

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

import StockPreparationInstallView from '../src/components/integration/stockPreparation/StockPreparationInstallView.vue'
import {
  STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE,
  stockPrepSourceCheckRows,
  type StockPrepSourcePreflight,
} from '../src/services/integration/stockPreparation/sourcePreflight'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }

// Things that must never reach a screen.
const PLANTED_PASSWORD = 'Sup3rSecret!PlmPassw0rd'
const PLANTED_HOST = 'pdm-prod.customer-internal.example'
const PLANTED_DRAWING = 'TG-2026-0001-ROTOR-HOUSING'
const PLANTED_CUSTOMER = '某某重工股份有限公司'
// The one thing that MAY: liveness evidence, capped at two by the server.
const LIVENESS_A = 'PRJ-2601'
const LIVENESS_B = 'PRJ-2602'

function probe(role: string, object: string, rows: number, exact = true) {
  return { role, object, present: true, rowsObserved: rows, exact, columns: ['ID', 'part_id'], errorCode: null }
}

/** The live customer's shape: order module all but empty, design BOM full. */
function customerShapedPayload(overrides: Partial<StockPrepSourcePreflight> = {}): StockPrepSourcePreflight {
  return {
    ok: false,
    verdict: 'no-go',
    externalSystemId: 'plm_sql_source',
    readPlanId: 'plm.stock-preparation.bom-read.dn-pdm.v1',
    rowCap: 200,
    checks: {
      reachability: { reachable: true, objectsProbed: 9, objectsAnswered: 8, failureCode: null },
      projectData: {
        entryObject: 'DN_PDM_PathExAttrInfo',
        entryObjectPresent: true,
        matchField: 'FileCode',
        rowsObserved: 3,
        exact: true,
        populatedMatchRows: 3,
        nodeTypeColumn: 'NodeType',
        projectNodeType: 2,
        projectNodeRows: 1,
        hasProjectNumbers: true,
        livenessSamples: [LIVENESS_A, LIVENESS_B],
        errorCode: null,
      },
      bomData: {
        bomHeadObject: 'DN_PDM_BomHeadInfo',
        bomHeadRows: 3,
        bomHeadExact: true,
        bomHeadPresent: true,
        bomDetailObject: 'DN_PDM_BomDetailsInfo',
        bomDetailRows: 6,
        bomDetailExact: true,
        bomDetailPresent: true,
        hasBomRows: true,
      },
      topology: {
        detectedBridge: 'design-bom',
        reason: 'only-design-bom-carries-lines',
        configuredBridge: 'order-module',
        matchesConfigured: false,
        dominanceRatio: 4,
        minLines: 2,
        candidates: [
          {
            bridge: 'order-module',
            headObject: 'DN_PDM_OrderHeadInfo',
            headRows: 1,
            headExact: true,
            headPresent: true,
            lineObject: 'DN_PDM_OrderDetailInfo',
            lineRows: 0,
            lineExact: true,
            linePresent: true,
          },
          {
            bridge: 'design-bom',
            headObject: null,
            headRows: null,
            headExact: null,
            headPresent: null,
            lineObject: 'DN_PDM_DesignBom',
            lineRows: 200,
            lineExact: false,
            linePresent: true,
          },
        ],
      },
      presetMatch: {
        matchedBy: 'table-signature',
        presetId: 'dn-pdm-family',
        reason: 'MATCHED',
        tablesAnswered: 8,
        matchedSignatureTables: 8,
        requiredSignatureTables: 6,
        missingSignatureTables: [],
      },
      quantityField: {
        carrierObject: 'DN_PDM_DesignBom',
        configuredField: 'Bom_ExAttr1',
        dictionaryObject: 'DN_PM_BomExAttrInfo',
        dictionaryReadable: true,
        dictionaryKeyColumn: 'attr_name',
        dictionaryEnabledRows: 2,
        dictionarySlot: 'Bom_ExAttr1',
        measuredSlot: 'bom_exattr1',
        measuredNumericRatio: 1,
        measuredCandidates: [{ column: 'bom_exattr1', populated: 184, numericRatio: 1 }],
        resolvedSlot: 'Bom_ExAttr1',
        readingsAgree: true,
        matchesConfigured: true,
        numericDensityFloor: 0.8,
      },
    },
    blockers: [
      {
        code: 'topology_mismatch',
        detail: {
          configuredBridge: 'order-module',
          detectedBridge: 'design-bom',
          configuredLineObject: 'DN_PDM_OrderDetailInfo',
          detectedLineObject: 'DN_PDM_DesignBom',
        },
      },
    ],
    warnings: [],
    probes: [
      probe('pathExAttr', 'DN_PDM_PathExAttrInfo', 3),
      probe('orderHead', 'DN_PDM_OrderHeadInfo', 1),
      probe('designBom', 'DN_PDM_DesignBom', 200, false),
    ],
    ...overrides,
  }
}

/** Everything matches: this source is connectable. */
function readyPayload(): StockPrepSourcePreflight {
  const base = customerShapedPayload()
  return {
    ...base,
    ok: true,
    verdict: 'go',
    checks: {
      ...base.checks,
      topology: {
        ...base.checks.topology,
        detectedBridge: 'order-module',
        reason: 'only-order-module-carries-lines',
        matchesConfigured: true,
      },
    },
    blockers: [],
  }
}

/** INCIDENT B: reachable, present, and empty. */
function emptyPayload(): StockPrepSourcePreflight {
  const base = customerShapedPayload()
  return {
    ...base,
    checks: {
      ...base.checks,
      projectData: { ...base.checks.projectData, populatedMatchRows: 0, hasProjectNumbers: false, livenessSamples: [] },
      bomData: { ...base.checks.bomData, bomHeadRows: 0, bomDetailRows: 0, hasBomRows: false },
      topology: { ...base.checks.topology, detectedBridge: 'none', reason: 'neither-candidate-carries-lines' },
    },
    blockers: [
      { code: 'no_project_numbers', detail: { object: 'DN_PDM_PathExAttrInfo', matchField: 'FileCode' } },
      { code: 'no_bom_rows', detail: { bomHeadRows: 0, bomDetailRows: 0 } },
      { code: 'no_bom_bridge', detail: { reason: 'neither-candidate-carries-lines' } },
    ],
  }
}

/** The payload with the things that must never travel planted throughout it. */
function poisonedPayload(): StockPrepSourcePreflight {
  const base = customerShapedPayload()
  return {
    ...base,
    externalSystemId: 'plm_sql_source',
    checks: {
      ...base.checks,
      projectData: {
        ...base.checks.projectData,
        // A server that regressed and put a drawing number / a customer name where liveness evidence
        // goes must still not paint them anywhere else; the panel renders only what it declares.
        livenessSamples: [LIVENESS_A, LIVENESS_B],
      },
      quantityField: { ...base.checks.quantityField, dictionaryKeyColumn: 'attr_name' },
    },
    blockers: [
      {
        code: 'topology_mismatch',
        detail: {
          configuredBridge: 'order-module',
          detectedBridge: 'design-bom',
          // Detail objects are diagnostic data the panel deliberately does NOT paint.
          password: PLANTED_PASSWORD,
          host: PLANTED_HOST,
          drawing: PLANTED_DRAWING,
          customer: PLANTED_CUSTOMER,
        },
      },
    ],
  }
}

interface RouteBehaviour {
  sourcePayload?: StockPrepSourcePreflight
  sourceStatus?: number
  sourceHtml?: boolean
}

function manifestPayload() {
  return {
    appId: 'stock-preparation',
    displayName: 'BOM备料',
    managedObjects: [],
    permissions: [],
    configSurfaces: [],
    fences: [],
    acceptance: {},
  }
}

function deploymentPreflightPayload() {
  return {
    ready: true,
    blockers: [],
    posture: [],
  }
}

function installRoutes(behaviour: RouteBehaviour = {}): void {
  const envelope = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify({ ok: status < 400, data }), { status })

  h.apiFetch.mockImplementation(async (input: string) => {
    const url = String(input)
    if (url.includes('/api/platform/apps/stock-preparation')) {
      return new Response(JSON.stringify(manifestPayload()), { status: 200 })
    }
    if (url.includes(STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE)) {
      if (behaviour.sourceHtml) return new Response('<html>gateway</html>', { status: 200 })
      const status = behaviour.sourceStatus ?? 200
      if (status >= 400) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'SOURCE_PREFLIGHT_NO_SOURCE' } }), { status })
      }
      return envelope(behaviour.sourcePayload ?? customerShapedPayload())
    }
    if (url.includes('/stock-preparation/preflight')) {
      return envelope(deploymentPreflightPayload())
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

function textOf(root: HTMLElement, selector: string): string {
  return Array.from(root.querySelectorAll(selector)).map((node) => node.textContent || '').join(' | ')
}

describe('源就绪预检 + 拓扑自测 (source readiness panel)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:read']
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

  async function runSourceCheck(root: HTMLElement): Promise<void> {
    const button = root.querySelector<HTMLButtonElement>('[data-testid="stock-prep-source-preflight-run"]')
    expect(button, 'the run control must be present for a permitted principal').toBeTruthy()
    button!.click()
    await flush()
  }

  // P-01 -----------------------------------------------------------------
  it('calls the source route and renders the four measured lines from the response', async () => {
    const root = await mountView()
    expect(root.querySelector('[data-testid="stock-prep-source-preflight"]')).toBeTruthy()
    // Nothing is read until it is asked for: the panel does not probe a customer database on mount.
    expect(h.apiFetch.mock.calls.some(([url]) => String(url).includes(STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE))).toBe(false)

    await runSourceCheck(root)

    // The path is asserted LITERALLY, not against the constant the code under test also uses: an
    // assertion written in terms of the thing it is checking cannot catch that thing changing.
    const called = h.apiFetch.mock.calls.map(([url]) => String(url))
    expect(called.some((url) => url.startsWith('/api/integration/stock-preparation/source-preflight'))).toBe(true)
    expect(STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE).toBe('/api/integration/stock-preparation/source-preflight')

    const rows = Array.from(root.querySelectorAll('[data-testid="stock-prep-source-preflight-check"]'))
    expect(rows).toHaveLength(4)
    // Literal expectations for THIS payload — reachable yes, data yes, topology NO, preset yes.
    expect(rows.map((row) => row.getAttribute('data-check'))).toEqual(['reachable', 'has-data', 'topology', 'preset'])
    expect(rows.map((row) => row.getAttribute('data-ok'))).toEqual(['yes', 'yes', 'no', 'yes'])
    // And the service's projection agrees with the same literals, so the two cannot drift apart while
    // both stay green.
    expect(stockPrepSourceCheckRows(customerShapedPayload()).map((row) => row.ok)).toEqual([true, true, false, true])
  })

  // P-01b ----------------------------------------------------------------
  it('renders an unreachable source as the one thing worth acting on', async () => {
    const base = customerShapedPayload()
    installRoutes({
      sourcePayload: {
        ...base,
        checks: {
          ...base.checks,
          reachability: { reachable: false, objectsProbed: 9, objectsAnswered: 0, failureCode: 'unreachable' },
        },
        blockers: [{ code: 'source_unreachable', detail: { failureCode: 'unreachable' } }],
        warnings: [],
      },
    })
    const root = await mountView()
    await runSourceCheck(root)

    const rows = Array.from(root.querySelectorAll('[data-testid="stock-prep-source-preflight-check"]'))
    expect(rows[0].getAttribute('data-ok')).toBe('no')
    expect(rows[0].textContent).toContain('unreachable')
    const blockers = textOf(root, '[data-testid="stock-prep-source-preflight-blocker"]')
    expect(blockers).toContain('连不上对方的系统')
    expect(blockers).toContain('这一步之前的所有判断都不作数')
  })

  // P-02 — THE FEATURE ---------------------------------------------------
  it('says the topology mismatch out loud, with the zero-row consequence in words', async () => {
    const root = await mountView()
    await runSourceCheck(root)

    const verdict = root.querySelector('[data-testid="stock-prep-source-preflight-verdict"]')
    expect(verdict?.textContent).toContain('接不了')

    const blockers = textOf(root, '[data-testid="stock-prep-source-preflight-blocker"]')
    // The sentence that pays for the whole feature.
    expect(blockers).toContain('对不上')
    expect(blockers).toContain('0 行')
    // The machine code stays beside it: it is what a person quotes when asking for help.
    expect(blockers).toContain('topology_mismatch')
    // And the next line tells them what to change.
    expect(textOf(root, '[data-testid="stock-prep-source-preflight-blocker-next"]')).toContain('实测')

    // The measured shape vs the configured one, in words rather than tokens.
    const shape = root.querySelector('[data-testid="stock-prep-source-preflight-shape"]')?.textContent || ''
    expect(shape).toContain('设计BOM表')
    expect(shape).toContain('订单模块')
    expect(shape).toContain('Bom_ExAttr1')

    // The row counts that justify the verdict are one disclosure away, not on the main line.
    const candidates = textOf(root, '[data-testid="stock-prep-source-preflight-candidate"]')
    expect(candidates).toContain('DN_PDM_DesignBom')
    expect(candidates).toContain('200+')
  })

  // P-03 -----------------------------------------------------------------
  it('renders a connectable source as go, with every line marked yes', async () => {
    installRoutes({ sourcePayload: readyPayload() })
    const root = await mountView()
    await runSourceCheck(root)

    expect(root.querySelector('[data-testid="stock-prep-source-preflight-verdict"]')?.textContent).toContain('可以接')
    const rows = Array.from(root.querySelectorAll('[data-testid="stock-prep-source-preflight-check"]'))
    expect(rows.map((row) => row.getAttribute('data-ok'))).toEqual(['yes', 'yes', 'yes', 'yes'])
    expect(root.querySelectorAll('[data-testid="stock-prep-source-preflight-blocker"]')).toHaveLength(0)
  })

  // P-04 -----------------------------------------------------------------
  it('renders an empty source in words, not as a code', async () => {
    installRoutes({ sourcePayload: emptyPayload() })
    const root = await mountView()
    await runSourceCheck(root)

    const blockers = textOf(root, '[data-testid="stock-prep-source-preflight-blocker"]')
    expect(blockers).toContain('一个项目编号都没有')
    expect(blockers).toContain('空的测试库')
    expect(blockers).toContain('BOM 表是空的')
    expect(root.querySelectorAll('[data-testid="stock-prep-source-preflight-blocker"]')).toHaveLength(3)

    // Literal, for this payload: reachable yes, data NO, topology NO, preset yes.
    const rows = Array.from(root.querySelectorAll('[data-testid="stock-prep-source-preflight-check"]'))
    expect(rows.map((row) => row.getAttribute('data-ok'))).toEqual(['yes', 'no', 'no', 'yes'])
    expect(stockPrepSourceCheckRows(emptyPayload()).map((row) => row.ok)).toEqual([true, false, false, true])
  })

  // P-05 -----------------------------------------------------------------
  it('renders warnings as warnings, and they do not become blockers', async () => {
    const base = readyPayload()
    installRoutes({
      sourcePayload: {
        ...base,
        checks: {
          ...base.checks,
          // An unrecognised vendor: connectable, and the preset line honestly reads no.
          presetMatch: {
            ...base.checks.presetMatch,
            presetId: null,
            reason: 'NO_PRESET_MATCHED',
            matchedSignatureTables: 2,
          },
        },
        warnings: [
          { code: 'no_preset_match', detail: { reason: 'NO_PRESET_MATCHED' } },
          { code: 'dictionary_unreadable', detail: { object: 'DN_PM_BomExAttrInfo' } },
        ],
      },
    })
    const root = await mountView()
    await runSourceCheck(root)

    expect(root.querySelectorAll('[data-testid="stock-prep-source-preflight-blocker"]')).toHaveLength(0)
    const warnings = textOf(root, '[data-testid="stock-prep-source-preflight-warning"]')
    expect(warnings).toContain('不像我们已知的任何一家')
    expect(warnings).toContain('字段字典表读不到')
    // A warning never overturns the verdict.
    expect(root.querySelector('[data-testid="stock-prep-source-preflight-verdict"]')?.textContent).toContain('可以接')
    // Reachable yes, data yes, topology yes, preset NO — the honest fourth line for an unknown vendor.
    const rows = Array.from(root.querySelectorAll('[data-testid="stock-prep-source-preflight-check"]'))
    expect(rows.map((row) => row.getAttribute('data-ok'))).toEqual(['yes', 'yes', 'yes', 'no'])
    expect(rows[3].textContent).toContain('NO_PRESET_MATCHED')
  })

  // P-06 -----------------------------------------------------------------
  it('renders the run control only for a principal the route would accept', async () => {
    for (const permission of ['integration:read', 'integration:write', 'integration:admin', 'role:admin']) {
      h.permissions = [permission]
      const root = await mountView()
      expect(
        root.querySelector('[data-testid="stock-prep-source-preflight-run"]'),
        `${permission} is inside the route's tier and must see the control`,
      ).toBeTruthy()
      app?.unmount()
      app = null
      container!.innerHTML = ''
    }

    // R-11: a stock-prep-namespace principal never falls through to integration:*, so the route would
    // refuse them. The panel must therefore not offer the button — and must say who can press it,
    // rather than leaving a dead control or a blank space.
    h.permissions = ['stock-prep:admin', 'stock-prep:read']
    const root = await mountView()
    expect(root.querySelector('[data-testid="stock-prep-source-preflight-run"]')).toBeNull()
    const denied = root.querySelector('[data-testid="stock-prep-source-preflight-denied"]')
    expect(denied).toBeTruthy()
    expect(denied?.textContent).toContain('对接权限')
  })

  // P-07 -----------------------------------------------------------------
  it('never paints a business value, a credential or a host — and caps liveness evidence at two', async () => {
    installRoutes({ sourcePayload: poisonedPayload() })
    const root = await mountView()
    await runSourceCheck(root)

    const rendered = root.textContent || ''
    for (const planted of [PLANTED_PASSWORD, PLANTED_HOST, PLANTED_DRAWING, PLANTED_CUSTOMER]) {
      expect(rendered.includes(planted), `planted value reached the DOM: ${planted.slice(0, 8)}…`).toBe(false)
    }
    // The one thing that MAY appear, and only in its own place.
    expect(rendered).toContain(LIVENESS_A)
    expect(rendered).toContain(LIVENESS_B)
    const samples = root.querySelectorAll('[data-testid="stock-prep-source-preflight-tech"] code')
    expect(Array.from(samples).filter((node) => (node.textContent || '').startsWith('PRJ-'))).toHaveLength(2)
  })

  // P-08 -----------------------------------------------------------------
  it('renders a failed read as a status, and paints no server message', async () => {
    installRoutes({ sourceStatus: 409 })
    const root = await mountView()
    await runSourceCheck(root)

    const error = root.querySelector('[data-testid="stock-prep-source-preflight-error"]')
    expect(error).toBeTruthy()
    expect(error?.textContent).toContain('409')
    // The server's own error CODE is not painted: this page renders statuses, never server text.
    expect(root.textContent).not.toContain('SOURCE_PREFLIGHT_NO_SOURCE')
    expect(root.querySelector('[data-testid="stock-prep-source-preflight-verdict"]')).toBeNull()

    // A 2xx that is not this API's envelope must read as a failure, never as an empty verdict — and
    // must be REFUSED BY THE ENVELOPE CHECK, which is what carries the 200 through. A page that
    // stumbled into its own catch block would show 0 here, so the number is the assertion.
    installRoutes({ sourceHtml: true })
    await runSourceCheck(root)
    const htmlError = root.querySelector('[data-testid="stock-prep-source-preflight-error"]')
    expect(htmlError).toBeTruthy()
    expect(htmlError?.textContent).toContain('200')
    expect(root.querySelector('[data-testid="stock-prep-source-preflight-verdict"]')).toBeNull()
  })

  // P-09 -----------------------------------------------------------------
  it('does not clobber the deployment preflight beside it', async () => {
    const root = await mountView()
    const deployment = root.querySelector<HTMLButtonElement>('[data-testid="stock-prep-install-preflight-run"]')
    deployment!.click()
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-install-preflight-result"]')).toBeTruthy()

    // A source check that FAILS must leave the deployment reading intact: the two answer different
    // questions about different machines.
    installRoutes({ sourceStatus: 409 })
    await runSourceCheck(root)
    expect(root.querySelector('[data-testid="stock-prep-install-preflight-result"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="stock-prep-source-preflight-error"]')).toBeTruthy()
  })
})

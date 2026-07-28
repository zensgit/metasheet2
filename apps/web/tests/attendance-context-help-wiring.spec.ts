// W5-2 (Wave 5 explainability design-lock, RATIFIED §6/§9 W5-2): AttendanceView / AttendanceSetupReadiness
// wiring for the three contextual-help mount points — 'setup-wizard' (inside
// AttendanceSetupReadiness.vue), 'import' and 'self-request-center' (inside AttendanceView.vue's
// admin-import / overview-anomalies sections) — with the R1 (zero write) negative asserted at the
// mock network layer across a full walk of all three. Synthetic fixtures only (lock P2-a).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import { ATTENDANCE_SETUP_TEMPLATES } from '../src/views/attendance/attendanceSetupTemplates'
import {
  ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS,
  ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES,
} from '../src/views/attendance/attendanceContextHelp'
import { blockedSpreadsheetMessage } from '../src/views/attendance/importFileGuard'
import { xlsxConvertFailureMessage } from '../src/views/attendance/importXlsxConvert'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

function emptyAttendanceResponse(): Response {
  return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('W5-2 context-help wiring', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    useLocale().setLocale('zh-CN')
    vi.mocked(apiFetch).mockImplementation(async () => emptyAttendanceResponse())

    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  function nonGetCalls(): Array<[unknown, RequestInit | undefined]> {
    return (vi.mocked(apiFetch).mock.calls as Array<[unknown, RequestInit | undefined]>).filter(([, options]) => {
      const method = options?.method ? String(options.method).toUpperCase() : 'GET'
      return method !== 'GET'
    })
  }

  // ---------------------------------------------------------------------------
  // 'setup-wizard' mount (inside AttendanceSetupReadiness.vue).
  // ---------------------------------------------------------------------------
  it("setup wizard: the seven-step section carries context help with ①applicable_scenarios + ②save_impact, listing all four starter templates", async () => {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-setup' })
    app.mount(container!)
    await flushUi(24)

    const section = container!.querySelector<HTMLElement>('[data-attendance-setup-readiness-section]')
    expect(section).toBeTruthy()
    expect(section!.style.display).not.toBe('none')

    const help = section!.querySelector<HTMLElement>('[data-attendance-context-help][data-context-help-context="setup-wizard"]')
    expect(help).not.toBeNull()
    const entries = Array.from(help!.querySelectorAll('[data-context-help-entry]'))
    expect(entries.map((el) => el.getAttribute('data-context-help-category'))).toEqual([
      'applicable_scenarios',
      'save_impact',
    ])
    // Reuses the SAME four templates as the template gallery — no parallel word list.
    const scenarioBody = entries[0].querySelector('.context-help__body')!.textContent!
    for (const template of ATTENDANCE_SETUP_TEMPLATES) {
      expect(scenarioBody).toContain(template.name.zh)
    }
    // Zero write affordance anywhere in the help panel.
    expect(help!.querySelectorAll('button, input, form').length).toBe(0)
    // R1: mounting + reading this section issues zero non-GET calls.
    expect(nonGetCalls()).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // 'import' mount (inside AttendanceView.vue's admin-import section).
  // ---------------------------------------------------------------------------
  it("import section: carries context help with ③failure_recovery, mirroring the xlsx-guard closed set", async () => {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-import' })
    app.mount(container!)
    await flushUi(24)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-import')
    expect(section).toBeTruthy()
    expect((section as HTMLElement).style.display).not.toBe('none')

    const help = section!.querySelector<HTMLElement>('[data-attendance-context-help][data-context-help-context="import"]')
    expect(help).not.toBeNull()
    const entries = Array.from(help!.querySelectorAll('[data-context-help-entry]'))
    expect(entries.map((el) => el.getAttribute('data-context-help-category'))).toEqual(['failure_recovery'])
    const bodyText = entries[0].querySelector('.context-help__body')!.textContent!
    expect(bodyText).toContain('.xlsx')
    expect(bodyText).toContain('CSV')
    // Regression guard (found while wiring this in): the import section is always mounted
    // (v-show) — this help copy must never collide with the REACTIVE xlsx-guard banner text that
    // an unrelated test (attendance-import-preview-regression.spec.ts) asserts is ABSENT before
    // any file is selected.
    // Gate finding P3-1: this mount is zh-CN, so asserting the ENGLISH banner literal was
    // vacuous — it could never appear here regardless of collision. Assert BOTH locales' real
    // banner strings, taken from the producing functions themselves (never re-transcribed, so the
    // guard follows the banner copy if it is ever reworded).
    for (const kind of ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS) {
      const banner = blockedSpreadsheetMessage(kind)
      expect(bodyText).not.toContain(banner.zh)
      expect(bodyText).not.toContain(banner.en)
    }
    for (const reason of ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES) {
      const banner = xlsxConvertFailureMessage(reason)
      expect(bodyText).not.toContain(banner.zh)
      expect(bodyText).not.toContain(banner.en)
    }
    // Zero write affordance (and zero anchors — failure_recovery carries no link).
    expect(help!.querySelectorAll('button, input, form, a').length).toBe(0)
    // R1: mounting + reading this section issues zero non-GET calls.
    expect(nonGetCalls()).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // 'self-request-center' mount (inside AttendanceView.vue's overview anomalies/request card).
  // ---------------------------------------------------------------------------
  it("self overview: the Adjustment Request card carries context help with ④evidence_link — clicking it presets missing_punch, loads the SELF trace endpoint, and scrolls to the trace section", async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)

    const card = container!.querySelector<HTMLElement>('[data-overview-section="attendance-overview-anomalies"]')
    expect(card).not.toBeNull()
    const help = card!.querySelector<HTMLElement>('[data-attendance-context-help][data-context-help-context="self-request-center"]')
    expect(help).not.toBeNull()
    const link = help!.querySelector<HTMLAnchorElement>('[data-context-help-evidence-link]')
    expect(link).not.toBeNull()
    // R2: canonical query-form deep link, zero hash.
    expect(link!.getAttribute('href')).toBe('/attendance?section=attendance-overview-decision-trace')
    expect(link!.getAttribute('href')!.includes('#')).toBe(false)

    vi.mocked(apiFetch).mockClear()
    link!.click()
    await flushUi(6)

    const traceCalls = vi
      .mocked(apiFetch)
      .mock.calls.map((call) => String(call[0]))
      .filter((url) => url.includes('/decision-trace'))
    expect(traceCalls).toHaveLength(1)
    const traceUrl = new URL(traceCalls[0], 'http://localhost')
    expect(traceUrl.pathname).toBe('/api/attendance/decision-trace')
    expect(traceUrl.searchParams.get('category')).toBe('missing_punch')
    // §4.1: self face — the URL never carries a userId parameter.
    expect(traceCalls[0].includes('userId')).toBe(false)

    // The self decision-trace category picker reflects the preset.
    const selfTraceSection = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-self]')!
    const categorySelect = selfTraceSection.querySelector<HTMLSelectElement>('[data-decision-trace-self-category]')!
    expect(categorySelect.value).toBe('missing_punch')

    // R1: the whole interaction issued zero non-GET calls.
    expect(nonGetCalls()).toHaveLength(0)
  })

  it('en leg: the self-request-center evidence link renders en copy (locale-routed)', async () => {
    useLocale().setLocale('en')
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)
    const card = container!.querySelector<HTMLElement>('[data-overview-section="attendance-overview-anomalies"]')!
    const link = card.querySelector<HTMLAnchorElement>('[data-context-help-evidence-link]')!
    expect(link.textContent?.trim()).toBe('View basis (decision trace)')
  })

  // ---------------------------------------------------------------------------
  // R1 whole-surface negative: reaching the import section through the REAL admin rail navigation
  // (not just `initialSectionId`) and interacting with the self evidence-link both issue zero
  // non-GET calls — each per-context test above already asserts this at its own mount; this test
  // additionally proves the rail-click navigation path (not only the deep-link prop) stays
  // write-free.
  // ---------------------------------------------------------------------------
  it('R1: reaching the import section via the real admin-rail click (not just the deep-link prop) issues ZERO non-GET calls', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)
    // The rail may start with groups collapsed (focused-mode) — expand the group that owns
    // 'attendance-admin-import' before looking for its anchor, mirroring real user navigation.
    let importAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import"]')
    if (!importAnchor) {
      const groupToggles = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-admin-anchor-group]'))
      for (const toggle of groupToggles) {
        toggle.click()
        await flushUi(2)
        importAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import"]')
        if (importAnchor) break
      }
    }
    expect(importAnchor).not.toBeNull()
    vi.mocked(apiFetch).mockClear()
    importAnchor!.click()
    await flushUi(8)

    const section = container!.querySelector<HTMLElement>('#attendance-admin-import')
    expect(section).toBeTruthy()
    expect((section as HTMLElement).style.display).not.toBe('none')
    const help = section!.querySelector<HTMLElement>('[data-attendance-context-help][data-context-help-context="import"]')
    expect(help).not.toBeNull()
    expect(nonGetCalls()).toHaveLength(0)
  })
})

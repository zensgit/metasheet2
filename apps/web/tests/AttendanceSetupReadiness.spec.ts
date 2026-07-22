// W4-1 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §3/§6/§9 W4-1): mounted spec for the
// seven-step wizard shell `AttendanceSetupReadiness.vue` + its AttendanceView wiring (section
// registration, task-home entry, deep link, re-entry recompute). Red-line legs (each is a
// mutation target):
//   - R2: all remediation navigation is canonical (select-section emits + path/query hrefs);
//     hash-form navigation appears ZERO times in any state/role.
//   - §3① role contract: platform admin sees the /admin/users deep link; a delegated
//     attendance:admin NEVER sees it (contact-your-platform-admin copy instead).
//   - §4.5(iii) step⑥ copy: remediation is 「查看投递历史」 — never 「配置接收范围」-type copy;
//     `unsupported` never renders as 「未配置」/「去配置」.
//   - §3.2 / charter L232: unknown renders fail-closed (「未知，去核查」), never as complete.
//   - §3⑦: the manual activation checklist always lists ④ + ⑥'s three signals and never claims
//     anything is already enabled.
// Wired into .github/workflows/attendance-web-guard.yml (run-list + both path filters).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceSetupReadiness from '../src/views/attendance/AttendanceSetupReadiness.vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessResponse,
  type AttendanceSetupReadinessStepResult,
} from '../src/views/attendance/attendanceSetupReadiness'
import { ATTENDANCE_ADMIN_SECTION_IDS } from '../src/views/attendance/useAttendanceAdminRail'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
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

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const PER_STEP = Object.fromEntries(
  ATTENDANCE_SETUP_STEP_IDS.map((id) => [id, { effectiveTime: { source: 'test', posture: 'immediate' as const } }]),
) as AttendanceSetupReadinessResponse['perStep']

/** Fixture: gating steps ①②③⑤ all ready, ④ customized (ready), ⑥ its usual three signals. */
function allReadyResponse(overrides: Partial<AttendanceSetupReadinessResponse> = {}): AttendanceSetupReadinessResponse {
  return {
    directoryLinked: false,
    orgActiveMemberCount: 12,
    groupCount: 3,
    groupsWithMembers: 3,
    shiftCount: 4,
    scheduledShiftGroupCount: 1,
    activeRotationRuleCount: 2,
    hasRotationRules: true,
    approvalFlowCount: 2,
    punchPolicyPosture: 'customized',
    notify: {
      deliveryRuntime: 'unknown',
      orgRecipientBinding: { boundRecipientCount: 5, hasAnyBoundRecipient: true },
      recipientScopeConfig: 'unsupported',
    },
    previewReady: true,
    perStep: PER_STEP,
    ...overrides,
  }
}

/** Fixture: ①②③⑤ all missing, ④ on the platform default (manual_review_required). */
function mixedMissingResponse(): AttendanceSetupReadinessResponse {
  return allReadyResponse({
    orgActiveMemberCount: 0,
    groupCount: 1,
    groupsWithMembers: 0,
    shiftCount: 0,
    approvalFlowCount: 0,
    punchPolicyPosture: 'default',
    notify: {
      deliveryRuntime: 'not_ready',
      orgRecipientBinding: { boundRecipientCount: 0, hasAnyBoundRecipient: false },
      recipientScopeConfig: 'unsupported',
    },
    previewReady: false,
  })
}

function okSteps(data: AttendanceSetupReadinessResponse): AttendanceSetupReadinessStepResult[] {
  return deriveAttendanceSetupReadinessSteps({ kind: 'ok', data })
}

const zhTr = (_en: string, zh: string) => zh
const enTr = (en: string, _zh: string) => en

describe('AttendanceSetupReadiness.vue (component)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  type MountProps = {
    steps?: AttendanceSetupReadinessStepResult[]
    summary?: AttendanceSetupReadinessResponse | null
    loadState?: 'idle' | 'loading' | 'loaded' | 'error'
    viewerIsPlatformAdmin?: boolean
    tr?: (en: string, zh: string) => string
  }

  function mount(props: MountProps = {}) {
    const onSelectSection = vi.fn()
    const onReload = vi.fn()
    const data = allReadyResponse()
    app = createApp(AttendanceSetupReadiness, {
      tr: props.tr ?? zhTr,
      steps: props.steps ?? okSteps(data),
      summary: props.summary === undefined ? data : props.summary,
      loadState: props.loadState ?? 'loaded',
      viewerIsPlatformAdmin: props.viewerIsPlatformAdmin ?? true,
      onSelectSection,
      onReload,
    })
    app.mount(container!)
    return { onSelectSection, onReload }
  }

  function stepCard(stepId: string): HTMLElement {
    const card = container!.querySelector<HTMLElement>(`[data-setup-step="${stepId}"]`)
    expect(card, `expected step card ${stepId}`).toBeTruthy()
    return card!
  }

  it('renders the seven step cards in wizard order with the charter step names', async () => {
    mount()
    await flushUi()
    const ids = Array.from(container!.querySelectorAll('[data-setup-step]')).map((el) => el.getAttribute('data-setup-step'))
    expect(ids).toEqual([...ATTENDANCE_SETUP_STEP_IDS])
    const text = container!.textContent || ''
    expect(text).toContain('① 同步或创建组织人员')
    expect(text).toContain('② 创建考勤组并选择人员')
    expect(text).toContain('③ 选择班制与班次模板')
    expect(text).toContain('④ 配置允许的打卡方式')
    expect(text).toContain('⑤ 关联审批流程')
    expect(text).toContain('⑥ 配置通知渠道与接收范围')
    expect(text).toContain('⑦ 预览影响范围（preview-ready）')
  })

  describe('status rendering — full seven-value domain', () => {
    it('ready → 已完成 (all-ready fixture, steps ①②③⑤⑦)', async () => {
      mount()
      await flushUi()
      for (const stepId of ['attendance-admin-user-access', 'attendance-admin-groups', 'attendance-admin-shifts', 'attendance-admin-approval-flows', 'preview']) {
        const badge = stepCard(stepId).querySelector('[data-setup-step-status]')
        expect(badge?.getAttribute('data-setup-step-status'), stepId).toBe('ready')
        expect(badge?.textContent).toContain('已完成')
      }
    })

    it('missing → 未完成 (mixed-missing fixture), never rendered as complete', async () => {
      mount({ steps: okSteps(mixedMissingResponse()), summary: mixedMissingResponse() })
      await flushUi()
      for (const stepId of ['attendance-admin-user-access', 'attendance-admin-groups', 'attendance-admin-shifts', 'attendance-admin-approval-flows', 'preview']) {
        const badge = stepCard(stepId).querySelector('[data-setup-step-status]')
        expect(badge?.getAttribute('data-setup-step-status'), stepId).toBe('missing')
        expect(badge?.textContent).toContain('未完成')
        expect(badge?.textContent).not.toContain('已完成')
      }
    })

    it('manual_review_required (④ default posture) → 需人工确认 + a settings deep link, and NO confirm action in the wizard (R4)', async () => {
      const { onSelectSection } = mount({ steps: okSteps(mixedMissingResponse()), summary: mixedMissingResponse() })
      await flushUi()
      const card = stepCard('attendance-admin-settings')
      const badge = card.querySelector('[data-setup-step-status]')
      expect(badge?.getAttribute('data-setup-step-status')).toBe('manual_review_required')
      expect(badge?.textContent).toContain('需人工确认')
      // The ONLY interactive element is canonical navigation to the settings section — the wizard
      // itself offers no confirm/accept action (R4: 向导本身不提供确认动作).
      const buttons = Array.from(card.querySelectorAll('button'))
      expect(buttons).toHaveLength(1)
      buttons[0]!.click()
      await flushUi(2)
      expect(onSelectSection).toHaveBeenCalledWith('attendance-admin-settings')
    })

    it('unknown (④ unknown posture) → fail-closed 「未知，去核查」, never 已完成', async () => {
      const data = allReadyResponse({ punchPolicyPosture: 'unknown' })
      mount({ steps: okSteps(data), summary: data })
      await flushUi()
      const badge = stepCard('attendance-admin-settings').querySelector('[data-setup-step-status]')
      expect(badge?.getAttribute('data-setup-step-status')).toBe('unknown')
      expect(badge?.textContent).toContain('未知，去核查')
      expect(badge?.textContent).not.toContain('已完成')
    })

    it('unsupported (⑥) → 当前版本不支持 — never 未配置 / 去配置', async () => {
      mount()
      await flushUi()
      const badge = stepCard('attendance-admin-notification-deliveries').querySelector('[data-setup-step-status]')
      expect(badge?.getAttribute('data-setup-step-status')).toBe('unsupported')
      expect(badge?.textContent).toContain('当前版本不支持')
      expect(badge?.textContent).not.toContain('未配置')
      expect(badge?.textContent).not.toContain('去配置')
    })

    it('forbidden fold → all seven cards 无权限查看 (per-surface signal, distinct from missing)', async () => {
      mount({ steps: deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' }), summary: null })
      await flushUi()
      const badges = Array.from(container!.querySelectorAll('[data-setup-step-status]'))
      expect(badges).toHaveLength(7)
      for (const badge of badges) {
        expect(badge.getAttribute('data-setup-step-status')).toBe('forbidden')
        expect(badge.textContent).toContain('无权限查看')
        expect(badge.textContent).not.toContain('未完成')
      }
    })

    it('db_not_ready fold → all seven cards 数据库未就绪', async () => {
      mount({ steps: deriveAttendanceSetupReadinessSteps({ kind: 'db_not_ready' }), summary: null })
      await flushUi()
      const badges = Array.from(container!.querySelectorAll('[data-setup-step-status]'))
      expect(badges).toHaveLength(7)
      for (const badge of badges) {
        expect(badge.getAttribute('data-setup-step-status')).toBe('db_not_ready')
        expect(badge.textContent).toContain('数据库未就绪')
      }
    })
  })

  describe('effectiveTime — four-state contract (§3.2)', () => {
    it('renders immediate / scheduled(+effectiveAt) / manual_activation / undeterminable', async () => {
      const perStep = {
        ...PER_STEP,
        'attendance-admin-user-access': { effectiveTime: { source: 'test', posture: 'immediate' as const } },
        'attendance-admin-groups': {
          effectiveTime: { source: 'test', posture: 'scheduled' as const, effectiveAt: '2026-08-01T00:00:00.000Z' },
        },
        'attendance-admin-notification-deliveries': {
          effectiveTime: { source: 'none', posture: 'undeterminable' as const },
        },
        preview: { effectiveTime: { source: 'none', posture: 'manual_activation' as const } },
      }
      const data = allReadyResponse({ perStep })
      mount({ steps: okSteps(data), summary: data })
      await flushUi()

      expect(stepCard('attendance-admin-user-access').querySelector('[data-setup-step-effective-time]')?.textContent)
        .toContain('保存后立即生效')
      const scheduled = stepCard('attendance-admin-groups').querySelector('[data-setup-step-effective-time]')?.textContent || ''
      expect(scheduled).toContain('定时生效')
      expect(scheduled).toContain('2026-08-01T00:00:00.000Z')
      expect(stepCard('attendance-admin-notification-deliveries').querySelector('[data-setup-step-effective-time]')?.textContent)
        .toContain('无法确定')
      expect(stepCard('preview').querySelector('[data-setup-step-effective-time]')?.textContent)
        .toContain('需人工启用')
    })
  })

  describe('R2 — canonical deep links only, hash form appears ZERO times', () => {
    it('no anchor in any state/role carries a hash href; remediation buttons emit canonical section ids', async () => {
      const states: MountProps[] = [
        { viewerIsPlatformAdmin: true },
        { viewerIsPlatformAdmin: false },
        { steps: okSteps(mixedMissingResponse()), summary: mixedMissingResponse() },
        { steps: deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' }), summary: null },
      ]
      for (const props of states) {
        const { onSelectSection } = mount(props)
        await flushUi()
        const anchors = Array.from(container!.querySelectorAll('a'))
        for (const anchor of anchors) {
          expect(anchor.getAttribute('href') || '', 'hash-form navigation is forbidden (R2)').not.toContain('#')
        }
        // Remediation buttons route through the parent's canonical selectAdminSection.
        const groupsRemedy = container!.querySelector<HTMLButtonElement>('[data-setup-remedy="attendance-admin-groups"]')
        if (groupsRemedy) {
          groupsRemedy.click()
          await flushUi(2)
          expect(onSelectSection).toHaveBeenCalledWith('attendance-admin-groups')
        }
        app!.unmount()
        app = null
        container!.innerHTML = ''
      }
    })

    it('steps ②③④⑤⑥ each expose exactly one canonical remediation target', async () => {
      const { onSelectSection } = mount({ steps: okSteps(mixedMissingResponse()), summary: mixedMissingResponse() })
      await flushUi()
      const expected: Array<[string, string]> = [
        ['attendance-admin-groups', 'attendance-admin-groups'],
        ['attendance-admin-shifts', 'attendance-admin-shifts'],
        ['attendance-admin-settings', 'attendance-admin-settings'],
        ['attendance-admin-approval-flows', 'attendance-admin-approval-flows'],
        ['attendance-admin-notification-deliveries', 'attendance-admin-notification-deliveries'],
      ]
      for (const [stepId, target] of expected) {
        const remedy = stepCard(stepId).querySelector<HTMLButtonElement>(`[data-setup-remedy="${stepId}"]`)
        expect(remedy, stepId).toBeTruthy()
        remedy!.click()
        await flushUi(1)
        expect(onSelectSection).toHaveBeenLastCalledWith(target)
      }
      // ⑦ preview has no remediation deep link (预览在向导内，只读).
      expect(stepCard('preview').querySelector('[data-setup-remedy]')).toBeNull()
    })
  })

  describe('§3① role-gated remediation (W4-1 mandatory)', () => {
    it('platform admin sees the canonical /admin/users deep link (path form, not hash)', async () => {
      mount({ viewerIsPlatformAdmin: true })
      await flushUi()
      const link = stepCard('attendance-admin-user-access').querySelector<HTMLAnchorElement>('[data-setup-remedy="user-access-admin-link"]')
      expect(link).toBeTruthy()
      expect(link!.tagName).toBe('A')
      expect(link!.getAttribute('href')).toBe('/admin/users')
      expect(container!.querySelector('[data-setup-remedy="user-access-contact-admin"]')).toBeNull()
    })

    it('a delegated attendance:admin NEVER sees the 403-bound admin entry — contact copy instead', async () => {
      mount({ viewerIsPlatformAdmin: false })
      await flushUi()
      expect(container!.querySelector('[data-setup-remedy="user-access-admin-link"]')).toBeNull()
      // Negative is component-wide: no element anywhere links to the platform-admin surface.
      expect(Array.from(container!.querySelectorAll('a')).filter((a) => (a.getAttribute('href') || '').includes('/admin/users'))).toHaveLength(0)
      const contact = stepCard('attendance-admin-user-access').querySelector('[data-setup-remedy="user-access-contact-admin"]')
      expect(contact).toBeTruthy()
      expect(contact!.textContent).toContain('请联系平台管理员')
      // And the contact copy is not a link or button — it is explanatory text only.
      expect(contact!.tagName).not.toBe('A')
      expect(contact!.tagName).not.toBe('BUTTON')
    })
  })

  describe('§4.5(iii) — step⑥ copy negatives', () => {
    it('the ⑥ remediation is exactly 「查看投递历史」 and the ⑥ card never says 配置接收范围 / 未配置 / 去配置', async () => {
      mount()
      await flushUi()
      const card = stepCard('attendance-admin-notification-deliveries')
      const remedy = card.querySelector<HTMLButtonElement>('[data-setup-remedy="attendance-admin-notification-deliveries"]')
      expect(remedy).toBeTruthy()
      expect(remedy!.textContent?.trim()).toBe('查看投递历史')
      const cardText = card.textContent || ''
      expect(cardText).not.toContain('配置接收范围')
      expect(cardText).not.toContain('未配置')
      expect(cardText).not.toContain('去配置')
    })

    it('English remediation copy is "View delivery history" (never a configure-recipient-scope action)', async () => {
      mount({ tr: enTr })
      await flushUi()
      const remedy = stepCard('attendance-admin-notification-deliveries')
        .querySelector<HTMLButtonElement>('[data-setup-remedy="attendance-admin-notification-deliveries"]')
      expect(remedy!.textContent?.trim()).toBe('View delivery history')
      const cardText = stepCard('attendance-admin-notification-deliveries').textContent || ''
      expect(cardText.toLowerCase()).not.toContain('configure recipient scope')
    })

    it('renders the three unmerged notify signals on the ⑥ card (P2-2: 不得合并)', async () => {
      mount()
      await flushUi()
      const card = stepCard('attendance-admin-notification-deliveries')
      expect(card.querySelector('[data-setup-notify-runtime]')?.textContent).toContain('未知，去核查')
      expect(card.querySelector('[data-setup-notify-binding]')?.textContent).toContain('已绑定收件人: 5')
      expect(card.querySelector('[data-setup-notify-scope]')?.textContent).toContain('当前版本不支持')
    })
  })

  describe('⑦ manual activation checklist (§3⑦)', () => {
    it('always lists ④ and ⑥\'s three signals — even when ④ is customized and binding is healthy', async () => {
      mount()
      await flushUi()
      const checklist = stepCard('preview').querySelector('[data-setup-checklist]')
      expect(checklist).toBeTruthy()
      for (const item of ['punch-policy', 'delivery-runtime', 'recipient-binding', 'recipient-scope']) {
        expect(checklist!.querySelector(`[data-setup-checklist-item="${item}"]`), item).toBeTruthy()
      }
      expect(checklist!.querySelector('[data-setup-checklist-item="punch-policy"]')?.textContent).toContain('已自定义')
    })

    it('lists ④ as pending-confirmation when on the platform default, and never implies anything is enabled', async () => {
      mount({ steps: okSteps(mixedMissingResponse()), summary: mixedMissingResponse() })
      await flushUi()
      const checklist = stepCard('preview').querySelector('[data-setup-checklist]')
      expect(checklist!.querySelector('[data-setup-checklist-item="punch-policy"]')?.textContent).toContain('待确认')
      // §5.3/§3⑦ completion-claim negative, component-wide: no 已启用 / "enabled" anywhere.
      const fullText = container!.textContent || ''
      expect(fullText).not.toContain('已启用')
      expect(fullText.toLowerCase()).not.toContain('enabled')
    })
  })

  describe('load states — fail-closed', () => {
    it('error state renders the unknown-verify empty state and zero step cards', async () => {
      const { onReload } = mount({ steps: [], summary: null, loadState: 'error' })
      await flushUi()
      const errorBox = container!.querySelector('[data-setup-load-error]')
      expect(errorBox).toBeTruthy()
      expect(errorBox!.textContent).toContain('未知，去核查')
      expect(container!.querySelectorAll('[data-setup-step]')).toHaveLength(0)
      const reload = container!.querySelector<HTMLButtonElement>('[data-setup-reload]')
      reload!.click()
      await flushUi(2)
      expect(onReload).toHaveBeenCalledTimes(1)
    })

    it('loading state shows the loading empty state', async () => {
      mount({ steps: [], summary: null, loadState: 'loading' })
      await flushUi()
      expect(container!.querySelector('[data-setup-loading]')).toBeTruthy()
      expect(container!.querySelector('[data-setup-load-error]')).toBeNull()
    })
  })
})

describe('AttendanceSetupReadiness — AttendanceView wiring (section registration + task home + deep link)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let setupReadinessResponse: () => Response
  let setupReadinessCalls: string[] = []
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    // jsdom has no scrollIntoView; AttendanceView's section navigation calls it.
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    setupReadinessCalls = []
    setupReadinessResponse = () => jsonResponse(200, { ok: true, data: allReadyResponse() })
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/attendance-admin/setup-readiness')) {
        setupReadinessCalls.push(url)
        return setupReadinessResponse()
      }
      return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    } else {
      delete (HTMLElement.prototype as Partial<typeof HTMLElement.prototype>).scrollIntoView
    }
    app = null
    container = null
  })

  it('registers attendance-admin-setup as a canonical section id', () => {
    expect(ATTENDANCE_ADMIN_SECTION_IDS.setup).toBe('attendance-admin-setup')
  })

  it('task home: 「Setup readiness」 is the FIRST people-groups action; clicking it opens the wizard section and loads readiness with the exact orgId URL', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(24)

    const peopleGroup = container!.querySelector('[data-admin-task-group="people-groups"]')
    expect(peopleGroup).toBeTruthy()
    const actions = Array.from(peopleGroup!.querySelectorAll('[data-admin-task-action]'))
    expect(actions[0]?.getAttribute('data-admin-task-action')).toBe('setup-readiness')
    expect(actions[0]?.tagName).toBe('BUTTON')

    ;(actions[0] as HTMLButtonElement).click()
    await flushUi(16)

    const section = container!.querySelector<HTMLElement>('[data-attendance-setup-readiness-section]')
    expect(section).toBeTruthy()
    expect(section!.style.display).not.toBe('none')
    expect(section!.querySelector('[data-attendance-setup-readiness]')).toBeTruthy()
    // Exact wire shape: query-form orgId, blank org normalized to the plugin default.
    expect(setupReadinessCalls).toContain('/api/attendance-admin/setup-readiness?orgId=default')
  })

  it('task home badge: readiness-derived 「· incomplete」 hint appears when a gating step is missing, and NOT for advisory ④⑥ postures', async () => {
    setupReadinessResponse = () => jsonResponse(200, { ok: true, data: mixedMissingResponse() })
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(24)
    let setupAction = container!.querySelector('[data-admin-task-action="setup-readiness"]')
    expect(setupAction?.textContent).toContain('Setup readiness · incomplete')
    app.unmount()
    app = null
    container!.innerHTML = ''

    // ④ default (manual_review_required) + ⑥ unsupported with gating steps all ready → NO badge
    // (§6.1: advisory postures never trigger the hint — otherwise the dot never clears).
    setupReadinessResponse = () => jsonResponse(200, { ok: true, data: allReadyResponse({ punchPolicyPosture: 'default' }) })
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(24)
    setupAction = container!.querySelector('[data-admin-task-action="setup-readiness"]')
    expect(setupAction?.textContent).toContain('Setup readiness')
    expect(setupAction?.textContent).not.toContain('incomplete')
  })

  it('deep link: mounting with initialSectionId=attendance-admin-setup opens the wizard directly (query-form ?section= path)', async () => {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-setup' })
    app.mount(container!)
    await flushUi(24)

    const homeContext = container!.querySelector<HTMLElement>('[data-admin-home-context]')
    expect(homeContext?.style.display).toBe('none')
    const section = container!.querySelector<HTMLElement>('[data-attendance-setup-readiness-section]')
    expect(section).toBeTruthy()
    expect(section!.style.display).not.toBe('none')
    expect(section!.querySelector('[data-attendance-setup-readiness]')).toBeTruthy()
    expect(setupReadinessCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('re-entry recomputes readiness (OD-W4-7: no persisted wizard state) with an identical matrix for identical data', async () => {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-setup' })
    app.mount(container!)
    await flushUi(24)
    const callsAfterFirstEntry = setupReadinessCalls.length
    expect(callsAfterFirstEntry).toBeGreaterThanOrEqual(1)
    const firstMatrix = Array.from(container!.querySelectorAll('[data-setup-step-status]'))
      .map((el) => `${el.closest('[data-setup-step]')?.getAttribute('data-setup-step')}:${el.getAttribute('data-setup-step-status')}`)

    const returnHome = Array.from(container!.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Management home'))
    expect(returnHome).toBeTruthy()
    returnHome!.click()
    await flushUi(8)

    const setupAction = container!.querySelector<HTMLButtonElement>('[data-admin-task-action="setup-readiness"]')
    setupAction!.click()
    await flushUi(16)

    expect(setupReadinessCalls.length).toBeGreaterThan(callsAfterFirstEntry)
    const secondMatrix = Array.from(container!.querySelectorAll('[data-setup-step-status]'))
      .map((el) => `${el.closest('[data-setup-step]')?.getAttribute('data-setup-step')}:${el.getAttribute('data-setup-step-status')}`)
    expect(secondMatrix).toEqual(firstMatrix)
    expect(secondMatrix).toHaveLength(7)
  })
})

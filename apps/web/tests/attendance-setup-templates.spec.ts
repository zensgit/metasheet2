// W4-2 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §5/§9 W4-2): setup templates + prefill
// + ⑦ full preview derivation. Three layers:
//   1. pure module (attendanceSetupTemplates.ts): the four-template matrix against Appendix A
//      (exact ids/types/preset sets), the 时区禁硬编码 negative (NO timezone key, NO IANA-zone or
//      UTC string anywhere in the constants), plan building (blank timezone / unknown template /
//      invalid preset ⇒ NO plan — enum-strict, never a silent default), snapshot deep-copy.
//   2. wizard shell (AttendanceSetupReadiness.vue): template gallery render + `open-template`
//      emit (§7 component contract), ⑦ read-only impact derivation, checklist template item,
//      and the §5.3 completion-claim negatives on the FULL W4-2 surface (zh AND en legs).
//   3. AttendanceView wiring (the §5.2 contract end to end, mounted):
//      - 覆盖确认: template click opens the confirm dialog BEFORE any form write (mutation
//        target: silent overwrite ⇒ red), with the affected-field list and the dirty-target
//        warning; apply stays disabled until a timezone is resolved/chosen (§5.2④).
//      - 快照/取消: apply writes both forms + switches them to create-new mode; undo restores
//        every touched field AND the editing posture byte-identically.
//      - R3 (§0): the ENTIRE wizard/template/prefill interaction walk issues ZERO write-method
//        requests (mock network layer records every apiFetch call; mutation target: any PUT
//        fired during the preview surface ⇒ red).
//      - R4 (§0/§5.4): zero calls to the banned switch/trigger door list (settings PUT etc. —
//        the env-layer switches in §5.4 have no HTTP surface at all, so the R3 zero-write
//        superset covers them; the named list below is the API-reachable subset; mutation
//        target: a settings PUT from the wizard ⇒ red).
//      - OD-W4-7: unsaved-prefill beforeunload warning (armed after apply, disarmed by undo and
//        by the forms' own save paths); the IN-APP leave confirm (route-leave + attendance-shell
//        top-tab switch, via the shared attendanceSetupPrefillLeaveGuard signal); template
//        selection is NEVER persisted (zero template-related storage writes — the
//        storage-key-with-userId+orgId contract is N/A by construction because no local draft
//        storage exists in this slice).
//   4. dialog component (AttendanceSetupTemplatePrefillDialog.vue) rendered DIRECTLY in zh AND en
//      (both stages, all copy branches) — §5.3 completion-claim negatives over the dialog surface
//      itself, presence-anchored so neither leg can go skip-shaped green (W4-1 lesson, #3487).
//   5. AttendanceExperienceView navigation seams (memory router + child stubs): the OD-W4-7②
//      切区确认 legs — refusing the confirm keeps the tab/route, confirming proceeds, and no
//      prompt fires without a pending prefill.
// Wired into .github/workflows/attendance-web-guard.yml (run-list + relevant-change classifier).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import AttendanceSetupReadiness from '../src/views/attendance/AttendanceSetupReadiness.vue'
import AttendanceSetupTemplatePrefillDialog from '../src/views/attendance/AttendanceSetupTemplatePrefillDialog.vue'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import {
  attendanceSetupPrefillPending,
  confirmAttendanceSetupPrefillLeave,
} from '../src/views/attendance/attendanceSetupPrefillLeaveGuard'
import { apiFetch } from '../src/utils/api'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessResponse,
  type AttendanceSetupReadinessStepResult,
} from '../src/views/attendance/attendanceSetupReadiness'
import {
  ATTENDANCE_SETUP_TEMPLATE_IDS,
  ATTENDANCE_SETUP_TEMPLATES,
  buildAttendanceSetupTemplatePrefillPlan,
  captureAttendanceSetupPrefillSnapshot,
  diffAttendanceSetupFormFields,
  getAttendanceSetupTemplate,
  resolveAttendanceSetupOrgTimezone,
} from '../src/views/attendance/attendanceSetupTemplates'

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

// AttendanceExperienceView seam suite only (AttendanceView imports NONE of these, so the mounted
// §5.2 suite is unaffected): stub the four heavy tab children and the feature-flag store so the
// shell mounts fast and tab swaps are observable via data-testid markers.
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: () => true,
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../src/views/attendance/AttendanceOverview.vue', () => ({
  default: { name: 'AttendanceOverviewStub', template: '<div data-testid="attendance-overview">overview</div>' },
}))
vi.mock('../src/views/attendance/AttendanceReportsView.vue', () => ({
  default: { name: 'AttendanceReportsStub', template: '<div data-testid="attendance-reports">reports</div>' },
}))
vi.mock('../src/views/attendance/AttendanceAdminCenter.vue', () => ({
  default: { name: 'AttendanceAdminCenterStub', template: '<div data-testid="attendance-admin-center">admin-center</div>' },
}))
vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: { name: 'AttendanceWorkflowDesignerStub', template: '<div data-testid="attendance-workflow-designer">workflow</div>' },
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
const pickZh = (label: { en: string; zh: string }) => label.zh

// ---------------------------------------------------------------------------
// 1. Pure module
// ---------------------------------------------------------------------------

describe('attendanceSetupTemplates (pure module)', () => {
  it('exposes exactly the four Appendix-A templates, in card order, with the locked attendance types', () => {
    expect(ATTENDANCE_SETUP_TEMPLATE_IDS).toEqual([
      'office-fixed',
      'store-scheduled',
      'factory-multi-shift',
      'field-sales',
    ])
    expect(ATTENDANCE_SETUP_TEMPLATES.map((t) => t.id)).toEqual([...ATTENDANCE_SETUP_TEMPLATE_IDS])
    expect(ATTENDANCE_SETUP_TEMPLATES.map((t) => t.attendanceType)).toEqual([
      'fixed_shift', // 办公室固定班
      'scheduled_shift', // 门店排班
      'scheduled_shift', // 工厂多班次
      'free_time', // 销售/外勤
    ])
  })

  it('preset sets match Appendix A: office 1 / store 2 / factory 3 (with an overnight night shift) / field-sales 0 (+ settings hint)', () => {
    const [office, store, factory, sales] = ATTENDANCE_SETUP_TEMPLATES
    expect(office.shiftPresets.map((p) => [p.key, p.workStartTime, p.workEndTime, p.workingDays])).toEqual([
      ['office-day', '09:00', '18:00', '1,2,3,4,5'],
    ])
    expect(office.shiftPresets[0].lateGraceMinutes).toBe(10)
    expect(office.shiftPresets[0].earlyGraceMinutes).toBe(10)
    expect(store.shiftPresets.map((p) => p.key)).toEqual(['store-early', 'store-late'])
    expect(factory.shiftPresets.map((p) => p.key)).toEqual(['factory-early', 'factory-middle', 'factory-night'])
    const night = factory.shiftPresets[2]
    expect(night.overnight).toBe(true)
    expect(night.workStartTime).toBe('22:00')
    expect(night.workEndTime).toBe('06:00')
    expect(sales.shiftPresets).toEqual([])
    expect(sales.settingsHint).not.toBeNull()
    // ③ step3Ready 联动: both scheduled_shift templates carry the rotation-rule hint; the others don't.
    expect(store.rotationRuleHint).not.toBeNull()
    expect(factory.rotationRuleHint).not.toBeNull()
    expect(office.rotationRuleHint).toBeNull()
    expect(sales.rotationRuleHint).toBeNull()
  })

  it('every preset is form-legal: HH:mm windows, working days a comma list of 1..7, non-negative minutes, safe display names', () => {
    for (const template of ATTENDANCE_SETUP_TEMPLATES) {
      for (const label of [template.name, template.description, template.group.name]) {
        expect(label.en.trim().length).toBeGreaterThan(0)
        expect(label.zh.trim().length).toBeGreaterThan(0)
      }
      // normalizeSafeDisplayName rejects <>, quotes and backticks — prefilled names must pass it.
      expect(template.group.name.en).not.toMatch(/[<>"'`]/)
      expect(template.group.name.zh).not.toMatch(/[<>"'`]/)
      for (const preset of template.shiftPresets) {
        expect(preset.workStartTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
        expect(preset.workEndTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
        expect(preset.workingDays).toMatch(/^[1-7](,[1-7])*$/)
        expect(preset.lateGraceMinutes).toBeGreaterThanOrEqual(0)
        expect(preset.earlyGraceMinutes).toBeGreaterThanOrEqual(0)
        expect(preset.roundingMinutes).toBeGreaterThanOrEqual(0)
        expect(preset.label.en).not.toMatch(/[<>"'`]/)
        expect(preset.label.zh).not.toMatch(/[<>"'`]/)
        // The overnight display flag is DERIVED truth, not free copy: it must equal end<=start.
        expect(preset.overnight, preset.key).toBe(preset.workEndTime <= preset.workStartTime)
      }
    }
  })

  it('时区禁硬编码 (§5.2④): the template constants contain NO timezone key and NO IANA-zone/UTC string anywhere', () => {
    const serialized = JSON.stringify(ATTENDANCE_SETUP_TEMPLATES)
    expect(serialized).not.toContain('"timezone"')
    expect(serialized).not.toContain('timeZone')
    expect(serialized).not.toMatch(/(Asia|America|Europe|Africa|Australia|Pacific|Atlantic|Indian|Etc)\//)
    expect(serialized).not.toContain('UTC')
    expect(serialized).not.toContain('GMT')
  })

  describe('resolveAttendanceSetupOrgTimezone (§5.2④ org explicit value or nothing)', () => {
    it('exactly one distinct explicit value → that value (duplicates/blank/null entries ignored)', () => {
      expect(resolveAttendanceSetupOrgTimezone(['Asia/Shanghai'])).toBe('Asia/Shanghai')
      expect(resolveAttendanceSetupOrgTimezone(['Asia/Shanghai', 'Asia/Shanghai', '', null, undefined, '  '])).toBe('Asia/Shanghai')
    })

    it('zero values (first-run org) → null — the browser timezone must NOT flow in as a fallback', () => {
      expect(resolveAttendanceSetupOrgTimezone([])).toBeNull()
      expect(resolveAttendanceSetupOrgTimezone(['', null, undefined])).toBeNull()
    })

    it('multiple distinct values (ambiguous) → null — never silently picks one', () => {
      expect(resolveAttendanceSetupOrgTimezone(['Asia/Shanghai', 'America/New_York'])).toBeNull()
    })
  })

  describe('buildAttendanceSetupTemplatePrefillPlan', () => {
    it('office template + timezone → the EXACT full plan (group + one shift, timezone injected everywhere)', () => {
      const plan = buildAttendanceSetupTemplatePrefillPlan({
        templateId: 'office-fixed',
        shiftPresetKey: 'office-day',
        timezone: 'Asia/Shanghai',
        pickLabel: pickZh,
      })
      expect(plan).toEqual({
        templateId: 'office-fixed',
        group: {
          name: '办公室考勤组',
          attendanceType: 'fixed_shift',
          timezone: 'Asia/Shanghai',
        },
        shift: {
          presetKey: 'office-day',
          name: '办公室班次 09:00-18:00',
          timezone: 'Asia/Shanghai',
          workStartTime: '09:00',
          workEndTime: '18:00',
          lateGraceMinutes: 10,
          earlyGraceMinutes: 10,
          roundingMinutes: 5,
          workingDays: '1,2,3,4,5',
        },
        hasSettingsHint: false,
      })
    })

    it('field-sales template → group-only plan (no shift) with the settings hint flag', () => {
      const plan = buildAttendanceSetupTemplatePrefillPlan({
        templateId: 'field-sales',
        shiftPresetKey: null,
        timezone: 'America/New_York',
        pickLabel: pickZh,
      })
      expect(plan).toEqual({
        templateId: 'field-sales',
        group: {
          name: '外勤考勤组',
          attendanceType: 'free_time',
          timezone: 'America/New_York',
        },
        shift: null,
        hasSettingsHint: true,
      })
    })

    it('a non-first preset is honored exactly (store late shift)', () => {
      const plan = buildAttendanceSetupTemplatePrefillPlan({
        templateId: 'store-scheduled',
        shiftPresetKey: 'store-late',
        timezone: 'Asia/Shanghai',
        pickLabel: pickZh,
      })
      expect(plan?.shift).toEqual({
        presetKey: 'store-late',
        name: '门店晚班 14:00-22:00',
        timezone: 'Asia/Shanghai',
        workStartTime: '14:00',
        workEndTime: '22:00',
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
        roundingMinutes: 5,
        workingDays: '1,2,3,4,5,6,7',
      })
    })

    it('blank/whitespace timezone → NO plan (never a silent default — §5.2④)', () => {
      for (const timezone of ['', '   ']) {
        expect(
          buildAttendanceSetupTemplatePrefillPlan({
            templateId: 'office-fixed',
            shiftPresetKey: 'office-day',
            timezone,
            pickLabel: pickZh,
          }),
        ).toBeNull()
      }
    })

    it('unknown template id → NO plan (enum-strict; invalid value is not mapped to any template)', () => {
      expect(
        buildAttendanceSetupTemplatePrefillPlan({
          templateId: 'no-such-template',
          shiftPresetKey: null,
          timezone: 'Asia/Shanghai',
          pickLabel: pickZh,
        }),
      ).toBeNull()
      expect(getAttendanceSetupTemplate('no-such-template')).toBeNull()
    })

    it('invalid preset key for a template WITH presets → NO plan (never "pick the first one")', () => {
      for (const shiftPresetKey of [null, 'office-day', 'bogus']) {
        expect(
          buildAttendanceSetupTemplatePrefillPlan({
            templateId: 'store-scheduled',
            shiftPresetKey,
            timezone: 'Asia/Shanghai',
            pickLabel: pickZh,
          }),
          String(shiftPresetKey),
        ).toBeNull()
      }
    })
  })

  it('captureAttendanceSetupPrefillSnapshot deep-copies exactly the apply-mutated state (later source edits do not leak in)', () => {
    const group = { name: 'A', code: 'c', timezone: 'Asia/Shanghai', ruleSetId: 'r', attendanceType: 'fixed_shift', description: 'd' }
    const shift = { name: 'S', timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', lateGraceMinutes: 1, earlyGraceMinutes: 2, roundingMinutes: 3, workingDays: '1,2' }
    const snapshot = captureAttendanceSetupPrefillSnapshot({ group, shift, groupEditingId: 'g1', shiftEditingId: null })
    expect(snapshot).toEqual({ group: { ...group }, shift: { ...shift }, groupEditingId: 'g1', shiftEditingId: null })
    group.name = 'MUTATED'
    shift.workStartTime = '00:00'
    expect(snapshot.group.name).toBe('A')
    expect(snapshot.shift.workStartTime).toBe('09:00')
  })

  it('diffAttendanceSetupFormFields returns exactly the differing field names', () => {
    const baseline = { name: '', code: '', timezone: 'UTC' }
    expect(diffAttendanceSetupFormFields({ name: 'x', code: '', timezone: 'UTC' }, baseline, ['name', 'code', 'timezone'])).toEqual(['name'])
    expect(diffAttendanceSetupFormFields({ name: '', code: '', timezone: 'UTC' }, baseline, ['name', 'code', 'timezone'])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Wizard shell — gallery + ⑦ derivation + checklist template item + copy negatives
// ---------------------------------------------------------------------------

describe('AttendanceSetupReadiness shell — W4-2 gallery + ⑦ derivation', () => {
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
    pendingTemplateId?: string | null
    tr?: (en: string, zh: string) => string
  }

  function mount(props: MountProps = {}) {
    const onSelectSection = vi.fn()
    const onOpenTemplate = vi.fn()
    const data = allReadyResponse()
    app = createApp(AttendanceSetupReadiness, {
      tr: props.tr ?? zhTr,
      steps: props.steps ?? okSteps(data),
      summary: props.summary === undefined ? data : props.summary,
      loadState: props.loadState ?? 'loaded',
      viewerIsPlatformAdmin: props.viewerIsPlatformAdmin ?? true,
      pendingTemplateId: props.pendingTemplateId ?? null,
      onSelectSection,
      onOpenTemplate,
      onReload: vi.fn(),
    })
    app.mount(container!)
    return { onSelectSection, onOpenTemplate }
  }

  it('renders the four template cards in order; each card button emits open-template with its exact id', async () => {
    const { onOpenTemplate } = mount()
    await flushUi()
    const cards = Array.from(container!.querySelectorAll('[data-setup-template-card]'))
    expect(cards.map((el) => el.getAttribute('data-setup-template-card'))).toEqual([...ATTENDANCE_SETUP_TEMPLATE_IDS])
    for (const id of ATTENDANCE_SETUP_TEMPLATE_IDS) {
      const button = container!.querySelector<HTMLButtonElement>(`[data-setup-template-open="${id}"]`)
      expect(button, id).toBeTruthy()
      button!.click()
      await flushUi(1)
      expect(onOpenTemplate).toHaveBeenLastCalledWith(id)
    }
    expect(onOpenTemplate).toHaveBeenCalledTimes(4)
  })

  it('gallery requires a loaded ok aggregate: absent for forbidden / db_not_ready / error / loading states', async () => {
    const states: MountProps[] = [
      { steps: deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' }), summary: null },
      { steps: deriveAttendanceSetupReadinessSteps({ kind: 'db_not_ready' }), summary: null },
      { steps: [], summary: null, loadState: 'error' },
      { steps: [], summary: null, loadState: 'loading' },
    ]
    for (const props of states) {
      mount(props)
      await flushUi()
      expect(container!.querySelector('[data-setup-templates]')).toBeNull()
      app!.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  it('the gallery renders NO timezone value (nothing to render — the constants carry none, §5.2④)', async () => {
    mount()
    await flushUi()
    const galleryText = container!.querySelector('[data-setup-templates]')!.textContent || ''
    expect(galleryText).not.toMatch(/(Asia|America|Europe|Africa|Australia|Pacific|Atlantic|Indian|Etc)\//)
    expect(galleryText).not.toContain('UTC')
    // And the gallery states the prefill-only promise (只预填不保存).
    expect(galleryText).toContain('不保存')
  })

  it('⑦ derivation panel: population from ①② counts, gating recap, resource counts, advisory line (all-ready fixture)', async () => {
    mount()
    await flushUi()
    const derivation = container!.querySelector('[data-setup-preview-derivation]')
    expect(derivation).toBeTruthy()
    expect(derivation!.querySelector('[data-setup-preview-derivation-population]')?.textContent)
      .toContain('本组织有效成员 12')
    expect(derivation!.querySelector('[data-setup-preview-derivation-population]')?.textContent)
      .toContain('有成员的考勤组 3/3')
    expect(derivation!.querySelector('[data-setup-preview-derivation-gating]')?.textContent)
      .toContain('4/4 已完成')
    const resources = derivation!.querySelector('[data-setup-preview-derivation-resources]')?.textContent || ''
    expect(resources).toContain('班次 4')
    expect(resources).toContain('排班制组 1')
    expect(resources).toContain('启用轮班规则 2')
    expect(resources).toContain('启用审批流 2')
    const advisory = derivation!.querySelector('[data-setup-preview-derivation-advisory]')?.textContent || ''
    expect(advisory).toContain('不参与 preview-ready 判定')
    expect(advisory).toContain('已自定义')
  })

  it('⑦ derivation gating recap names the incomplete required steps (mixed-missing fixture: ① ② ③ ⑤)', async () => {
    mount({ steps: okSteps(mixedMissingResponse()), summary: mixedMissingResponse() })
    await flushUi()
    const gating = container!.querySelector('[data-setup-preview-derivation-gating]')?.textContent || ''
    expect(gating).toContain('0/4 已完成')
    expect(gating).toContain('未完成: ① ② ③ ⑤')
  })

  it('checklist template item: absent without a pending prefill; present with group+shift jumps for a preset template', async () => {
    mount()
    await flushUi()
    expect(container!.querySelector('[data-setup-checklist-item="template-prefill"]')).toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    const { onSelectSection } = mount({ pendingTemplateId: 'office-fixed' })
    await flushUi()
    const item = container!.querySelector('[data-setup-checklist-item="template-prefill"]')
    expect(item).toBeTruthy()
    expect(item!.textContent).toContain('办公室固定班')
    expect(item!.textContent).toContain('尚未保存')
    const groupRemedy = item!.querySelector<HTMLButtonElement>('[data-setup-checklist-remedy="template-group-form"]')
    const shiftRemedy = item!.querySelector<HTMLButtonElement>('[data-setup-checklist-remedy="template-shift-form"]')
    expect(groupRemedy).toBeTruthy()
    expect(shiftRemedy).toBeTruthy()
    groupRemedy!.click()
    await flushUi(1)
    expect(onSelectSection).toHaveBeenLastCalledWith('attendance-admin-groups')
    shiftRemedy!.click()
    await flushUi(1)
    expect(onSelectSection).toHaveBeenLastCalledWith('attendance-admin-shifts')
  })

  it('checklist template item for a presetless template (field-sales) offers NO shift-form jump', async () => {
    mount({ pendingTemplateId: 'field-sales' })
    await flushUi()
    const item = container!.querySelector('[data-setup-checklist-item="template-prefill"]')
    expect(item).toBeTruthy()
    expect(item!.querySelector('[data-setup-checklist-remedy="template-group-form"]')).toBeTruthy()
    expect(item!.querySelector('[data-setup-checklist-remedy="template-shift-form"]')).toBeNull()
  })

  it('§5.3 completion-claim negative on the FULL W4-2 surface — zh leg: no 已启用 / 已生效 anywhere (gallery + derivation + pending checklist item all PRESENT, both fixtures)', async () => {
    for (const data of [allReadyResponse(), mixedMissingResponse()]) {
      mount({ steps: okSteps(data), summary: data, pendingTemplateId: 'factory-multi-shift', tr: zhTr })
      await flushUi()
      // Presence anchors — every surface the sweep claims to cover must actually be in the DOM,
      // or the negative degrades to a vacuous pass when wiring drifts.
      expect(container!.querySelector('[data-setup-templates]')).toBeTruthy()
      expect(container!.querySelector('[data-setup-preview-derivation]')).toBeTruthy()
      expect(container!.querySelector('[data-setup-checklist-item="template-prefill"]')).toBeTruthy()
      const fullText = container!.textContent || ''
      expect(fullText).not.toContain('已启用')
      expect(fullText).not.toContain('已生效')
      app!.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  it('§5.3 completion-claim negative — en leg: no "enabled"/"activated" completion claims anywhere (same three surfaces PRESENT, both fixtures)', async () => {
    for (const data of [allReadyResponse(), mixedMissingResponse()]) {
      mount({ steps: okSteps(data), summary: data, pendingTemplateId: 'factory-multi-shift', tr: enTr })
      await flushUi()
      expect(container!.querySelector('[data-setup-templates]')).toBeTruthy()
      expect(container!.querySelector('[data-setup-preview-derivation]')).toBeTruthy()
      expect(container!.querySelector('[data-setup-checklist-item="template-prefill"]')).toBeTruthy()
      const fullText = (container!.textContent || '').toLowerCase()
      expect(fullText).not.toMatch(/\benabled\b/)
      expect(fullText).not.toMatch(/\bactivated\b/)
      app!.unmount()
      app = null
      container!.innerHTML = ''
    }
  })
})

// ---------------------------------------------------------------------------
// 3. AttendanceView wiring — the §5.2 prefill contract end to end
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string
  method: string
  body: string | null
}

/** R4 (§5.4) banned switch/trigger doors — the API-reachable subset. The env-layer switches
 *  (ATTENDANCE_SCHEDULER_ENABLED, ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED,
 *  ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED, ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_ENABLED,
 *  ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK, ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED,
 *  ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED, ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED,
 *  ATTENDANCE_REPORT_DIGEST_ENABLED, ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED — lock §5.4
 *  list, S7/notification-worker/scheduler switches included) have NO HTTP surface at all, so the
 *  zero-write superset assertion covers them; the settings-layer enabled keys (autoAbsence /
 *  holidaySync.auto / compTimeFromOvertime / multiShiftDay / annualLeavePolicy /
 *  attendanceResultEditPolicy) are ALL behind the single settings PUT door listed first. */
const R4_BANNED_DOOR_PATTERNS: readonly { pattern: string; note: string }[] = [
  { pattern: '/api/attendance/settings', note: 'settings PUT door — save triggers rescheduling + events (整体禁写)' },
  { pattern: '/api/attendance/holidays/sync', note: 'holiday-sync trigger (machine-writes settings.holidaySync.lastRun)' },
  { pattern: '/api/attendance/auto-absence/run', note: 'auto-absence job trigger' },
  { pattern: '/api/attendance/annual-leave-accrual/run', note: 'annual-leave accrual job trigger' },
  { pattern: '/api/attendance/annual-leave-expiry-backfill', note: 'annual-leave expiry backfill trigger' },
  { pattern: '/api/attendance/auto-shift-matching', note: 'auto-shift-matching preview/apply triggers' },
  { pattern: '/api/attendance/report-fields/sync', note: 'report-field sync trigger' },
  { pattern: '/api/attendance/report-records/sync', note: 'report-record sync trigger' },
  { pattern: '/api/attendance/report-period-summaries/sync', note: 'report period-summary sync trigger' },
  { pattern: '/api/attendance/report-sync-jobs', note: 'report sync-job control surface' },
  { pattern: '/api/attendance/manual-missed-punch-reminders/enqueue', note: 'notification enqueue trigger' },
  { pattern: '/api/attendance/integrations', note: 'integration write/sync surface (外发)' },
]

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

describe('AttendanceView wiring — §5.2 template prefill contract (mounted)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let calls: RecordedCall[] = []
  let groupsFixture: () => unknown[]
  let shiftsFixture: () => unknown[]
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  const ORG_GROUP = {
    id: 'g1',
    name: 'Store A',
    code: null,
    timezone: 'Asia/Shanghai',
    ruleSetId: null,
    description: null,
    memberCount: 3,
    attendanceType: 'fixed_shift',
  }

  // Every field deliberately differs from BOTH the pristine defaults and every template value, so
  // a restore assertion over this record can never pass vacuously (finding: grace/rounding/
  // workingDays previously had no non-default current value anywhere in the suite).
  const ORG_SHIFT = {
    id: 's1',
    name: 'Night audit shift',
    timezone: 'Asia/Shanghai',
    workStartTime: '10:30',
    workEndTime: '19:30',
    segments: [
      {
        id: 's1-segment-1',
        segmentIndex: 0,
        startTime: '10:30',
        startDayOffset: 0,
        endTime: '14:00',
        endDayOffset: 0,
      },
      {
        id: 's1-segment-2',
        segmentIndex: 1,
        startTime: '15:00',
        startDayOffset: 0,
        endTime: '19:30',
        endDayOffset: 0,
      },
    ],
    calculationMode: 'segments',
    plannedMinutes: 480,
    capabilities: {
      segmentCalculation: {
        enabled: false,
        authoritativeResults: false,
        multiSegmentAuthoring: 'preview_only',
      },
    },
    lateGraceMinutes: 25,
    earlyGraceMinutes: 20,
    roundingMinutes: 15,
    workingDays: [2, 3, 4, 5, 6],
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    calls = []
    groupsFixture = () => [ORG_GROUP]
    shiftsFixture = () => [ORG_SHIFT]
    attendanceSetupPrefillPending.value = false
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
      if (url.includes('/api/attendance-admin/setup-readiness')) {
        return jsonResponse(200, { ok: true, data: allReadyResponse() })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        const items = groupsFixture()
        return jsonResponse(200, { ok: true, data: { items, total: items.length } })
      }
      if (url === '/api/attendance/groups' && method === 'POST') {
        return jsonResponse(200, { ok: true, data: { ...ORG_GROUP, id: 'g-new', name: 'Office attendance group' } })
      }
      if (url.startsWith('/api/attendance/groups/') && method === 'PUT') {
        return jsonResponse(200, { ok: true, data: { ...ORG_GROUP } })
      }
      if (url.startsWith('/api/attendance/shifts?')) {
        const items = shiftsFixture()
        return jsonResponse(200, { ok: true, data: { items, total: items.length } })
      }
      if (url === '/api/attendance/shifts' && method === 'POST') {
        return jsonResponse(200, { ok: true, data: { id: 's-new' } })
      }
      if (url.startsWith('/api/attendance/shifts/') && method === 'PUT') {
        return jsonResponse(200, { ok: true, data: { ...ORG_SHIFT } })
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
    attendanceSetupPrefillPending.value = false
  })

  async function mountWizard(): Promise<void> {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-setup' })
    app.mount(container!)
    await flushUi(24)
    expect(container!.querySelector('[data-setup-templates]')).toBeTruthy()
  }

  function openTemplate(id: string): HTMLElement {
    const button = container!.querySelector<HTMLButtonElement>(`[data-setup-template-open="${id}"]`)
    expect(button, id).toBeTruthy()
    button!.click()
    return button!
  }

  function dialog(): HTMLElement | null {
    return container!.querySelector<HTMLElement>('[data-setup-template-dialog]')
  }

  function groupNameInput(): HTMLInputElement {
    return container!.querySelector<HTMLInputElement>('#attendance-group-name')!
  }

  function shiftNameInput(): HTMLInputElement {
    return container!.querySelector<HTMLInputElement>('#attendance-shift-name')!
  }

  /** EVERY field applySetupTemplate writes (plus both save-button labels = the editing posture),
   *  so a before/after deepEqual can never pass on a partial restore. */
  function readFormState() {
    const shiftSegments = Array.from(
      container!.querySelectorAll<HTMLElement>('[data-attendance-shift-segment-row]'),
    ).map((row) => ({
      startTime: row.querySelector<HTMLInputElement>('[data-attendance-shift-segment-start]')!.value,
      startDayOffset: 0,
      endTime: row.querySelector<HTMLInputElement>('[data-attendance-shift-segment-end]')!.value,
      endDayOffset: Number(
        row.querySelector<HTMLSelectElement>('[data-attendance-shift-segment-end-day]')!.value,
      ),
    }))
    return {
      groupName: groupNameInput().value,
      groupTimezone: container!.querySelector<HTMLSelectElement>('#attendance-group-timezone')!.value,
      groupType: container!.querySelector<HTMLSelectElement>('#attendance-group-type')!.value,
      shiftName: shiftNameInput().value,
      shiftSegments,
      shiftTimezone: container!.querySelector<HTMLSelectElement>('#attendance-shift-timezone')!.value,
      shiftLateGrace: container!.querySelector<HTMLInputElement>('#attendance-shift-late-grace')!.value,
      shiftEarlyGrace: container!.querySelector<HTMLInputElement>('#attendance-shift-early-grace')!.value,
      shiftRounding: container!.querySelector<HTMLInputElement>('#attendance-shift-rounding')!.value,
      shiftWorkingDays: container!.querySelector<HTMLInputElement>('#attendance-shift-working-days')!.value,
      groupSaveLabel: groupSaveButton().textContent?.trim(),
      shiftSaveLabel: shiftSaveButton().textContent?.trim(),
    }
  }

  function groupSaveButton(): HTMLButtonElement {
    const button = Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
      const text = b.textContent?.trim() || ''
      return text === 'Save group' || text === 'Create group'
    })
    expect(button, 'group save button').toBeTruthy()
    return button!
  }

  function shiftSaveButton(): HTMLButtonElement {
    const button = Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
      const text = b.textContent?.trim() || ''
      return text === 'Create shift' || text === 'Update shift'
    })
    expect(button, 'shift save button').toBeTruthy()
    return button!
  }

  /** Load the existing ORG_SHIFT record into the shift form (edit mode) — gives the shift leg a
   *  non-pristine, non-template current state + a non-null shiftEditingId. */
  async function selectExistingShift(): Promise<void> {
    const cell = Array.from(container!.querySelectorAll('td')).find(
      (td) => td.textContent?.trim() === 'Night audit shift',
    )
    expect(cell, 'ORG_SHIFT table row').toBeTruthy()
    const edit = Array.from(cell!.closest('tr')!.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Edit',
    )
    expect(edit, 'shift Edit button').toBeTruthy()
    edit!.click()
    await flushUi()
    expect(shiftSaveButton().textContent?.trim()).toBe('Update shift')
  }

  it('覆盖确认 (§5.2①, mutation target: silent overwrite ⇒ red): the template click opens the confirm dialog and writes NOTHING until apply', async () => {
    await mountWizard()
    // loadAttendanceGroups auto-selects the existing org group into the form (edit mode).
    expect(groupNameInput().value).toBe('Store A')
    const before = readFormState()
    expect(before.groupSaveLabel).toBe('Save group')

    openTemplate('office-fixed')
    await flushUi()
    const confirm = dialog()
    expect(confirm).toBeTruthy()
    expect(confirm!.getAttribute('data-setup-template-dialog-stage')).toBe('confirm')
    // Nothing applied yet — the forms are untouched while the dialog is open.
    expect(readFormState()).toEqual(before)
    // Affected-field list renders (org timezone resolved from the saved group ⇒ plan exists) and
    // lists the COMPLETE apply-write field set — exactly the fields applySetupTemplate writes,
    // in order, no omission (finding: roundingMinutes was written but unlisted).
    expect(confirm!.querySelector('[data-setup-template-field-changes]')).toBeTruthy()
    expect(
      Array.from(confirm!.querySelectorAll('[data-setup-template-field-change]')).map((el) =>
        el.getAttribute('data-setup-template-field-change'),
      ),
    ).toEqual([
      'group.name',
      'group.attendanceType',
      'group.timezone',
      'shift.name',
      'shift.window',
      'shift.timezone',
      'shift.grace',
      'shift.rounding',
      'shift.workingDays',
    ])
    const nameRow = confirm!.querySelector('[data-setup-template-field-change="group.name"]')
    expect(nameRow?.textContent).toContain('Store A')
    expect(nameRow?.textContent).toContain('Office attendance group')
    // Dirty-target warning: the form holds a selected existing record.
    expect(confirm!.querySelector('[data-setup-template-dirty-warning]')).toBeTruthy()
    // Cancel applies nothing.
    confirm!.querySelector<HTMLButtonElement>('[data-setup-template-cancel]')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    expect(readFormState()).toEqual(before)
  })

  it('§5.2① every confirm row shows the REAL current value (selected shift: grace/rounding/workingDays all non-default, all listed current → template)', async () => {
    await mountWizard()
    await selectExistingShift()
    openTemplate('office-fixed')
    await flushUi()
    const confirm = dialog()!
    const rowText = (key: string): string =>
      confirm.querySelector(`[data-setup-template-field-change="${key}"]`)?.textContent || ''
    expect(rowText('shift.name')).toContain('Night audit shift')
    expect(rowText('shift.name')).toContain('Office shift 09:00-18:00')
    expect(rowText('shift.window')).toContain('10:30-19:30')
    expect(rowText('shift.window')).toContain('09:00-18:00')
    expect(rowText('shift.grace')).toContain('25/20')
    expect(rowText('shift.grace')).toContain('10/10')
    expect(rowText('shift.rounding')).toContain('15')
    expect(rowText('shift.rounding')).toContain('5')
    expect(rowText('shift.workingDays')).toContain('2,3,4,5,6')
    expect(rowText('shift.workingDays')).toContain('1,2,3,4,5')
    // Both target forms hold existing records ⇒ the dirty warning names the risk, and its copy
    // scopes the undo promise to this dialog (no promise survives the dialog).
    const warning = confirm.querySelector('[data-setup-template-dirty-warning]')
    expect(warning).toBeTruthy()
    expect(warning!.textContent).toContain('ONLY while this dialog stays open')
    confirm.querySelector<HTMLButtonElement>('[data-setup-template-cancel]')!.click()
    await flushUi()
  })

  it('§5.2④ timezone: org current value preselected when resolvable; first-run org REQUIRES a user choice (apply disabled until chosen; browser timezone never leaks in)', async () => {
    await mountWizard()
    openTemplate('office-fixed')
    await flushUi()
    let confirm = dialog()!
    expect(confirm.querySelector('[data-setup-template-timezone-org]')?.textContent).toContain('Asia/Shanghai')
    const select = confirm.querySelector<HTMLSelectElement>('[data-setup-template-timezone-select]')!
    expect(select.value).toBe('Asia/Shanghai')
    expect(confirm.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.disabled).toBe(false)
    confirm.querySelector<HTMLButtonElement>('[data-setup-template-cancel]')!.click()
    await flushUi()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // First-run org: zero saved groups ⇒ no org timezone ⇒ required user choice.
    groupsFixture = () => []
    await mountWizard()
    openTemplate('office-fixed')
    await flushUi()
    confirm = dialog()!
    expect(confirm.querySelector('[data-setup-template-timezone-org]')).toBeNull()
    expect(confirm.querySelector('[data-setup-template-timezone-required]')).toBeTruthy()
    const emptySelect = confirm.querySelector<HTMLSelectElement>('[data-setup-template-timezone-select]')!
    expect(emptySelect.value).toBe('')
    const apply = confirm.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!
    expect(apply.disabled).toBe(true)
    // No affected-field list yet — there is no plan without a timezone.
    expect(confirm.querySelector('[data-setup-template-field-changes]')).toBeNull()
    // The user actively chooses a zone → plan forms, apply enables.
    emptySelect.value = 'Asia/Shanghai'
    emptySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(confirm.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.disabled).toBe(false)
    expect(confirm.querySelector('[data-setup-template-field-changes]')).toBeTruthy()
  })

  it('快照/取消 (§5.2②, mutation target: partial restore ⇒ red): apply writes both forms + create-new posture; undo restores EVERYTHING byte-identically', async () => {
    await mountWizard()
    // BOTH forms hold selected existing records — every shift field (grace/rounding/workingDays
    // included) differs from both pristine and template values, so a partial restore of any
    // single field turns the final deepEqual red (nothing vacuous).
    await selectExistingShift()
    const before = readFormState()
    expect(before.groupSaveLabel).toBe('Save group') // an existing group record is selected
    expect(before.shiftSaveLabel).toBe('Update shift') // an existing shift record is selected
    expect(before.shiftRounding).toBe('15')

    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()

    const applied = dialog()!
    expect(applied.getAttribute('data-setup-template-dialog-stage')).toBe('applied')
    expect(applied.querySelector('[data-setup-template-applied-note]')?.textContent).toContain('NOT saved')
    // Both forms now hold the exact template values; editing posture switched to create-new.
    expect(readFormState()).toEqual({
      groupName: 'Office attendance group',
      groupTimezone: 'Asia/Shanghai',
      groupType: 'fixed_shift',
      shiftName: 'Office shift 09:00-18:00',
      shiftSegments: [{
        startTime: '09:00',
        startDayOffset: 0,
        endTime: '18:00',
        endDayOffset: 0,
      }],
      shiftTimezone: 'Asia/Shanghai',
      shiftLateGrace: '10',
      shiftEarlyGrace: '10',
      shiftRounding: '5',
      shiftWorkingDays: '1,2,3,4,5',
      groupSaveLabel: 'Create group',
      shiftSaveLabel: 'Create shift',
    })

    applied.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    // Byte-identical restore of every touched field INCLUDING both editing postures.
    expect(readFormState()).toEqual(before)
  })

  it('after undo, saving the group targets the RESTORED existing record (PUT /groups/g1) — the snapshot restored the editing id, not just field text', async () => {
    await mountWizard()
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    calls = []
    groupSaveButton().click()
    await flushUi(12)
    const writes = calls.filter((c) => WRITE_METHODS.has(c.method))
    expect(writes.map((c) => ({ url: c.url, method: c.method }))).toEqual([
      { url: '/api/attendance/groups/g1', method: 'PUT' },
    ])
    // Exact restored payload: the ORIGINAL record's values, not template values (no orgId key —
    // the harness org is blank and JSON.stringify drops the undefined normalizedOrgId()).
    expect(JSON.parse(writes[0].body || 'null')).toEqual({
      name: 'Store A',
      code: null,
      timezone: 'Asia/Shanghai',
      ruleSetId: null,
      attendanceType: 'fixed_shift',
      description: null,
    })
  })

  it('after undo, saving the shift targets the RESTORED existing shift (PUT /shifts/s1) with the exact original body — the snapshot restored the shift editing id AND every shift field at the wire', async () => {
    await mountWizard()
    await selectExistingShift()
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    calls = []
    shiftSaveButton().click()
    await flushUi(12)
    const writes = calls.filter((c) => WRITE_METHODS.has(c.method))
    expect(writes.map((c) => ({ url: c.url, method: c.method }))).toEqual([
      { url: '/api/attendance/shifts/s1', method: 'PUT' },
    ])
    // Full canonical body shape — the ORIGINAL two-segment shift plus its non-default
    // grace/rounding/workingDays. Any missed field in undoSetupTemplate turns this red; no orgId
    // key because the harness org is blank and JSON.stringify drops normalizedOrgId().
    expect(JSON.parse(writes[0].body || 'null')).toEqual({
      name: 'Night audit shift',
      timezone: 'Asia/Shanghai',
      segments: [
        {
          segmentIndex: 0,
          startTime: '10:30',
          startDayOffset: 0,
          endTime: '14:00',
          endDayOffset: 0,
        },
        {
          segmentIndex: 1,
          startTime: '15:00',
          startDayOffset: 0,
          endTime: '19:30',
          endDayOffset: 0,
        },
      ],
      lateGraceMinutes: 25,
      earlyGraceMinutes: 20,
      roundingMinutes: 15,
      workingDays: [2, 3, 4, 5, 6],
    })
  })

  it('after apply (no undo), saving the group CREATES (POST /api/attendance/groups) with the exact template payload — never a PUT over the previously selected record', async () => {
    await mountWizard()
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-go-group]')!.click()
    await flushUi()
    calls = []
    groupSaveButton().click()
    await flushUi(12)
    const writes = calls.filter((c) => WRITE_METHODS.has(c.method))
    expect(writes.map((c) => ({ url: c.url, method: c.method }))).toEqual([
      { url: '/api/attendance/groups', method: 'POST' },
    ])
    // Exact template payload — the full body shape, not a spot check (no orgId key — the harness
    // org is blank and JSON.stringify drops the undefined normalizedOrgId()).
    expect(JSON.parse(writes[0].body || 'null')).toEqual({
      name: 'Office attendance group',
      code: null,
      timezone: 'Asia/Shanghai',
      ruleSetId: null,
      attendanceType: 'fixed_shift',
      description: null,
    })
  })

  it('R3 (§0, mutation target: any wizard-phase PUT ⇒ red): the FULL wizard/template/prefill walk issues ZERO write-method requests', async () => {
    await mountWizard()
    // Walk (every wizard affordance actually exercised — the comment matches the clicks):
    //   open → change timezone → cancel → open → choose preset → apply → undo → open → apply →
    //   go-SHIFT navigate → re-enter wizard → BOTH checklist template jumps (shift + group) →
    //   reload readiness.
    openTemplate('factory-multi-shift')
    await flushUi()
    const tzSelect = dialog()!.querySelector<HTMLSelectElement>('[data-setup-template-timezone-select]')!
    tzSelect.value = 'America/New_York'
    tzSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-cancel]')!.click()
    await flushUi()

    openTemplate('factory-multi-shift')
    await flushUi()
    const presetSelect = dialog()!.querySelector<HTMLSelectElement>('[data-setup-template-preset-select]')!
    presetSelect.value = 'factory-night'
    presetSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()

    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    // go-shift leg (previously never clicked anywhere in the suite): navigate to the shift form.
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-go-shift]')!.click()
    await flushUi(8)
    expect(dialog()).toBeNull()

    // Re-enter the wizard (task home → setup) — pending prefill keeps the checklist item alive.
    const returnHome = Array.from(container!.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Management home'))
    expect(returnHome).toBeTruthy()
    returnHome!.click()
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-task-action="setup-readiness"]')!.click()
    await flushUi(16)
    const checklistItem = container!.querySelector('[data-setup-checklist-item="template-prefill"]')
    expect(checklistItem).toBeTruthy()
    checklistItem!.querySelector<HTMLButtonElement>('[data-setup-checklist-remedy="template-shift-form"]')!.click()
    await flushUi(8)
    checklistItem!.querySelector<HTMLButtonElement>('[data-setup-checklist-remedy="template-group-form"]')!.click()
    await flushUi(8)

    // Reload readiness from the wizard (read-only refresh).
    container!.querySelector<HTMLButtonElement>('[data-setup-reload]')!.click()
    await flushUi(8)

    // The ENTIRE walk (mount + every interaction above): zero write-method requests.
    const writes = calls.filter((c) => WRITE_METHODS.has(c.method))
    expect(writes).toEqual([])
  })

  it('R4 (§0/§5.4, mutation target: settings PUT from the wizard ⇒ red): zero calls to every banned switch/trigger door across the same walk', async () => {
    await mountWizard()
    openTemplate('field-sales')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    // The field-sales settings hint is a NAVIGATION-only affordance (R4: link, never a write).
    const goSettings = dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-go-settings]')!
    expect(goSettings).toBeTruthy()
    goSettings.click()
    await flushUi(8)

    for (const door of R4_BANNED_DOOR_PATTERNS) {
      const hits = calls.filter((c) => c.url.includes(door.pattern) && WRITE_METHODS.has(c.method))
      expect(hits, `${door.pattern} (${door.note})`).toEqual([])
    }
    // Belt 1: the settings door also saw no wizard-driven request at all beyond the pre-existing
    // admin GET load (which is part of loadAdminData, not the wizard).
    const settingsCalls = calls.filter((c) => c.url.includes('/api/attendance/settings'))
    expect(settingsCalls.every((c) => c.method === 'GET')).toBe(true)
    // Belt 2 (whole-walk zero-write, R3-grade): THIS walk (field-sales apply → go-settings) is
    // not the R3 test's walk — without this belt a non-banned-door write (e.g. POST /groups)
    // fired during it would slip both tests.
    expect(calls.filter((c) => WRITE_METHODS.has(c.method))).toEqual([])
  })

  it('applied stage offers a side-effect-free close: prefill kept, checklist item alive, leave warning still armed, undo snapshot gone', async () => {
    await mountWizard()
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    // The applied stage documents the undo scope honestly (undo lives only in this dialog).
    expect(dialog()!.querySelector('[data-setup-template-undo-scope-note]')).toBeTruthy()
    const appliedState = readFormState()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-close]')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    // No side effects: the prefilled values stay, nothing was undone, nothing navigated.
    expect(readFormState()).toEqual(appliedState)
    expect(container!.querySelector('[data-setup-checklist-item="template-prefill"]')).toBeTruthy()
    // The unsaved-prefill leave warning stays armed (close ≠ save, close ≠ undo).
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('a11y: focus moves into the panel on open, Tab wraps inside it, Esc = stage-appropriate no-write close, focus returns to the opener', async () => {
    await mountWizard()
    // jsdom's .click() never moves focus, so focus the opener explicitly — that is what a real
    // keyboard/mouse open leaves as document.activeElement for the dialog to restore later.
    const opener = container!.querySelector<HTMLButtonElement>('[data-setup-template-open="office-fixed"]')!
    opener.focus()
    opener.click()
    await flushUi()
    const panel = container!.querySelector<HTMLElement>('.setup-template-dialog__panel')!
    // Initial focus lands on the panel itself (tabindex="-1").
    expect(document.activeElement).toBe(panel)

    // Tab trap: forward-Tab from the last focusable wraps to the first; shift-Tab from the first
    // wraps to the last (jsdom performs no native tab moves, so the wrap IS the observable).
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled])'),
    )
    expect(focusables.length).toBeGreaterThan(1)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)

    // Esc in the confirm stage = cancel: dialog closes, nothing applied, focus returns to opener.
    const before = readFormState()
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushUi()
    expect(dialog()).toBeNull()
    expect(readFormState()).toEqual(before)
    expect(document.activeElement).toBe(opener)

    // Esc in the applied stage = close-keep-prefill (never undo): values stay, warning armed.
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    const appliedState = readFormState()
    container!.querySelector<HTMLElement>('.setup-template-dialog__panel')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushUi()
    expect(dialog()).toBeNull()
    expect(readFormState()).toEqual(appliedState)
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('OD-W4-7② the shared in-app leave signal tracks the pending prefill: apply arms, undo disarms, unmount always clears', async () => {
    await mountWizard()
    expect(attendanceSetupPrefillPending.value).toBe(false)
    openTemplate('office-fixed')
    await flushUi()
    expect(attendanceSetupPrefillPending.value).toBe(false) // confirm stage: nothing applied yet
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    expect(attendanceSetupPrefillPending.value).toBe(true)
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    expect(attendanceSetupPrefillPending.value).toBe(false)

    // Re-arm, then unmount the host with the prefill still pending: the signal MUST clear —
    // a stale `true` would block navigation after the host (and the prefill) are already gone.
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    expect(attendanceSetupPrefillPending.value).toBe(true)
    app!.unmount()
    app = null
    expect(attendanceSetupPrefillPending.value).toBe(false)
  })

  it('OD-W4-7 未保存离开提示: beforeunload is armed while a prefill is applied-but-unsaved, and disarmed by undo', async () => {
    await mountWizard()
    const probe = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(probe()).toBe(false)

    openTemplate('office-fixed')
    await flushUi()
    expect(probe()).toBe(false) // confirm stage: nothing applied yet
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    expect(probe()).toBe(true)

    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    expect(probe()).toBe(false)
  })

  it('OD-W4-7 saving through the canonical forms disarms the warning form by form (group save keeps shift leg armed until the shift is saved too)', async () => {
    await mountWizard()
    openTemplate('office-fixed')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-go-group]')!.click()
    await flushUi()
    const probe = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(probe()).toBe(true)

    groupSaveButton().click()
    await flushUi(12)
    expect(probe()).toBe(true) // shift prefill still unsaved

    const shiftSave = Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent || '').trim() === 'Create shift' || (b.textContent || '').trim() === 'Update shift',
    )
    expect(shiftSave, 'shift save button').toBeTruthy()
    shiftSave!.click()
    await flushUi(12)
    expect(probe()).toBe(false)
  })

  it('OD-W4-7③ N/A by construction: the whole template walk performs ZERO template-related storage writes (no local draft — nothing to key by userId+orgId)', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    await mountWizard()
    openTemplate('store-scheduled')
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-apply]')!.click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    const templateWrites = setItemSpy.mock.calls.filter(([key, value]) =>
      String(key).toLowerCase().includes('template') ||
      String(value).includes('store-scheduled') ||
      ATTENDANCE_SETUP_TEMPLATE_IDS.some((id) => String(key).includes(id)),
    )
    expect(templateWrites).toEqual([])
    setItemSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 4. Dialog component rendered DIRECTLY — §5.3 completion-claim negatives, zh AND en legs
// ---------------------------------------------------------------------------
// W4-1 lesson (#3487): a locale leg no test ever renders is a skip-shaped green. The mounted
// suite above renders the dialog under locale 'en' only, and the shell sweep never mounts the
// dialog at all — so the dialog's OWN copy (both locales, both stages, every copy branch) gets
// its own presence-anchored sweep here. Mutation target: add 「已启用」/"enabled" to any dialog
// copy string ⇒ the matching leg turns red.

const DIALOG_PRISTINE_GROUP = {
  name: '',
  code: '',
  timezone: 'Asia/Shanghai',
  ruleSetId: '',
  attendanceType: 'fixed_shift',
  description: '',
}
const DIALOG_PRISTINE_SHIFT = {
  name: 'Standard Shift',
  timezone: 'Asia/Shanghai',
  workStartTime: '09:00',
  workEndTime: '18:00',
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  roundingMinutes: 5,
  workingDays: '1,2,3,4,5',
}
const DIALOG_TIMEZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: 'UTC+08:00 · Asia/Shanghai' },
  { value: 'America/New_York', label: 'UTC-05:00 · America/New_York' },
]

interface DialogScenario {
  key: string
  templateId: string
  stage: 'confirm' | 'applied'
  timezone: string
  orgTimezone: string | null
  /** presence anchors: selectors that MUST exist for this scenario (leg really rendered) */
  anchors: string[]
  absent?: string[]
}

/** Every copy branch of the dialog: shift-preset template (confirm dirty + applied), preset
 *  select (store), settings-hint template (field-sales confirm-no-tz + applied). */
const DIALOG_SCENARIOS: DialogScenario[] = [
  {
    key: 'office-confirm-dirty',
    templateId: 'office-fixed',
    stage: 'confirm',
    timezone: 'Asia/Shanghai',
    orgTimezone: 'Asia/Shanghai',
    anchors: [
      '[data-setup-template-field-changes]',
      '[data-setup-template-field-change="shift.rounding"]',
      '[data-setup-template-dirty-warning]',
      '[data-setup-template-timezone-org]',
      '[data-setup-template-apply]',
    ],
  },
  {
    key: 'office-applied',
    templateId: 'office-fixed',
    stage: 'applied',
    timezone: 'Asia/Shanghai',
    orgTimezone: 'Asia/Shanghai',
    anchors: [
      '[data-setup-template-applied-note]',
      '[data-setup-template-undo-scope-note]',
      '[data-setup-template-undo]',
      '[data-setup-template-close]',
      '[data-setup-template-go-shift]',
    ],
  },
  {
    key: 'store-confirm-presets',
    templateId: 'store-scheduled',
    stage: 'confirm',
    timezone: 'Asia/Shanghai',
    orgTimezone: 'Asia/Shanghai',
    anchors: ['[data-setup-template-preset-block]', '[data-setup-template-rotation-hint]'],
  },
  {
    key: 'sales-confirm-no-tz',
    templateId: 'field-sales',
    stage: 'confirm',
    timezone: '',
    orgTimezone: null,
    anchors: [
      '[data-setup-template-timezone-required]',
      '[data-setup-template-plan-missing]',
      '[data-setup-template-settings-hint]',
    ],
  },
  {
    key: 'sales-applied',
    templateId: 'field-sales',
    stage: 'applied',
    timezone: 'Asia/Shanghai',
    orgTimezone: 'Asia/Shanghai',
    anchors: ['[data-setup-template-applied-note]', '[data-setup-template-go-settings]'],
    absent: ['[data-setup-template-go-shift]'],
  },
]

describe('AttendanceSetupTemplatePrefillDialog direct render — §5.3 negatives (zh AND en, all stages/branches)', () => {
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

  function renderScenario(tr: (en: string, zh: string) => string, scenario: DialogScenario): string {
    const template = getAttendanceSetupTemplate(scenario.templateId)!
    const shiftPresetKey = template.shiftPresets[0]?.key ?? null
    const plan = buildAttendanceSetupTemplatePrefillPlan({
      templateId: scenario.templateId,
      shiftPresetKey,
      timezone: scenario.timezone,
      pickLabel: (label) => tr(label.en, label.zh),
    })
    app = createApp(AttendanceSetupTemplatePrefillDialog, {
      tr,
      stage: scenario.stage,
      template,
      plan,
      currentGroup: { ...DIALOG_PRISTINE_GROUP, name: 'Existing group' },
      currentShift: { ...DIALOG_PRISTINE_SHIFT },
      pristineGroup: DIALOG_PRISTINE_GROUP,
      pristineShift: DIALOG_PRISTINE_SHIFT,
      groupEditingId: 'existing-group-id',
      shiftEditingId: null,
      orgTimezone: scenario.orgTimezone,
      timezone: scenario.timezone,
      timezoneOptions: DIALOG_TIMEZONE_OPTIONS,
      shiftPresetKey,
      onApply: () => {},
      onCancel: () => {},
      onUndo: () => {},
      onClose: () => {},
      onNavigate: () => {},
    })
    app.mount(container!)
    for (const anchor of scenario.anchors) {
      expect(container!.querySelector(anchor), `${scenario.key}: ${anchor}`).toBeTruthy()
    }
    for (const anchor of scenario.absent ?? []) {
      expect(container!.querySelector(anchor), `${scenario.key}: ${anchor} must be absent`).toBeNull()
    }
    const text = container!.textContent || ''
    app.unmount()
    app = null
    container!.innerHTML = ''
    return text
  }

  it('zh leg: every stage/branch renders zh copy and none of it contains 已启用/已生效 completion tenses', () => {
    let combined = ''
    for (const scenario of DIALOG_SCENARIOS) {
      combined += renderScenario(zhTr, scenario)
    }
    // The zh leg REALLY rendered zh (anchor, not just absence).
    expect(combined).toContain('模板值')
    expect(combined).toContain('不执行任何启用动作')
    expect(combined).toContain('关闭（保留预填）')
    expect(combined).not.toContain('已启用')
    expect(combined).not.toContain('已生效')
  })

  it('en leg: every stage/branch renders en copy and none of it contains enabled/activated completion tenses', () => {
    let combined = ''
    for (const scenario of DIALOG_SCENARIOS) {
      combined += renderScenario(enTr, scenario)
    }
    expect(combined).toContain('Apply template prefill')
    expect(combined).toContain('no activation action')
    expect(combined).toContain('Close (keep prefill)')
    const lower = combined.toLowerCase()
    expect(lower).not.toMatch(/\benabled\b/)
    expect(lower).not.toMatch(/\bactivated\b/)
  })
})

// ---------------------------------------------------------------------------
// 5. OD-W4-7② in-app leave guard — pure module + AttendanceExperienceView seams
// ---------------------------------------------------------------------------

describe('attendanceSetupPrefillLeaveGuard (pure module)', () => {
  afterEach(() => {
    attendanceSetupPrefillPending.value = false
  })

  it('no pending prefill ⇒ proceed WITHOUT asking; pending ⇒ the confirm decides, exactly once per call', () => {
    const confirmFn = vi.fn(() => false)
    attendanceSetupPrefillPending.value = false
    expect(confirmAttendanceSetupPrefillLeave(enTr, confirmFn)).toBe(true)
    expect(confirmFn).not.toHaveBeenCalled()

    attendanceSetupPrefillPending.value = true
    expect(confirmAttendanceSetupPrefillLeave(enTr, confirmFn)).toBe(false)
    expect(confirmFn).toHaveBeenCalledTimes(1)
    // The message is locale-routed through tr and promises loss, not recovery (§5.2③).
    expect(confirmFn).toHaveBeenLastCalledWith(
      'A template prefill has been applied but not saved — leaving attendance discards it. Leave anyway?',
    )
    expect(confirmAttendanceSetupPrefillLeave(zhTr, confirmFn)).toBe(false)
    expect(confirmFn).toHaveBeenLastCalledWith(
      '模板预填已应用但尚未保存——离开考勤页将丢失该预填。仍要离开吗？',
    )

    confirmFn.mockReturnValue(true)
    expect(confirmAttendanceSetupPrefillLeave(enTr, confirmFn)).toBe(true)
  })
})

describe('AttendanceExperienceView seams — OD-W4-7② 切区确认 (tab switch + route leave)', () => {
  let app: App<Element> | null = null
  let router: Router | null = null
  let container: HTMLDivElement | null = null
  let confirmResult = false
  let confirmCalls = 0
  const originalConfirm = window.confirm
  const originalMatchMedia = window.matchMedia

  beforeEach(async () => {
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    attendanceSetupPrefillPending.value = false
    confirmResult = false
    confirmCalls = 0
    window.confirm = (_message?: string): boolean => {
      confirmCalls += 1
      return confirmResult
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/attendance', component: AttendanceExperienceView },
        { path: '/elsewhere', component: { template: '<div data-testid="elsewhere">elsewhere</div>' } },
      ],
    })
    await router.push('/attendance?tab=admin')
    await router.isReady()

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ template: '<router-view />' })
    app.use(router)
    app.mount(container)
    await flushUi(8)
    // The admin tab (the AttendanceView host seat) is really active before any seam is probed.
    expect(container.querySelector('[data-testid="attendance-admin-center"]')).toBeTruthy()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    window.confirm = originalConfirm
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    })
    attendanceSetupPrefillPending.value = false
    app = null
    router = null
    container = null
  })

  function clickTab(label: string): void {
    const tab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab')).find(
      (b) => b.textContent?.trim() === label,
    )
    expect(tab, `tab ${label}`).toBeTruthy()
    tab!.click()
  }

  it('top-tab switch with a pending prefill asks first: refusing keeps the admin host mounted, confirming proceeds', async () => {
    attendanceSetupPrefillPending.value = true
    clickTab('Overview')
    await flushUi(4)
    expect(confirmCalls).toBe(1)
    // Refused ⇒ the admin host (and the in-memory prefill) survives.
    expect(container!.querySelector('[data-testid="attendance-admin-center"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="attendance-overview"]')).toBeNull()

    confirmResult = true
    clickTab('Overview')
    await flushUi(4)
    expect(confirmCalls).toBe(2)
    expect(container!.querySelector('[data-testid="attendance-overview"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="attendance-admin-center"]')).toBeNull()
  })

  it('route leave with a pending prefill asks first: refusing keeps /attendance, confirming navigates away', async () => {
    attendanceSetupPrefillPending.value = true
    await router!.push('/elsewhere')
    expect(confirmCalls).toBe(1)
    expect(router!.currentRoute.value.path).toBe('/attendance')
    expect(container!.querySelector('[data-testid="attendance-admin-center"]')).toBeTruthy()

    confirmResult = true
    await router!.push('/elsewhere')
    expect(router!.currentRoute.value.path).toBe('/elsewhere')
    expect(container!.querySelector('[data-testid="elsewhere"]')).toBeTruthy()
  })

  it('without a pending prefill neither seam ever prompts (no nag)', async () => {
    clickTab('Overview')
    await flushUi(4)
    expect(container!.querySelector('[data-testid="attendance-overview"]')).toBeTruthy()
    clickTab('Admin Center')
    await flushUi(4)
    expect(container!.querySelector('[data-testid="attendance-admin-center"]')).toBeTruthy()
    await router!.push('/elsewhere')
    expect(router!.currentRoute.value.path).toBe('/elsewhere')
    expect(confirmCalls).toBe(0)
  })
})

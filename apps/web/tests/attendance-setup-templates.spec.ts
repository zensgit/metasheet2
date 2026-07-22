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
//        by the forms' own save paths); template selection is NEVER persisted (zero
//        template-related storage writes — the storage-key-with-userId+orgId contract is N/A by
//        construction because no local draft storage exists in this slice).
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

  it('§5.3 completion-claim negative on the FULL W4-2 surface — zh leg: no 已启用 / 已生效 anywhere (gallery + derivation + pending checklist item, both fixtures)', async () => {
    for (const data of [allReadyResponse(), mixedMissingResponse()]) {
      mount({ steps: okSteps(data), summary: data, pendingTemplateId: 'factory-multi-shift', tr: zhTr })
      await flushUi()
      expect(container!.querySelector('[data-setup-templates]')).toBeTruthy()
      const fullText = container!.textContent || ''
      expect(fullText).not.toContain('已启用')
      expect(fullText).not.toContain('已生效')
      app!.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  it('§5.3 completion-claim negative — en leg: no "enabled"/"activated" completion claims anywhere (both fixtures)', async () => {
    for (const data of [allReadyResponse(), mixedMissingResponse()]) {
      mount({ steps: okSteps(data), summary: data, pendingTemplateId: 'factory-multi-shift', tr: enTr })
      await flushUi()
      expect(container!.querySelector('[data-setup-templates]')).toBeTruthy()
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
      if (url === '/api/attendance/shifts' && method === 'POST') {
        return jsonResponse(200, { ok: true, data: { id: 's-new' } })
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

  function readFormState() {
    return {
      groupName: groupNameInput().value,
      groupTimezone: container!.querySelector<HTMLSelectElement>('#attendance-group-timezone')!.value,
      groupType: container!.querySelector<HTMLSelectElement>('#attendance-group-type')!.value,
      shiftName: shiftNameInput().value,
      shiftStart: container!.querySelector<HTMLInputElement>('#attendance-shift-start')!.value,
      shiftEnd: container!.querySelector<HTMLInputElement>('#attendance-shift-end')!.value,
      shiftTimezone: container!.querySelector<HTMLSelectElement>('#attendance-shift-timezone')!.value,
      groupSaveLabel: groupSaveButton().textContent?.trim(),
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
    // Affected-field list renders (org timezone resolved from the saved group ⇒ plan exists).
    expect(confirm!.querySelector('[data-setup-template-field-changes]')).toBeTruthy()
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
    const before = readFormState()
    expect(before.groupSaveLabel).toBe('Save group') // an existing record is selected

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
      shiftStart: '09:00',
      shiftEnd: '18:00',
      shiftTimezone: 'Asia/Shanghai',
      groupSaveLabel: 'Create group',
    })

    applied.querySelector<HTMLButtonElement>('[data-setup-template-undo]')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    // Byte-identical restore of every touched field INCLUDING the editing posture.
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
    // Walk: open → cancel → open → choose preset → apply → undo → open → apply → navigate →
    // re-enter wizard → checklist template jumps → reload readiness.
    openTemplate('factory-multi-shift')
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
    dialog()!.querySelector<HTMLButtonElement>('[data-setup-template-go-group]')!.click()
    await flushUi(8)

    // Re-enter the wizard (task home → setup) — pending prefill keeps the checklist item alive.
    const returnHome = Array.from(container!.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Management home'))
    expect(returnHome).toBeTruthy()
    returnHome!.click()
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-task-action="setup-readiness"]')!.click()
    await flushUi(16)
    const checklistItem = container!.querySelector('[data-setup-checklist-item="template-prefill"]')
    expect(checklistItem).toBeTruthy()
    checklistItem!.querySelector<HTMLButtonElement>('[data-setup-checklist-remedy="template-group-form"]')!.click()
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
    // Belt: the settings door also saw no wizard-driven request at all beyond the pre-existing
    // admin GET load (which is part of loadAdminData, not the wizard).
    const settingsCalls = calls.filter((c) => c.url.includes('/api/attendance/settings'))
    expect(settingsCalls.every((c) => c.method === 'GET')).toBe(true)
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

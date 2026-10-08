// A1 「提示与实际状态」: mounted render matrix for AttendanceScheduledFeatureStatus.vue - the two rows
// (已配置 / 当前是否可运行) are ALWAYS present, driven only by the props, with a pure display shape (no button, no
// input, no write door anywhere in the tree).
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import AttendanceScheduledFeatureStatus from '../src/views/attendance/AttendanceScheduledFeatureStatus.vue'
import {
  describeScheduledFeatureStatus,
  type AttendanceConfiguredState,
  type AttendanceRuntimeGateEntry,
  type AttendanceScheduledFeatureKey,
  type TranslateFn,
} from '../src/views/attendance/attendanceScheduledFeatureStatus'

const trZh: TranslateFn = (_en, zh) => zh
const trEn: TranslateFn = (en) => en

const OPEN: AttendanceRuntimeGateEntry = { gatesOpen: true, closedGates: [] }
const CLOSED: AttendanceRuntimeGateEntry = { gatesOpen: false, closedGates: ['digestProducer', 'scheduler', 'deliveryWorker'] }

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

function mountStatus(props: {
  tr?: TranslateFn
  feature?: AttendanceScheduledFeatureKey
  configured: AttendanceConfiguredState
  gate: AttendanceRuntimeGateEntry | null
}): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(AttendanceScheduledFeatureStatus, {
    tr: props.tr ?? trZh,
    feature: props.feature ?? 'reportDigest',
    configured: props.configured,
    gate: props.gate,
  })
  app.mount(container)
  return container
}

function text(root: HTMLElement, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? ''
}

describe('AttendanceScheduledFeatureStatus', () => {
  it('renders both rows and the detail line, tagged with the feature and the two states', () => {
    const root = mountStatus({ configured: 'configured', gate: CLOSED })
    const host = root.querySelector('[data-attendance-scheduled-feature-status]')
    expect(host).not.toBeNull()
    expect(host!.getAttribute('data-scheduled-feature')).toBe('reportDigest')
    expect(host!.getAttribute('data-configured-state')).toBe('configured')
    expect(host!.getAttribute('data-runnable-state')).toBe('closed')
    expect(text(root, '[data-scheduled-feature-configured]')).toBe('已配置')
    expect(text(root, '[data-scheduled-feature-runnable]')).toBe('否：服务端运行开关未开启')
    expect(root.textContent).toContain('配置状态')
    expect(root.textContent).toContain('当前是否可运行')
    expect(text(root, '[data-scheduled-feature-detail]')).toContain('已保存，但当前不会发送')
  })

  it('renders exactly what the pure module derives (so the component adds no logic of its own)', () => {
    for (const feature of ['reportDigest', 'annualLeaveAccrualScheduled'] as const) {
      for (const configured of ['configured', 'incomplete', 'not_configured', 'unknown'] as const) {
        for (const gate of [null, OPEN, CLOSED]) {
          const root = mountStatus({ feature, configured, gate })
          const expected = describeScheduledFeatureStatus(trZh, { feature, configured, gate })
          expect(text(root, '[data-scheduled-feature-configured]')).toBe(expected.configuredLabel)
          expect(text(root, '[data-scheduled-feature-runnable]')).toBe(expected.runnableLabel)
          expect(text(root, '[data-scheduled-feature-detail]')).toBe(expected.detail)
          app!.unmount()
          app = null
          container!.remove()
          container = null
        }
      }
    }
  })

  it('shows the English leg with no CJK', () => {
    const root = mountStatus({ tr: trEn, configured: 'configured', gate: CLOSED })
    expect(text(root, '[data-scheduled-feature-configured]')).toBe('Configured')
    expect(root.textContent).toContain('Can it run now?')
    expect(/[㐀-鿿]/.test(root.textContent ?? '')).toBe(false)
  })

  it('marks a missing gate report as unknown (fail-closed), not as open', () => {
    const root = mountStatus({ configured: 'configured', gate: null })
    expect(root.querySelector('[data-attendance-scheduled-feature-status]')!.getAttribute('data-runnable-state')).toBe('unknown')
    expect(text(root, '[data-scheduled-feature-runnable]')).toBe('未知：未取得服务端运行开关状态')
  })

  it('an open gate is not styled as the "configured" success tone and is never worded as running', () => {
    const root = mountStatus({ configured: 'configured', gate: OPEN })
    const configuredChip = root.querySelector('[data-scheduled-feature-configured]')!
    const runnableChip = root.querySelector('[data-scheduled-feature-runnable]')!
    expect(configuredChip.className).toContain('scheduled-status__chip--ok')
    expect(runnableChip.className).toContain('scheduled-status__chip--info')
    expect(runnableChip.className).not.toContain('scheduled-status__chip--ok')
    expect(root.textContent).not.toContain('运行中')
    expect(root.textContent).not.toContain('已生效')
  })

  it('is persistent page content, not a live region: no role and no aria-live anywhere (gate r1 NIT-2)', () => {
    // An atomic polite live region would re-read the whole card on the first load and on every save, and the two
    // cards would announce back to back.
    const root = mountStatus({ configured: 'configured', gate: CLOSED })
    const host = root.querySelector('[data-attendance-scheduled-feature-status]')!
    expect(host.hasAttribute('role')).toBe(false)
    expect(host.hasAttribute('aria-live')).toBe(false)
    expect(root.querySelector('[role], [aria-live]')).toBeNull()
  })

  it('has a pure display shape: no button, input, select, textarea or link', () => {
    const root = mountStatus({ configured: 'configured', gate: CLOSED })
    expect(root.querySelectorAll('button, input, select, textarea, a, form').length).toBe(0)
  })

  it('re-renders when the props change (saved configuration or gate report arrives later)', async () => {
    const configured = ref<AttendanceConfiguredState>('unknown')
    const gate = ref<AttendanceRuntimeGateEntry | null>(null)
    const Host = defineComponent({
      setup() {
        return () => h(AttendanceScheduledFeatureStatus, {
          tr: trZh,
          feature: 'annualLeaveAccrualScheduled',
          configured: configured.value,
          gate: gate.value,
        })
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(Host)
    app.mount(container)
    expect(text(container, '[data-scheduled-feature-configured]')).toBe('尚未加载')
    configured.value = 'configured'
    gate.value = { gatesOpen: false, closedGates: ['accrualTrigger', 'scheduler'] }
    await nextTick()
    expect(text(container, '[data-scheduled-feature-configured]')).toBe('已配置')
    expect(text(container, '[data-scheduled-feature-detail]')).toContain('ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED')
    expect(text(container, '[data-scheduled-feature-detail]')).toContain('ATTENDANCE_SCHEDULER_ENABLED')
  })
})

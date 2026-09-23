import { createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AttendanceEmployeeLeaveRequestCard from '../src/views/attendance/AttendanceEmployeeLeaveRequestCard.vue'

describe('dedicated leave card derived duration', () => {
  let app: App<Element> | undefined
  let root: HTMLDivElement | undefined
  afterEach(() => { app?.unmount(); root?.remove() })

  function mountCard() {
    const form = reactive({ leaveTypeId: 'annual', workDate: '2026-04-15', requestedInAt: '2026-04-15T09:00', requestedOutAt: '2026-04-15T18:00', minutes: '450', reason: 'keep', attachmentUrl: '' })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AttendanceEmployeeLeaveRequestCard, {
      tr: (en: string) => en, requestForm: form,
      leaveTypes: [{ id: 'annual', name: 'Annual' }, { id: 'sick', name: 'Sick' }],
      canQuickFill: true, submitting: false,
    })
    app.mount(root)
    return form
  }

  it.each(['start', 'end'])('clears derived minutes when %s is cleared', async field => {
    const form = mountCard()
    const input = root!.querySelector<HTMLInputElement>(`[data-leave-card-${field}]`)!
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe('')
    expect(root!.querySelector('[data-leave-card-duration-value]')!.textContent).toBe('—')
    expect(form.reason).toBe('keep')
  })

  it('clears derived minutes for a reversed range then recovers the exact duration', async () => {
    const form = mountCard()
    const input = root!.querySelector<HTMLInputElement>('[data-leave-card-end]')!
    input.value = '2026-04-15T08:00'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe('')
    input.value = '2026-04-15T17:30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe('510')
  })

  it('shows the leave-type day hint and blocks an annual span longer than that day', async () => {
    const form = reactive({
      leaveTypeId: 'annual',
      workDate: '2026-04-15',
      requestedInAt: '2026-04-15T09:00',
      requestedOutAt: '2026-04-15T18:00',
      minutes: '480',
      reason: '',
      attachmentUrl: '',
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AttendanceEmployeeLeaveRequestCard, {
      tr: (en: string) => en,
      requestForm: form,
      leaveTypes: [{ id: 'annual', name: 'Annual', code: 'annual', defaultMinutesPerDay: 480 }],
      canQuickFill: true,
      submitting: false,
    })
    app.mount(root)
    await nextTick()

    expect(root.querySelector('[data-leave-card-days-hint]')?.textContent).toContain('≈ 1.0 day(s)')
    expect(root.querySelector('[data-leave-card-days-hint]')?.textContent).toContain('480')
    expect(root.querySelector('[data-leave-card-annual-block]')).toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[data-leave-card-submit]')?.disabled).toBe(false)

    const end = root.querySelector<HTMLInputElement>('[data-leave-card-end]')!
    end.value = '2026-04-15T18:00'
    end.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(form.minutes).toBe('540')
    expect(root.querySelector('[data-leave-card-days-hint]')?.textContent).toContain('1.1')
    const block = root.querySelector('[data-leave-card-annual-block]')
    expect(block?.textContent).toContain('480')
    expect(block?.textContent).toContain('540')
    expect(root.querySelector<HTMLButtonElement>('[data-leave-card-submit]')?.disabled).toBe(true)
  })

  it('does not block a non-annual leave whose wall-clock span exceeds 480 minutes', async () => {
    const form = reactive({
      leaveTypeId: 'sick',
      workDate: '2026-04-15',
      requestedInAt: '2026-04-15T09:00',
      requestedOutAt: '2026-04-15T18:00',
      minutes: '540',
      reason: '',
      attachmentUrl: '',
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AttendanceEmployeeLeaveRequestCard, {
      tr: (en: string) => en,
      requestForm: form,
      leaveTypes: [{ id: 'sick', name: 'Sick', code: 'sick', defaultMinutesPerDay: 480 }],
      canQuickFill: true,
      submitting: false,
    })
    app.mount(root)
    await nextTick()
    expect(root.querySelector('[data-leave-card-annual-block]')).toBeNull()
    expect(root.querySelector('[data-leave-card-days-hint]')?.textContent).toContain('1.1')
    expect(root.querySelector<HTMLButtonElement>('[data-leave-card-submit]')?.disabled).toBe(false)
  })
})

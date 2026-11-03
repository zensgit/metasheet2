import { createApp, nextTick, reactive, ref, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AttendanceEmployeeLeaveRequestCard from '../src/views/attendance/AttendanceEmployeeLeaveRequestCard.vue'

describe('dedicated leave card derived duration', () => {
  let app: App<Element> | undefined
  let root: HTMLDivElement | undefined
  afterEach(() => { app?.unmount(); root?.remove() })

  function mountCard(resolveTimes?: () => { requestedInAt: string; requestedOutAt: string } | null) {
    const form = reactive({ leaveTypeId: 'annual', workDate: '2026-04-15', requestedInAt: '2026-04-15T09:00', requestedOutAt: '2026-04-15T18:00', minutes: '450', reason: 'keep', attachmentUrl: '' })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AttendanceEmployeeLeaveRequestCard, {
      tr: (en: string) => en, requestForm: form,
      leaveTypes: [{ id: 'annual', name: 'Annual' }, { id: 'sick', name: 'Sick' }],
      canQuickFill: true, submitting: false, resolveTimes,
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

  it.each([
    ['spring gap crossing', '2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z', '60'],
    ['fall fold crossing', '2026-11-01T05:30:00.000Z', '2026-11-01T08:30:00.000Z', '180'],
  ])('derives manual duration from confirmed UTC instants for %s', async (_label, start, end, minutes) => {
    const form = mountCard(() => ({ requestedInAt: start, requestedOutAt: end }))
    const input = root!.querySelector<HTMLInputElement>('[data-leave-card-end]')!
    input.value = '2026-04-15T17:30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe(minutes)
  })

  it('keeps ambiguous input unavailable then recomputes when its UTC choice is confirmed', async () => {
    const resolved = ref<{ requestedInAt: string; requestedOutAt: string } | null>(null)
    const form = mountCard(() => resolved.value)
    const input = root!.querySelector<HTMLInputElement>('[data-leave-card-end]')!
    input.value = '2026-04-15T17:30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe('')
    resolved.value = { requestedInAt: '2026-11-01T06:30:00.000Z', requestedOutAt: '2026-11-01T08:30:00.000Z' }
    await nextTick()
    expect(form.minutes).toBe('120')
    resolved.value = null
    await nextTick()
    expect(form.minutes).toBe('')
  })

  it('does not replace a full-day policy preset when UTC range availability changes', async () => {
    const resolved = ref<{ requestedInAt: string; requestedOutAt: string } | null>(null)
    const form = mountCard(() => resolved.value)
    root!.querySelector<HTMLButtonElement>('[data-leave-card-preset="full_day"]')!.click()
    form.minutes = '480'
    resolved.value = { requestedInAt: '2026-03-08T05:00:00.000Z', requestedOutAt: '2026-03-08T08:00:00.000Z' }
    await nextTick()
    expect(form.minutes).toBe('480')
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
})

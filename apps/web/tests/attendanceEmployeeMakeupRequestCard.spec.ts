import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import AttendanceEmployeeMakeupRequestCard from '../src/views/attendance/AttendanceEmployeeMakeupRequestCard.vue'
import {
  makeupAnomalyKey,
  type MakeupAnomalyPrefillItem,
} from '../src/views/attendance/makeupRequestCardPrefill'

const tr = (en: string, _zh: string) => en

interface MakeupRequestFormFields {
  workDate: string
  requestType: string
  requestedInAt: string
  requestedOutAt: string
  reason: string
  attachmentUrl: string
}

const TODAY = '2026-04-15'
const YESTERDAY = '2026-04-14'

const todayCheckIn: MakeupAnomalyPrefillItem = {
  recordId: 'record-today-in',
  workDate: TODAY,
  suggestedRequestType: 'missed_check_in',
}
const todayCheckInAlt: MakeupAnomalyPrefillItem = {
  recordId: 'record-today-in-alt',
  workDate: TODAY,
  suggestedRequestType: 'missed_check_in',
}
const todayCheckOut: MakeupAnomalyPrefillItem = {
  recordId: 'record-today-out',
  workDate: TODAY,
  suggestedRequestType: 'missed_check_out',
}
const yesterdayCheckIn: MakeupAnomalyPrefillItem = {
  recordId: 'record-yesterday-in',
  workDate: YESTERDAY,
  suggestedRequestType: 'missed_check_in',
}
const yesterdayCheckOut: MakeupAnomalyPrefillItem = {
  recordId: 'record-yesterday-out',
  workDate: YESTERDAY,
  suggestedRequestType: 'missed_check_out',
}

function snapshotForm(form: MakeupRequestFormFields): MakeupRequestFormFields {
  return { ...form }
}

describe('AttendanceEmployeeMakeupRequestCard', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mountCard(options: {
    requestForm?: Partial<MakeupRequestFormFields>
    anomalies?: MakeupAnomalyPrefillItem[]
    submitting?: boolean
  } = {}) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const requestForm = reactive<MakeupRequestFormFields>({
      workDate: TODAY,
      requestType: 'missed_check_in',
      requestedInAt: '',
      requestedOutAt: '',
      reason: '',
      attachmentUrl: '',
      ...options.requestForm,
    })
    app = createApp(AttendanceEmployeeMakeupRequestCard, {
      tr,
      requestForm,
      anomalies: options.anomalies ?? [todayCheckIn, yesterdayCheckIn, todayCheckOut, yesterdayCheckOut],
      todayWorkDate: TODAY,
      submitting: options.submitting ?? false,
    })
    app.mount(container)
    return { requestForm, root: container }
  }

  async function selectAnomaly(root: HTMLElement, item: MakeupAnomalyPrefillItem): Promise<void> {
    const select = root.querySelector<HTMLSelectElement>('[data-makeup-card-anomaly]')
    expect(select, 'expected anomaly select').toBeTruthy()
    select!.value = makeupAnomalyKey(item)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
  }

  it('clears both requested times when switching to a same-type anomaly on another date', async () => {
    const { requestForm, root } = mountCard({
      requestForm: {
        requestedInAt: '2026-04-15T09:00',
        requestedOutAt: '',
        reason: 'keep reason',
        attachmentUrl: 'https://example.com/kept.png',
      },
      anomalies: [todayCheckIn, yesterdayCheckIn],
    })
    await nextTick()

    await selectAnomaly(root, yesterdayCheckIn)

    expect(requestForm.workDate).toBe(YESTERDAY)
    expect(requestForm.requestType).toBe('missed_check_in')
    expect(requestForm.requestedInAt).toBe('')
    expect(requestForm.requestedOutAt).toBe('')
    expect(requestForm.reason).toBe('keep reason')
    expect(requestForm.attachmentUrl).toBe('https://example.com/kept.png')
    expect(root.querySelector<HTMLInputElement>('[data-makeup-card-time]')?.value).toBe('')

    await selectAnomaly(root, todayCheckIn)
    expect(requestForm.workDate).toBe(TODAY)
    expect(requestForm.requestedInAt).toBe('')
    expect(requestForm.requestedOutAt).toBe('')
  })

  it('clears both requested times when switching to a different-type anomaly on another date', async () => {
    const { requestForm, root } = mountCard({
      requestForm: {
        requestedInAt: '2026-04-15T09:00',
        requestedOutAt: '',
      },
      anomalies: [todayCheckIn, yesterdayCheckOut],
    })
    await nextTick()

    await selectAnomaly(root, yesterdayCheckOut)

    expect(requestForm.workDate).toBe(YESTERDAY)
    expect(requestForm.requestType).toBe('missed_check_out')
    expect(requestForm.requestedInAt).toBe('')
    expect(requestForm.requestedOutAt).toBe('')
    expect(root.querySelector<HTMLInputElement>('[data-makeup-card-time]')?.value).toBe('')
  })

  it('clears a stale hidden requestedOutAt when the anomaly work date changes', async () => {
    const { requestForm, root } = mountCard({
      requestForm: {
        requestType: 'missed_check_in',
        requestedInAt: '2026-04-15T09:00',
        requestedOutAt: '2026-04-15T18:00',
      },
      anomalies: [todayCheckIn, yesterdayCheckIn],
    })
    await nextTick()

    expect(root.querySelector<HTMLInputElement>('[data-makeup-card-time]')?.value).toBe('2026-04-15T09:00')

    await selectAnomaly(root, yesterdayCheckIn)

    expect(requestForm.workDate).toBe(YESTERDAY)
    expect(requestForm.requestType).toBe('missed_check_in')
    expect(requestForm.requestedInAt).toBe('')
    expect(requestForm.requestedOutAt).toBe('')
    expect(root.querySelector<HTMLInputElement>('[data-makeup-card-time]')?.value).toBe('')
  })

  it('keeps requested times when switching to another same-type anomaly on the same date', async () => {
    const { requestForm, root } = mountCard({
      requestForm: {
        requestedInAt: '2026-04-15T09:12',
        requestedOutAt: '2026-04-15T18:04',
      },
      anomalies: [todayCheckIn, todayCheckInAlt],
    })
    await nextTick()

    await selectAnomaly(root, todayCheckInAlt)

    expect(requestForm.workDate).toBe(TODAY)
    expect(requestForm.requestType).toBe('missed_check_in')
    expect(requestForm.requestedInAt).toBe('2026-04-15T09:12')
    expect(requestForm.requestedOutAt).toBe('2026-04-15T18:04')
    expect(root.querySelector<HTMLInputElement>('[data-makeup-card-time]')?.value).toBe('2026-04-15T09:12')
  })

  it('transfers the visible time between in/out fields when switching type on the same date', async () => {
    const { requestForm, root } = mountCard({
      requestForm: {
        requestedInAt: '2026-04-15T09:12',
        requestedOutAt: '',
      },
      anomalies: [todayCheckIn, todayCheckOut],
    })
    await nextTick()

    await selectAnomaly(root, todayCheckOut)

    expect(requestForm.workDate).toBe(TODAY)
    expect(requestForm.requestType).toBe('missed_check_out')
    expect(requestForm.requestedInAt).toBe('')
    expect(requestForm.requestedOutAt).toBe('2026-04-15T09:12')
    expect(root.querySelector<HTMLInputElement>('[data-makeup-card-time]')?.value).toBe('2026-04-15T09:12')

    await selectAnomaly(root, todayCheckIn)
    expect(requestForm.requestType).toBe('missed_check_in')
    expect(requestForm.requestedInAt).toBe('2026-04-15T09:12')
    expect(requestForm.requestedOutAt).toBe('')
  })

  it('does not mutate the form when the selected anomaly key is invalid', async () => {
    const { requestForm, root } = mountCard({
      requestForm: {
        requestedInAt: '2026-04-15T09:00',
        requestedOutAt: '2026-04-15T18:00',
        reason: 'untouched',
        attachmentUrl: 'https://example.com/proof.png',
      },
      anomalies: [todayCheckIn],
    })
    await nextTick()
    const before = snapshotForm(requestForm)
    const select = root.querySelector<HTMLSelectElement>('[data-makeup-card-anomaly]')
    expect(select?.value).toBe(makeupAnomalyKey(todayCheckIn))

    select!.value = 'missing-record::2099-01-01'
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(snapshotForm(requestForm)).toEqual(before)
  })

  it('exposes a distinct attachment URL input bound to requestForm.attachmentUrl', async () => {
    const { requestForm, root } = mountCard()
    await nextTick()

    const input = root.querySelector<HTMLInputElement>('[data-makeup-card-attachment]')
    expect(input).toBeTruthy()
    expect(input!.id).toBe('attendance-makeup-card-attachment')
    expect(root.querySelector('#attendance-request-attachment')).toBeNull()

    input!.value = 'https://example.com/lobby.png'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(requestForm.attachmentUrl).toBe('https://example.com/lobby.png')
  })
})

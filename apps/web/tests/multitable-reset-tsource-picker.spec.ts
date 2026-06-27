// @vitest-environment jsdom
/**
 * T8-2 Reset UI — ResetToPointPicker (the T-source the #3250 dialog was missing). Hidden unless `pitResetEnabled`.
 * Sources a point-in-time T from a datetime-local input, mounts the existing ResetConfirmDialog only once T is a
 * valid PAST instant, and binds the (sheetId, asOf) wire to the client. The WIRE test below is the real verification
 * (not a fixture): it asserts the picker's sheetId + the UTC-ISO derived from the local input both reach reset-preview
 * with no timezone inversion.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import ResetToPointPicker from '../src/multitable/components/ResetToPointPicker.vue'
import { MultitableApiClient } from '../src/multitable/api/client'

const mounted: Array<{ unmount: () => void }> = []
function mount(over: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = {
    pitResetEnabled: true,
    sheetId: 'sheet_xyz',
    resetPreview: vi.fn(async () => ({ asOf: '', strategy: 'reset', summary: { visibleRevertCount: 0, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: 't' })),
    resetExecute: vi.fn(async () => ({ asOf: '', strategy: 'reset', revertedCount: 0, deletedRecordIds: [] })),
    ...over,
  }
  const app = createApp(ResetToPointPicker, props)
  const c = document.createElement('div'); document.body.appendChild(c); app.mount(c); mounted.push(app); return props
}
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const waitUntil = async (pred: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush() }
  throw new Error('waitUntil: condition not met')
}
const setInput = (sel: string, val: string) => { const el = q(sel) as HTMLInputElement; el.value = val; el.dispatchEvent(new Event('input')) }
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

describe('ResetToPointPicker — T8-2 Reset UI T-source', () => {
  it('(a) whole entry HIDDEN when pitResetEnabled false / absent (fail-closed)', async () => {
    mount({ pitResetEnabled: false }); await nextTick()
    expect(q('[data-test="reset-picker"]')).toBeFalsy()
    mounted.pop()!.unmount(); document.body.innerHTML = ''
    mount({ pitResetEnabled: undefined }); await nextTick()
    expect(q('[data-test="reset-picker"]')).toBeFalsy()
  })

  it('(b) enabled: shows the datetime picker, but NO dialog/target until a T is chosen', async () => {
    mount(); await nextTick()
    expect(q('[data-test="reset-picker-input"]')).toBeTruthy()
    expect(q('[data-test="reset-picker-target"]')).toBeFalsy()
    expect(q('[data-test="reset-entry"]')).toBeFalsy() // the dialog isn't mounted yet → no second reset button
  })

  it('(c) FUTURE T → future hint, no dialog (can only reset to the past)', async () => {
    mount(); await nextTick()
    setInput('[data-test="reset-picker-input"]', '2099-01-01T00:00'); await flush()
    expect(q('[data-test="reset-picker-future"]')).toBeTruthy()
    expect(q('[data-test="reset-entry"]')).toBeFalsy()
  })

  it('(e) valid PAST T → shows local target + mounts the ResetConfirmDialog entry', async () => {
    mount(); await nextTick()
    setInput('[data-test="reset-picker-input"]', '2020-01-15T10:30'); await flush()
    expect(q('[data-test="reset-picker-target"]')).toBeTruthy()
    await waitUntil(() => !!q('[data-test="reset-entry"]')) // dialog mounted → its own entry button present
  })

  it('(f) WIRE: choosing T → reset-preview hits the picker sheetId with the UTC-ISO of the input (no tz inversion)', async () => {
    const local = '2020-01-15T10:30'
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {
      asOf: '', strategy: 'reset', summary: { visibleRevertCount: 1, deleteCount: 0 }, deleteRecordIds: [], previewIdentity: 'srv',
    } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })
    mount({
      sheetId: 'sheet_xyz',
      resetPreview: (sid: string, asOf: string) => client.resetPreview(sid, asOf),
      resetExecute: (sid: string, asOf: string, id: string) => client.resetExecute(sid, asOf, id),
    })
    await nextTick()
    setInput('[data-test="reset-picker-input"]', local); await flush()
    await waitUntil(() => !!q('[data-test="reset-entry"]'))
    ;(q('[data-test="reset-entry"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 1)
    const url = fetchFn.mock.calls[0][0] as string
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(url).toContain('sheet_xyz')           // sheetId wiring (picker → client), not a fixture
    expect(url).toContain('/reset-preview')
    // the asOf is the UTC-ISO of the local input AND round-trips to the same instant (no inversion / double-convert)
    expect(typeof body.asOf).toBe('string')
    expect(new Date(body.asOf).getTime()).toBe(new Date(local).getTime())
    expect(body.asOf).toBe(new Date(local).toISOString())
  })
})

// @vitest-environment node
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { formatRecordRequestTime } from '../src/views/attendance/attendanceRecordRequestPrefill'

// Execute the actual SFC caller in isolation. This verifies caller-side races,
// not rendered UI or server authorization (covered by their own suites).
const source = readFileSync(new URL('../src/views/AttendanceView.vue', import.meta.url), 'utf8')
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('AttendanceView.ts', script, ts.ScriptTarget.Latest, true)
const prefill = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'applyRecordRequestPrefill')
if (!prefill) throw new Error('REAL_PREFILL_CALLER_REQUIRED')
const code = ts.transpileModule(prefill.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const build = new Function('correctionEdit', 'clearRequestSubmitStatus', 'requestForm', 'recordRequestPrefill', 'requestTimezone',
  'attendanceSessionGuard', 'setStatus', 'tr', 'formatRecordRequestTime', 'scrollToOverviewSection',
  'ATTENDANCE_OVERVIEW_SECTION_IDS', code + '; return applyRecordRequestPrefill') as (...args: unknown[]) => (draft: Draft) => Promise<void>
type Draft = { workDate: string; requestType: string; requestedInAt: string; requestedOutAt: string }
const draft = (date: string): Draft => ({ workDate: date, requestType: 'time_correction',
  requestedInAt: date + 'T01:00:30.123Z', requestedOutAt: date + 'T10:00:40.456Z' })
function pending() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
function fixture() {
  const correctionEdit = { active: { value: false }, cancel: vi.fn() }
  correctionEdit.cancel.mockImplementation(() => { correctionEdit.active.value = false })
  const form = { workDate: '', requestType: '', requestedInAt: '', requestedOutAt: '' }
  const record = { value: null as Draft | null }
  const target = { value: null as { workDate: string; timezone: string } | null }
  const ready = { value: true }
  const waits = [pending(), pending()]
  let index = 0
  const refresh = vi.fn(() => waits[index++].promise)
  const status = vi.fn()
  const scroll = vi.fn(async () => {})
  const apply = build(correctionEdit, vi.fn(), form, record, { refresh, target, ready },
    { isCurrent: () => true }, status, (_en: string, zh: string) => zh,
    formatRecordRequestTime, scroll, { anomalies: 'anomalies' })
  return { correctionEdit, form, record, target, waits, status, scroll, apply }
}
describe('actual request target prefill caller', () => {
  it('fills the target timezone and retains historical precision on an unchanged draft', async () => {
    const f = fixture();f.correctionEdit.active.value = true
    const task = f.apply(draft('2026-01-07'))
    expect(f.correctionEdit.cancel).toHaveBeenCalledOnce()
    f.target.value = { workDate: '2026-01-07', timezone: 'Asia/Tokyo' };f.waits[0].resolve();await task
    expect(f.form).toEqual({ workDate: '2026-01-07', requestType: 'time_correction',
      requestedInAt: '2026-01-07T10:00:30.123', requestedOutAt: '2026-01-07T19:00:40.456' })
    expect(f.scroll).toHaveBeenCalledTimes(1)
  })
  it('does not let a late A prefill overwrite B times using B target context', async () => {
    const f = fixture();const a = f.apply(draft('2026-01-07'));const b = f.apply(draft('2026-01-08'))
    f.target.value = { workDate: '2026-01-08', timezone: 'Asia/Singapore' }
    f.waits[1].resolve();await b
    const before = { ...f.form }
    f.waits[0].resolve();await a
    expect(f.form).toEqual(before)
    expect(f.form).toEqual({ workDate: '2026-01-08', requestType: 'time_correction',
      requestedInAt: '2026-01-08T09:00:30.123', requestedOutAt: '2026-01-08T18:00:40.456' })
    expect(f.status).toHaveBeenCalledTimes(1)
    expect(f.scroll).toHaveBeenCalledTimes(1)
  })
  it('preserves a manual input edit made while target refresh is pending', async () => {
    const f = fixture();const task = f.apply(draft('2026-01-07'))
    f.form.requestedInAt = '2026-01-07T12:34'
    f.target.value = { workDate: '2026-01-07', timezone: 'Asia/Tokyo' };f.waits[0].resolve();await task
    expect(f.form.requestedInAt).toBe('2026-01-07T12:34')
    expect(f.form.requestedOutAt).toBe('')
    expect(f.status).not.toHaveBeenCalled()
    expect(f.scroll).not.toHaveBeenCalled()
  })
  it.each(['workDate', 'requestType'] as const)('does not fill after the user changes %s', async field => {
    const f = fixture();const task = f.apply(draft('2026-01-07'))
    f.form[field] = field === 'workDate' ? '2026-01-08' : 'leave'
    f.target.value = { workDate: f.form.workDate, timezone: 'Asia/Tokyo' };f.waits[0].resolve();await task
    expect(f.form.requestedInAt).toBe('')
    expect(f.form.requestedOutAt).toBe('')
    expect(f.status).not.toHaveBeenCalled()
    expect(f.scroll).not.toHaveBeenCalled()
  })
})

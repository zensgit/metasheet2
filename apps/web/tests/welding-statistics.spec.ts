import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import Statistics from '../src/views/welding/WeldingStatistics.vue'
import { measurementRows, summarizeWelds } from '../src/services/welding/measurements'
import { clone, type PlanPayload } from '../src/services/welding/planRecovery'
import type { PlanRecord } from '../src/services/welding/planClient'

const payload = (): PlanPayload => ({ schema_version: 1, product: null, drawing: null,
  overlay: { bindings: ['a', 'b', 'c'].map(weld_id => ({ weld_id })) },
  welds: ['a', 'b', 'c'].map(weld_id => ({ weld_id, display_no: weld_id, manufacturing_length: { value: 1, unit: 'in' }, measured_length: { value: 90, unit: 'mm' } })) })
const measurement = () => ({ schema: 'vemcad-weld-measurement/1', algorithm: 'vemcad-weld-length/1', source_unit: 'mm',
  rows: ['a', 'b', 'c'].map(weld_id => ({ weld_id, status: 'measured', length_mm: 100, reason: null })) })
let app: App<Element> | undefined, root: HTMLDivElement
function mount(saved = false) {
  const p = payload(), projection = { ...measurement(), schema: 'yuantus.welding_geometry_measurement/1', bundle_sha256: 'a'.repeat(64), geometry_basis_sha256: 'b'.repeat(64) }
  const state = reactive({ payload: p, measurement: measurement() as unknown, savedPoint: saved ? { payload: clone(p), draft_seq: 7, sources: { geometry_measurement: projection } } as PlanRecord : null })
  root = document.createElement('div'); document.body.append(root)
  app = createApp({ render: () => h(Statistics, state) }); app.mount(root)
  return state
}
const total = () => root.querySelector('tbody tr')!.textContent!
afterEach(() => { app?.unmount(); app = undefined; root?.remove() })

describe('welding statistics qualification and independent business totals', () => {
  it('counts three 100 mm welds and excludes only an explicit false without deleting rows', () => {
    const p = payload(), before = clone(p), rows = measurementRows(measurement(), ['a', 'b', 'c'])
    expect(summarizeWelds(p, rows).totals.geometry).toEqual({ known_count: 3, missing_count: 0, value_mm: 300, complete: true })
    expect(p).toEqual(before); p.welds[1].included = false
    const result = summarizeWelds(p, rows)
    expect(result.totals).toMatchObject({ weld_count: 3, included_count: 2, geometry: { value_mm: 200 }, manufacturing: { value_mm: 50.8 }, manual: { value_mm: 180 } })
    expect(p.welds).toHaveLength(3); p.welds[1].included = true
    expect(summarizeWelds(p, rows).totals.geometry.value_mm).toBe(300)
  })
  it('keeps manufacturing, manual and already-converted geometry independent without rounding rows', () => {
    const p = payload(), rows = measurement().rows
    rows.forEach(row => { row.length_mm = 0.0004 })
    const result = summarizeWelds(p, rows).totals
    expect(result.geometry.value_mm).toBeCloseTo(0.0012, 12)
    expect(result.manufacturing.value_mm).toBeCloseTo(76.2, 12)
    expect(result.manual.value_mm).toBe(270)
  })
  it('uses exact group names in codepoint order and ignores classification and hidden selection', () => {
    const p = payload()
    p.welds[0].group_name = '\u{10000}'; p.welds[1].group_name = '\ue000'; p.welds[2].classification = 'not a group'
    p.welds[0].hidden = true; p.selection = ['b']
    const result = summarizeWelds(p, measurement().rows)
    expect(result.groups.map(row => row.group_name)).toEqual(['', '\ue000', '\u{10000}'])
    expect(result.groups.map(row => row.geometry.value_mm)).toEqual([100, 100, 100])
    expect(result.totals.geometry.value_mm).toBe(300)
  })
  it('reports missing measurements and empty included sets without inventing complete totals', () => {
    const p = payload(), rows = measurement().rows.slice(0, 1)
    p.welds[1].manufacturing_length = null; p.welds[2].measured_length = null
    expect(summarizeWelds(p, rows).totals.geometry).toEqual({ known_count: 1, missing_count: 2, value_mm: 100, complete: false })
    expect(summarizeWelds(p, null).totals.geometry).toEqual({ known_count: 0, missing_count: 3, value_mm: 0, complete: false })
    p.welds.forEach(weld => { weld.included = false })
    for (const kind of ['geometry', 'manual', 'manufacturing'] as const) expect(summarizeWelds(p, null).totals[kind]).toEqual({ known_count: 0, missing_count: 0, value_mm: 0, complete: true })
  })
  it('reports finite-row sum overflow as unavailable rather than zero or infinity', () => {
    const p = payload(), rows = measurement().rows
    rows.forEach(row => { row.length_mm = Number.MAX_VALUE })
    expect(summarizeWelds(p, rows).totals.geometry).toEqual({ known_count: 3, missing_count: 0, value_mm: null, complete: false })
    p.welds[0].manufacturing_length = { value: Number.MAX_VALUE, unit: 'in' }
    expect(summarizeWelds(p, rows).totals.manufacturing).toEqual({ known_count: 3, missing_count: 0, value_mm: null, complete: false })
  })
  it('rejects duplicate, omitted, foreign, nonfinite and malformed geometry rows', () => {
    for (const change of [
      (m: ReturnType<typeof measurement>) => { m.rows[1].weld_id = 'a' },
      (m: ReturnType<typeof measurement>) => { m.rows.pop() },
      (m: ReturnType<typeof measurement>) => { m.rows[1].weld_id = 'foreign' },
      (m: ReturnType<typeof measurement>) => { m.rows[1].length_mm = Infinity },
      (m: ReturnType<typeof measurement>) => { m.rows[1].status = 'unknown' },
    ]) { const m = measurement(); change(m); expect(measurementRows(m, ['a', 'b', 'c'])).toBeNull() }
  })
  it('shows preview totals and updates group membership and exclusion reactively', async () => {
    const s = mount(); expect(root.textContent).toContain('草稿几何预览'); expect(total()).toContain('300.000 · 已知 3 / 缺失 0 · 完整')
    s.payload.welds[1].included = false; s.payload.welds[0].group_name = '车间A'; await nextTick()
    expect(total()).toContain('200.000'); expect(total()).toContain('2 / 3'); expect(root.textContent).toContain('车间A')
    expect(total()).toContain('50.800'); expect(total()).toContain('180.000')
  })
  it('labels exact saved results as historical verification and stops using them after any payload change', async () => {
    const s = mount(true); expect(root.textContent).toContain('已保存核验 · 保存序号 7'); expect(root.textContent).toContain('历史快照，非实时测量')
    s.measurement = null; s.payload.welds[0].manufacturing_length = { value: 2, unit: 'in' }; await nextTick()
    expect(root.textContent).toContain('当前几何量未知'); expect(total()).toContain('0.000 · 已知 0 / 缺失 3 · 不完整')
    expect(total()).toContain('101.600'); expect(root.textContent).not.toContain('已保存核验')
    s.payload = clone(s.savedPoint!.payload); await nextTick(); expect(root.textContent).toContain('已保存核验')
  })
  it('falls back to current preview after editing and rejects unqualified saved projections', async () => {
    const s = mount(true); s.payload.welds[0].included = false; await nextTick()
    expect(root.textContent).toContain('草稿几何预览'); expect(total()).toContain('200.000')
    s.payload = clone(s.savedPoint!.payload)
    const projection = s.savedPoint!.sources.geometry_measurement as Record<string, unknown>
    projection.bundle_sha256 = 'unverified'; s.measurement = null; await nextTick()
    expect(root.textContent).toContain('当前几何量未知'); expect(root.textContent).not.toContain('已保存核验')
  })
  it('renders overflow and partial quantities explicitly and keeps the payload byte-identical', async () => {
    const s = mount(), before = JSON.stringify(s.payload)
    expect(total()).toContain('76.200'); expect(JSON.stringify(s.payload)).toBe(before)
    expect(root.querySelectorAll('input,button')).toHaveLength(0)
    const huge = measurement(); huge.rows.forEach(row => { row.length_mm = Number.MAX_VALUE }); s.measurement = huge
    s.payload.welds[0].measured_length = null; await nextTick()
    expect(total()).toContain('不可用（合计溢出） · 已知 3 / 缺失 0 · 不完整')
    expect(total()).toContain('180.000 · 已知 2 / 缺失 1 · 不完整')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import Fields from '../src/views/welding/WeldingParameterFields.vue'
import type { PlanPayload } from '../src/services/welding/planRecovery'
let app: App<Element>, root: HTMLDivElement
function mount(disabled = false) {
  const state = reactive({ disabled, payload: { schema_version: 1, product: null, drawing: null, future: { keep: 3 }, welds: [{ weld_id: 'w', display_no: 'W1', future: ['unchanged'], passes: [{ sequence: 1, method: 'old', filler: '', current: null, voltage: null, speed: null, unknown_pass: true }], welding_steps: ['first', 'second'] }] } as PlanPayload })
  root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Fields, { ...state, onChange: value => { state.payload = value } }) }); app.mount(root); return state
}
async function change(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); await nextTick() }
const button = (text: string) => [...root.querySelectorAll('button')].find(b => b.textContent === text)!
const input = (label: string) => [...root.querySelectorAll('label')].find(l => l.childNodes[0].textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!
afterEach(() => { app?.unmount(); root?.remove() })
describe('complete parameter fields UI', () => {
  it('edits all manual field families while preserving unknown root, weld and pass data', async () => {
    const s = mount()
    for (const [label, text] of [['编制说明', 'notes'], ['位置', 'pos'], ['接头形式', 'joint'], ['母材 A', 'steel'], ['母材 B', 'b'], ['焊接要求', 'w'], ['检验要求', 'i'], ['统计分组', 'g'], ['企业分类', 'c']]) await change(input(label), text)
    await change(input('人工测量长度'), '123'); await change(input('板厚 A'), '3'); await change(input('电流'), '80')
    expect(s.payload).toMatchObject({ future: { keep: 3 }, preparation_notes: 'notes', welds: [{ future: ['unchanged'], location: 'pos', measured_length: { value: 123, unit: 'mm' }, thickness_a: { value: 3, unit: 'mm' }, passes: [{ current: { value: 80, unit: 'A' }, unknown_pass: true }] }] })
    await change(input('人工测量长度'), ''); expect(s.payload.welds[0].measured_length).toBeNull()
  })
  it('adds/removes passes, validates unique sequence and edits unit quantities', async () => {
    const s = mount(); button('增加层道').click(); await nextTick(); expect((s.payload.welds[0].passes as unknown[])).toHaveLength(2)
    const sequence = [...root.querySelectorAll('label')].filter(l => l.childNodes[0].textContent?.trim() === '序号').map(l => l.querySelector('input')!)
    await change(sequence[1], '1'); expect(root.textContent).toContain('唯一正整数'); expect((s.payload.welds[0].passes as any[])[1].sequence).toBe(2)
    await change(input('速度'), '10'); const speed = input('速度').parentElement!.querySelector('select')!; await change(speed, 'in/min')
    expect((s.payload.welds[0].passes as any[])[0].speed).toEqual({ value: 10, unit: 'in/min' })
    button('移除层道').click(); await nextTick(); expect((s.payload.welds[0].passes as any[])).toHaveLength(1)
  })
  it('orders steps explicitly, adds only nonempty steps and leaves disabled payload untouched', async () => {
    const s = mount(); button('下移').click(); await nextTick(); expect(s.payload.welds[0].welding_steps).toEqual(['second', 'first'])
    await change(input('步骤 1'), 'revised'); input('新步骤').value = 'third'; input('新步骤').dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); button('增加步骤').click(); await nextTick()
    expect(s.payload.welds[0].welding_steps).toEqual(['revised', 'first', 'third']); button('移除步骤').click(); await nextTick(); expect(s.payload.welds[0].welding_steps).toEqual(['first', 'third'])
    await change(input('步骤 1'), ''); expect(root.textContent).toContain('步骤不能为空'); expect(s.payload.welds[0].welding_steps).toEqual(['first', 'third'])
    s.disabled = true; await nextTick(); await change(input('位置'), 'forbidden'); expect(s.payload.welds[0].location).toBeUndefined()
  })
})

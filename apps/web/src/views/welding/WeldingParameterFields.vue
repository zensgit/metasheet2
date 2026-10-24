<template>
  <fieldset :disabled="disabled">
    <legend>完整工艺参数</legend>
    <label>编制说明<textarea :value="String(payload.preparation_notes ?? '')" @change="root('preparation_notes', value($event))" /></label>
    <article v-for="weld in payload.welds" :key="weld.weld_id">
      <h3>{{ weld.display_no }} · {{ weld.weld_id }}</h3>
      <label v-for="(label, key) in fields" :key="key">{{ label }}<textarea :data-field="key" :value="String(weld[key] ?? '')" @change="set(weld.weld_id, key, value($event))" /></label>
      <label>参与统计<input type="checkbox" :checked="weld.included !== false" @change="set(weld.weld_id, 'included', ($event.target as HTMLInputElement).checked)"></label>
      <label v-for="(label, key) in quantities" :key="key">{{ label }}
        <input type="number" min="0" step="any" :data-field="key" :value="quantity(weld[key])?.value ?? ''" @change="setQuantity(weld.weld_id, key, value($event), quantity(weld[key])?.unit ?? 'mm')">
        <select :value="quantity(weld[key])?.unit ?? 'mm'" @change="setQuantity(weld.weld_id, key, String(quantity(weld[key])?.value ?? ''), value($event))"><option>mm</option><option>in</option></select>
      </label>
      <h4>层道</h4>
      <div v-for="(pass, index) in passes(weld)" :key="index">
        <label>序号<input type="number" min="1" step="1" :value="pass.sequence" @change="setPass(weld.weld_id, index, 'sequence', Number(value($event)))"></label>
        <label v-for="key in ['method', 'filler']" :key="key">{{ key === 'method' ? '焊接方法' : '填充材料' }}<input :value="String(pass[key] ?? '')" @change="setPass(weld.weld_id, index, key, value($event))"></label>
        <label v-for="(units, key) in passUnits" :key="key">{{ passLabels[key] }}
          <input type="number" min="0" step="any" :value="quantity(pass[key])?.value ?? ''" @change="setPassQuantity(weld.weld_id, index, key, value($event), quantity(pass[key])?.unit ?? units[0])">
          <select :value="quantity(pass[key])?.unit ?? units[0]" @change="setPassQuantity(weld.weld_id, index, key, String(quantity(pass[key])?.value ?? ''), value($event))"><option v-for="unit in units" :key="unit">{{ unit }}</option></select>
        </label>
        <button @click="changePasses(weld.weld_id, rows => rows.splice(index, 1))">移除层道</button>
      </div>
      <button @click="addPass(weld.weld_id)">增加层道</button>
      <h4>有序施焊步骤</h4>
      <div v-for="(step, index) in steps(weld)" :key="index">
        <label>步骤 {{ index + 1 }}<textarea :value="step" @change="changeSteps(weld.weld_id, rows => rows.splice(index, 1, value($event)))" /></label>
        <button :disabled="index === 0" @click="moveStep(weld.weld_id, index, -1)">上移</button>
        <button :disabled="index === steps(weld).length - 1" @click="moveStep(weld.weld_id, index, 1)">下移</button>
        <button @click="changeSteps(weld.weld_id, rows => rows.splice(index, 1))">移除步骤</button>
      </div>
      <label>新步骤<input v-model="newSteps[weld.weld_id]"></label><button :disabled="!newSteps[weld.weld_id]?.trim()" @click="addStep(weld.weld_id)">增加步骤</button>
    </article>
    <p role="alert">{{ error }}</p>
  </fieldset>
</template>
<script setup lang="ts">
import { reactive, ref } from 'vue'
import { clone, need, type PlanPayload } from '../../services/welding/planRecovery'
const props = defineProps<{ payload: PlanPayload; disabled: boolean }>()
const emit = defineEmits<{ change: [payload: PlanPayload] }>()
const error = ref(''), newSteps = reactive<Record<string, string>>({})
const fields: Record<string, string> = { location: '位置', joint_type: '接头形式', method: '焊接方法', material_a: '母材 A', material_b: '母材 B', filler: '填充材料', welding_requirements: '焊接要求', inspection_requirements: '检验要求', group_name: '统计分组', classification: '企业分类' }
const quantities = { thickness_a: '板厚 A', thickness_b: '板厚 B', manufacturing_length: '制造长度', measured_length: '人工测量长度' }
const passUnits: Record<string, string[]> = { current: ['A'], voltage: ['V'], speed: ['mm/min', 'in/min'] }
const passLabels: Record<string, string> = { current: '电流', voltage: '电压', speed: '速度' }
const value = (event: Event) => (event.target as HTMLInputElement).value
const quantity = (v: unknown) => v as { value: number; unit: string } | null
const passes = (w: Record<string, unknown>) => (w.passes ?? []) as Record<string, unknown>[]
const steps = (w: Record<string, unknown>) => (w.welding_steps ?? []) as string[]
function edit(change: (next: PlanPayload) => void) { if (props.disabled) return; try { const next = clone(props.payload); change(next); emit('change', next); error.value = '' } catch (e) { error.value = e instanceof Error ? e.message : '字段无法确认' } }
function root(key: string, v: unknown) { edit(p => { p[key] = v }) }
function set(id: string, key: string, v: unknown) { edit(p => { p.welds.find(w => w.weld_id === id)![key] = v }) }
function amount(v: string, unit: string) { need(v === '' || Number.isFinite(Number(v)) && Number(v) >= 0, '数值必须有限且非负'); return v === '' ? null : { value: Number(v), unit } }
function setQuantity(id: string, key: string, v: string, unit: string) { edit(p => { p.welds.find(w => w.weld_id === id)![key] = amount(v, unit) }) }
function changePasses(id: string, change: (rows: Record<string, unknown>[]) => void) { edit(p => { const weld = p.welds.find(w => w.weld_id === id)!, rows = passes(weld); change(rows); need(rows.length <= 100 && rows.every(r => Number.isInteger(r.sequence) && Number(r.sequence) > 0) && new Set(rows.map(r => r.sequence)).size === rows.length, '层道序号必须为唯一正整数，最多100道'); weld.passes = rows }) }
function setPass(id: string, index: number, key: string, v: unknown) { changePasses(id, rows => { rows[index][key] = v }) }
function setPassQuantity(id: string, index: number, key: string, v: string, unit: string) { changePasses(id, rows => { rows[index][key] = amount(v, unit) }) }
function addPass(id: string) { changePasses(id, rows => rows.push({ sequence: Math.max(0, ...rows.map(r => Number(r.sequence))) + 1, method: '', filler: '', current: null, voltage: null, speed: null })) }
function changeSteps(id: string, change: (rows: string[]) => void) { edit(p => { const weld = p.welds.find(w => w.weld_id === id)!, rows = steps(weld); change(rows); need(rows.length <= 100 && rows.every(s => s.trim() && Array.from(s).length <= 4000), '步骤不能为空，每项最多4000字符、最多100项'); weld.welding_steps = rows }) }
function moveStep(id: string, index: number, delta: number) { changeSteps(id, rows => { const [step] = rows.splice(index, 1); rows.splice(index + delta, 0, step) }) }
function addStep(id: string) { changeSteps(id, rows => rows.push(newSteps[id])); newSteps[id] = '' }
</script>
<style scoped>
article { border-top: 1px solid #d9e2ec; margin-top: 16px; } label { display: inline-flex; flex-direction: column; margin: 6px; gap: 4px; } textarea { min-height: 50px; } button { margin: 5px; }
</style>

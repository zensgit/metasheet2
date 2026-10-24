<template>
  <section aria-label="批量编辑焊缝字段">
    <h3>批量编辑工艺参数、分组与统计参与</h3>
    <fieldset :disabled="!session.canEdit.value || working === 'confirm'">
      <legend>选择焊缝</legend>
      <label v-for="weld in session.state.payload.welds" :key="weld.weld_id">
        <input v-model="selected" type="checkbox" :value="weld.weld_id">{{ weld.display_no }} · {{ weld.weld_id }}
      </label>
    </fieldset>
    <fieldset :disabled="!session.canEdit.value || working === 'confirm'">
      <legend>只修改勾选的字段</legend>
      <label><input v-model="enabled.group_name" type="checkbox">修改统计分组</label>
      <label>新的统计分组<input v-model="values.group_name" :disabled="!enabled.group_name"></label>
      <label><input v-model="enabled.classification" type="checkbox">修改企业分类</label>
      <label>新的企业分类<input v-model="values.classification" :disabled="!enabled.classification"></label>
      <label><input v-model="enabled.included" type="checkbox">修改统计参与</label>
      <label>新的参与状态<select v-model="values.included" :disabled="!enabled.included"><option :value="true">参与统计</option><option :value="false">排除统计</option></select></label>
      <label><input v-model="processEnabled" type="checkbox">修改工艺参数</label>
      <label>工艺参数列<select v-model="processField" :disabled="!processEnabled"><option v-for="(label, key) in processFields" :key="key" :value="key">{{ label }}</option></select></label>
      <label>新的工艺参数值<textarea v-if="!quantityField" v-model="processValue" :disabled="!processEnabled" /><input v-else :value="processValue" type="number" min="0" step="any" :disabled="!processEnabled" @input="numberInput"></label>
      <label v-if="quantityField">工艺参数单位<select v-model="processUnit" :disabled="!processEnabled"><option>mm</option><option>in</option></select></label>
      <p>空值表示明确清除。排除统计保留焊缝、图形及工艺参数。</p>
      <button :disabled="!!working || !selected.length || !processEnabled && !keys.some(key => enabled[key])" @click="prepare">预览批量变更</button>
    </fieldset>
    <table v-if="preview">
      <caption>批量变更预览</caption>
      <thead><tr><th>焊缝</th><th>字段</th><th>原值</th><th>新值</th></tr></thead>
      <tbody><tr v-for="row in preview.rows" :key="`${row.weld_id}:${row.field}`"><td>{{ row.display_no }} · {{ row.weld_id }}</td><td>{{ labels[row.field] }}</td><td>{{ display(row.before, row.field) }}</td><td>{{ display(row.after, row.field) }}</td></tr></tbody>
    </table>
    <button :disabled="!preview || !!working || !session.canEdit.value" @click="confirm">确认批量变更</button>
    <button :disabled="working === 'confirm' || !preview && working !== 'preview'" @click="cancel">取消批量预览</button>
    <p role="status">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue'
import { clone, equal, need, safeId, text, validatePayload, type PlanPayload } from '../../services/welding/planRecovery'
import type { RequestScope } from '../../services/welding/planClient'
import type { useWeldingPlanSession } from './useWeldingPlanSession'

const props = defineProps<{ session: ReturnType<typeof useWeldingPlanSession>; barrier: () => Promise<void> }>()
const keys = ['group_name', 'classification', 'included'] as const
const processFields = { location: '位置', joint_type: '接头形式', method: '焊接方法', material_a: '母材 A', material_b: '母材 B', filler: '填充材料', welding_requirements: '焊接要求', inspection_requirements: '检验要求', thickness_a: '板厚 A', thickness_b: '板厚 B', manufacturing_length: '制造长度', measured_length: '人工测量长度' }
type ProcessField = keyof typeof processFields
type Field = typeof keys[number] | ProcessField
type Row = { weld_id: string; display_no: string; field: Field; before: unknown; after: unknown }
const labels = { group_name: '统计分组', classification: '企业分类', included: '统计参与', ...processFields }
const selected = ref<string[]>([]), enabled = reactive({ group_name: false, classification: false, included: false })
const values = reactive({ group_name: '', classification: '', included: true })
const processEnabled = ref(false), processField = ref<ProcessField>('method'), processValue = ref(''), processUnit = ref('mm')
const quantityFields = ['thickness_a', 'thickness_b', 'manufacturing_length', 'measured_length']
const quantityField = computed(() => quantityFields.includes(processField.value))
const processBadInput = ref(false)
watch(quantityField, () => { processBadInput.value = false }, { flush: 'sync' })
function numberInput(event: Event) {
  const input = event.target as HTMLInputElement
  processBadInput.value = input.validity.badInput
  processValue.value = input.value
}
const working = ref<'' | 'preview' | 'confirm'>(''), message = ref('')
const preview = shallowRef<{ rows: Row[]; payload: PlanPayload; scope: RequestScope } | null>(null)
let serial = 0, disposed = false
const signature = computed(() => JSON.stringify([props.session.state.owner, props.session.state.planId, props.session.state.versionId,
  props.session.state.recoveryId, props.session.state.draftSeq, props.session.state.contentHash, props.session.state.editSeq,
  props.session.state.payload, selected.value, enabled, values, processEnabled.value, processField.value, processValue.value, processUnit.value, processBadInput.value]))
function invalidate() {
  if (preview.value || working.value === 'preview') message.value = '选择、字段或正文已变化，请重新预览'
  serial++; preview.value = null
}
watch(signature, invalidate, { flush: 'sync' })
watch(() => JSON.stringify([props.session.state.owner, props.session.state.planId, props.session.state.versionId, props.session.state.recoveryId]), () => { selected.value = [] }, { flush: 'sync' })
onScopeDispose(() => { disposed = true; invalidate() })
function display(value: unknown, field: Field) {
  if (value === undefined) return field === 'included' ? '未设置（默认参与）' : '未设置'
  if (quantityFields.includes(field)) return value === null ? '空（清除）' : JSON.stringify(value)
  return field === 'included' ? value ? '参与' : '排除' : value === '' ? '空（清除）' : String(value)
}
function cancel() { if (working.value === 'confirm') return; invalidate(); message.value = '批量预览已取消，正文未修改' }
async function prepare() {
  if (working.value || !props.session.canEdit.value) return
  invalidate(); const epoch = serial, captured = props.session.capture(), before = signature.value
  const scope: RequestScope = { signal: captured.signal, accepts: () => !disposed && captured.accepts() && epoch === serial && signature.value === before }
  working.value = 'preview'; message.value = '正在核对图纸快照'
  try {
    await props.barrier(); props.session.check(scope); need(props.session.canEdit.value, '当前不能批量编辑')
    const fields: Field[] = keys.filter(key => enabled[key]), ids = new Set(selected.value)
    const after: Partial<Record<Field, unknown>> = { ...values }
    if (processEnabled.value) {
      const field = processField.value, value = processValue.value
      need(Object.hasOwn(processFields, field), '请选择已有工艺参数列')
      if (quantityField.value) {
        need(!processBadInput.value && ['mm', 'in'].includes(processUnit.value) && (value === '' || value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0), '数值必须有限且非负，单位为mm或in')
        after[field] = value === '' ? null : { value: Number(value), unit: processUnit.value }
      } else {
        text(value); need(Array.from(value).length <= (['welding_requirements', 'inspection_requirements'].includes(field) ? 4000 : 256), '工艺参数文字超出长度限制')
        after[field] = value
      }
      fields.push(field)
    }
    need(fields.length && ids.size && ids.size === selected.value.length, '请选择焊缝和需要修改的字段')
    for (const field of keys.filter(key => enabled[key])) {
      if (field === 'included') need(typeof values[field] === 'boolean')
      else if (values[field] !== '') safeId(values[field])
    }
    const payload = clone(props.session.state.payload), rows: Row[] = []
    for (const weld of payload.welds) if (ids.delete(weld.weld_id)) for (const field of fields) {
      rows.push({ weld_id: weld.weld_id, display_no: weld.display_no, field, before: weld[field], after: clone(after[field]) })
      weld[field] = clone(after[field])
    }
    need(ids.size === 0, '所选焊缝已变化，请重新选择'); validatePayload(payload)
    need(!equal(payload, props.session.state.payload), '所选字段没有变更')
    props.session.check(scope); preview.value = { rows, payload, scope }; message.value = '请核对前后值，再明确确认'
  } catch (error) { if (!disposed && epoch === serial) message.value = error instanceof Error ? error.message : '预览未确认' }
  finally { working.value = '' }
}
async function confirm() {
  const candidate = preview.value
  if (!candidate || working.value || !props.session.canEdit.value) return
  working.value = 'confirm'; message.value = '正在核对并应用批量变更'
  try {
    await props.session.withTargetMutation(async scope => {
      await props.barrier(); props.session.check(scope)
      need(preview.value === candidate && props.session.canEdit.value, '批量预览已过期，请重新预览')
      await props.session.commitPayload(candidate.payload, scope)
    }, candidate.scope)
    if (!disposed) { invalidate(); message.value = '批量变更已加入一次撤销历史，尚未保存到服务器' }
  } catch (error) { if (!disposed) { invalidate(); message.value = error instanceof Error ? error.message : '批量变更未确认' } }
  finally { working.value = '' }
}
</script>
<style scoped>
fieldset { margin: 10px 0; } label { display: inline-flex; gap: 6px; margin: 6px; } table { border-collapse: collapse; width: 100%; } th, td { padding: 8px; border: 1px solid #d9e2ec; text-align: left; } button { margin: 5px; }
</style>

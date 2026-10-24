<template>
  <section class="assembly-panel">
    <h2>装配关联</h2>
    <p>先保存当前草稿，再选择固定 BOM 中的两个完整位置。材料与厚度由人工填写；缺少事实时保持待核对。</p>
    <p v-if="!session.canAssembly.value">请先保存编辑、核对原请求并读取可写草稿。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <button :disabled="!session.canAssembly.value" @click="invoke(() => session.readAssemblyCandidates())">读取固定 BOM 装配位置</button>
    <div v-if="state.assemblyCandidates.length">
      <label>固定 BOM<select v-model="baselineId" :disabled="!session.canAssembly.value" @change="resetChoices">
        <option value="">请选择固定 BOM</option>
        <option v-for="bom in state.assemblyCandidates" :key="bom.baseline_id" :value="bom.baseline_id">{{ bom.number }} · {{ bom.name }}</option>
      </select></label>
      <p v-if="candidate">捕获深度 {{ candidate.captured_depth }} · {{ candidate.occurrences.length + 1 }} 个装配位置</p>
      <label>关联焊缝<select v-model="weldId" :disabled="!session.canAssembly.value" @change="resetSides">
        <option value="">请选择焊缝</option><option v-for="weld in state.payload.welds" :key="weld.weld_id" :value="weld.weld_id">{{ weld.display_no }} · {{ weld.weld_id }}</option>
      </select></label>
      <p v-if="roleHints" role="note">来源人工角色提示：A 侧 {{ roleHints.a }}；B 侧 {{ roleHints.b }}。请人工选择目标位置；来源角色不代表位置对应或专业适用。</p>
      <fieldset v-for="name in sideNames" :key="name" :disabled="!session.canAssembly.value || !candidate">
        <legend>{{ name.toUpperCase() }} 侧人工选择</legend>
        <label>装配位置<select v-model="sides[name].path" @change="resetWitness(name)">
          <option value="">请选择完整位置</option>
          <option v-for="node in nodes" :key="pathKey(node.path)" :value="pathKey(node.path)">{{ pathLabel(node.path) }} · {{ node.number }} · {{ node.name }} · {{ node.version_label }}{{ node.quantity === undefined ? '' : ` · ${node.quantity} ${node.uom}` }}</option>
        </select></label>
        <label>人工角色名称<input v-model="sides[name].role" maxlength="128" @input="clearPreview"></label>
        <label>人工材料见证（可空）<input v-model="sides[name].material" maxlength="256" @input="clearPreview"></label>
        <label>人工厚度见证（可空）<input v-model="sides[name].thickness" type="number" min="0" step="any" @input="clearPreview"></label>
        <label>厚度单位<select v-model="sides[name].unit" @change="clearPreview"><option value="">请选择</option><option value="mm">mm</option><option value="in">in</option></select></label>
      </fieldset>
      <div class="actions">
        <button v-if="basisChange" :disabled="!ready" @click="invoke(stageProposal)">暂存此焊缝拟改</button>
        <button v-if="!basisChange" :disabled="!ready" @click="submit(false)">明确保存装配关联</button>
        <button v-else :disabled="!ready" @click="submit(true)">比较固定 BOM 变化</button>
      </div>
      <div v-if="staged.length">
        <p>已暂存 {{ staged.length }} 条装配拟改；比较包含这些拟改和当前选择，尚未保存。</p>
        <ul aria-label="已暂存装配拟改"><li v-for="row in staged" :key="row.weldId">
          {{ state.payload.welds.find(weld => weld.weld_id === row.weldId)?.display_no }} · {{ row.weldId }}
          <button :disabled="!session.canAssembly.value" @click="removeProposal(row.weldId)">移除此拟改</button>
        </li></ul>
        <button :disabled="!session.canAssembly.value" @click="resetChoices">清空装配拟改</button>
      </div>
    </div>
    <div v-if="state.assemblyPreview" class="assembly-preview">
      <h3>装配变化比较</h3>
      <p>比较尚未保存。待核对的事实不能视为没有影响。</p>
      <p v-if="!state.assemblyPreview.impact.affected_welds.length">当前比较未列出变化。</p>
      <table v-else><thead><tr><th>焊缝</th><th>变化</th><th>已保存关联</th><th>拟应用关联</th><th>事实状态</th></tr></thead>
        <tbody><tr v-for="row in state.assemblyPreview.impact.affected_welds" :key="row.weld_id">
          <td>{{ row.weld_id }}</td><td>{{ row.reason_codes.map(reasonLabel).join('；') }}</td>
          <td>{{ viewLabel(row.before) }}</td><td>{{ viewLabel(row.after) }}</td><td>{{ row.state === 'unknown' ? '待核对' : '已有固定事实' }}</td>
        </tr></tbody>
      </table>
      <button :disabled="!session.canAssembly.value" @click="invoke(() => session.applyAssembly())">明确应用装配变化</button>
      <button :disabled="state.busy" @click="clearPreview">关闭本次比较</button>
    </div>
    <div v-if="associated.length">
      <h3>明确取消已有关联</h3>
      <label>取消关联的焊缝<select v-model="cancelWeld" :disabled="!session.canAssembly.value"><option value="">请选择</option><option v-for="weld in associated" :key="weld.weld_id" :value="weld.weld_id">{{ weld.display_no }} · {{ weld.weld_id }}</option></select></label>
      <label>取消原因<textarea v-model="cancelReason" :disabled="!session.canAssembly.value" maxlength="4000" /></label>
      <button :disabled="!session.canAssembly.value || !cancelWeld || !cancelReason.trim()" @click="invoke(() => session.cancelAssembly(cancelWeld, cancelReason))">明确取消装配关联</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { useWeldingPlanSession } from './useWeldingPlanSession'
import type { AssemblyView } from '../../services/welding/planClient'
import { clone, equal, isObject, need, validateAssemblySide, type AssemblySide } from '../../services/welding/planRecovery'
const props = defineProps<{ session: ReturnType<typeof useWeldingPlanSession> }>()
const session = props.session, state = session.state
const baselineId = ref(''), weldId = ref(''), cancelWeld = ref(''), cancelReason = ref(''), message = ref('')
const sideNames = ['a', 'b'] as const
const emptySide = () => ({ path: '', role: '', material: '', thickness: '', unit: '' as '' | 'mm' | 'in', witnessId: '' })
const sides = reactive({ a: emptySide(), b: emptySide() })
const staged = ref<Array<{ weldId: string; connection: { a: AssemblySide; b: AssemblySide } }>>([])
const candidate = computed(() => state.assemblyCandidates.find(value => value.baseline_id === baselineId.value))
const nodes = computed(() => candidate.value ? [candidate.value.root, ...candidate.value.occurrences] : [])
const associated = computed(() => state.payload.welds.filter(weld => isObject(weld.assembly)))
const roleHints = computed(() => {
  const value = state.payload.welds.find(weld => weld.weld_id === weldId.value)?.assembly_role_hints
  return isObject(value) && typeof value.a === 'string' && typeof value.b === 'string' ? value as { a: string; b: string } : null
})
const basisChange = computed(() => isObject(state.payload.bom) && candidate.value
  && !equal(state.payload.bom, { baseline_id: candidate.value.baseline_id, expected_fingerprint: candidate.value.fingerprint }))
const ready = computed(() => session.canAssembly.value && candidate.value && weldId.value && sides.a.path && sides.b.path
  && sides.a.path !== sides.b.path && sides.a.role.trim() && sides.b.role.trim())
const pathKey = (path: string[]) => JSON.stringify(path)
const pathLabel = (path: string[]) => path.length ? path.join(' / ') : '/（根）'
function clearPreview() { session.clearAssemblyPreview(); message.value = '' }
function resetWitness(name: 'a' | 'b') { Object.assign(sides[name], { material: '', thickness: '', unit: '', witnessId: '' }); clearPreview() }
function resetSides() { Object.assign(sides.a, emptySide()); Object.assign(sides.b, emptySide()); clearPreview() }
function resetChoices() { staged.value = []; resetSides() }
function removeProposal(id: string) {
  clearPreview(); staged.value = staged.value.filter(row => row.weldId !== id)
  if (weldId.value === id) resetSides()
}
async function stageProposal() {
  need(ready.value && basisChange.value)
  const proposal = { weldId: weldId.value, connection: { a: selectedSide('a'), b: selectedSide('b') } }
  clearPreview(); staged.value = [...staged.value.filter(row => row.weldId !== weldId.value), clone(proposal)]
}
function selectedSide(name: 'a' | 'b'): AssemblySide {
  const input = sides[name], node = nodes.value.find(value => pathKey(value.path) === input.path)
  need(node, '请选择完整装配位置')
  const side: AssemblySide = { role: input.role, path: [...node.path], item_id: node.item_id, version_id: node.version_id }
  need(Boolean(input.thickness) === Boolean(input.unit), '人工厚度和单位请同时填写，或同时留空')
  if (input.material || input.thickness) {
    if (!input.witnessId) input.witnessId = crypto.randomUUID()
    side.witness = { witness_id: input.witnessId, source: 'manual', ...(input.material ? { material: input.material } : {}),
      ...(input.thickness && input.unit ? { thickness: { value: Number(input.thickness), unit: input.unit } } : {}) }
  }
  return validateAssemblySide(side)
}
async function invoke(action: () => Promise<void>) {
  message.value = ''
  try { await action() } catch (error) { message.value = error instanceof Error ? error.message : '装配动作未确认' }
}
async function submit(preview: boolean) {
  await invoke(async () => {
    need(candidate.value && weldId.value)
    const connection = { a: selectedSide('a'), b: selectedSide('b') }
    if (preview) {
      if (staged.value.length) await session.previewAssembly(candidate.value, weldId.value, connection, clone(staged.value))
      else await session.previewAssembly(candidate.value, weldId.value, connection)
    }
    else await session.saveAssembly(candidate.value, weldId.value, connection)
  })
}
const reasons: Record<string, string> = {
  assembly_adopted: '新增装配关联', assembly_cancelled: '取消装配关联', weld_removed: '移除焊缝',
  assembly_selection_changed: '关联位置或角色变化', assembly_occurrence_changed: '固定位置事实变化', assembly_witness_changed: '人工见证变化',
  missing_bom: '固定 BOM 缺失', outside_captured_depth: '超出捕获深度', missing_occurrence: '完整位置缺失',
  occurrence_identity_changed: '位置的零件版本变化', missing_witness: '人工材料或厚度见证待核对', missing_mapping: '两侧关联待核对',
}
const reasonLabel = (reason: string) => reasons[reason] ?? '影响待核对'
function viewLabel(view: AssemblyView | null) {
  if (!view) return '无装配关联'
  return sideNames.map(name => {
    const side = view.sides[name], witness = side.selection.witness
    return `${name.toUpperCase()} ${side.selection.role} · ${pathLabel(side.selection.path)} · ${side.selection.item_id} / ${side.selection.version_id}`
      + (side.facts ? ` · 数量 ${side.facts.quantity ?? '未提供'} ${side.facts.uom ?? ''}` : ' · 固定位置事实待核对')
      + (witness?.material ? ` · 人工材料 ${witness.material}` : ' · 人工材料待核对')
      + (witness?.thickness ? ` · 人工厚度 ${witness.thickness.value} ${witness.thickness.unit}` : ' · 人工厚度待核对')
  }).join('；')
}
watch([
  () => state.owner?.tenant_id, () => state.owner?.org_id, () => state.owner?.auth_user_id, () => state.owner?.rbac_user_id,
  () => state.planId, () => state.versionId, () => state.serverState, () => state.recoveryId, () => state.draftSeq, () => state.contentHash,
  () => state.editSeq, () => state.dirty, () => state.blocked, () => Boolean(state.pending),
  () => JSON.stringify(state.assemblyCandidates.map(value => [value.baseline_id, value.fingerprint])),
], () => { baselineId.value = ''; weldId.value = ''; cancelWeld.value = ''; cancelReason.value = ''; resetChoices() }, { flush: 'sync' })
</script>

<style scoped>
.assembly-panel { min-width: 0; border: 1px solid #d9e2ec; border-radius: 6px; padding: 12px; margin: 12px 0; }
label { max-width: calc(100% - 12px); display: inline-flex; flex-direction: column; gap: 4px; margin: 6px 12px 6px 0; }
fieldset { min-width: 0; border: 1px solid #d9e2ec; margin: 8px 0; } table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px; border: 1px solid #d9e2ec; overflow-wrap: anywhere; }
.actions { margin: 8px 0; } input, select, textarea, button { font: inherit; } select { max-width: 100%; } button { margin: 4px; }
</style>

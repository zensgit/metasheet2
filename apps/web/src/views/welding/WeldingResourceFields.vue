<template>
  <section>
    <h3>固定版本资料参数</h3>
    <label>目标焊缝<select v-model="weldId"><option value="">请选择</option><option v-for="w in session.state.payload.welds" :key="w.weld_id" :value="w.weld_id">{{ w.display_no }}</option></select></label>
    <label>资料 ID<input v-model="resourceId"></label><label>版本 ID<input v-model="versionId"></label>
    <button :disabled="busy || !session.state.owner || !weldId" @click="read()">读取固定版本并预览</button>
    <section aria-label="焊缝固定接头图">
      <h4>焊缝固定接头图</h4>
      <p v-if="currentDiagram">当前图：{{ currentDiagram.resource_id }} / {{ currentDiagram.version_id }} · {{ currentDiagram.expected_content_hash }}</p>
      <p v-else>当前焊缝没有图引用。</p>
      <button v-if="currentDiagram" :disabled="busy" @click="chooseCurrentDiagram">选择当前固定图供预览</button>
      <WeldingJointDiagramPreview :stamp="diagramStamp" :disabled="busy || !session.state.owner || !weldId" :load="loadDiagram" @ready="diagramReady = $event" />
      <p v-if="diagramReady">拟引用图：{{ diagramReady.record.resource_id }} / {{ diagramReady.record.item_version_id }} · {{ diagramReady.record.content_hash }}</p>
      <button :disabled="!diagramReady || busy || !session.canEdit.value" @click="applyDiagram">{{ currentDiagram ? '明确替换接头图引用' : '明确引用接头图' }}</button>
      <button v-if="currentDiagram" :disabled="busy || !session.canEdit.value" @click="removeDiagram">解除整项接头图引用</button>
      <p>图引用与文字参数独立；保存后固定版本不自动升级。</p>
    </section>
    <div v-if="preview">
      <p>{{ preview.record.kind }} · {{ preview.record.resource_id }} / {{ preview.record.item_version_id }} · {{ preview.record.content_hash }}</p>
      <table><thead><tr><th>明确带入</th><th>字段</th><th>当前值</th><th>登记值</th></tr></thead><tbody>
        <tr v-for="(registered, key) in preview.values" :key="key"><td><input v-model="selected" type="checkbox" :value="key" :disabled="busy || !session.canEdit.value"></td><td>{{ resourceFields[key] }}</td><td><pre>{{ display(preview.current[key]) }}</pre></td><td><pre>{{ display(registered) }}</pre></td></tr>
      </tbody></table>
      <p v-if="selected.includes('passes')">确认将整体替换层道；未选字段保持当前值。</p>
      <button :disabled="busy || !selected.length || !session.canEdit.value" @click="apply()">带入明确选定字段</button>
    </div>
    <h4>已登记来源与手工值</h4>
    <article v-for="reference in references" :key="String(reference.reference_id)">
      <p>{{ reference.resource_id }} / {{ reference.version_id }}</p>
      <div v-for="key in reference.selected_fields as string[]" :key="key">
        {{ resourceFields[key] }} · 当前 {{ display(currentWeld?.[key]) }}
        <button :disabled="busy" @click="readReference(reference)">查阅原登记值</button>
        <button :disabled="busy || !session.canEdit.value" @click="remove(String(reference.reference_id), key)">解除此字段引用</button>
      </div>
    </article>
    <p role="alert">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { resourceFields, type ResourceRecord, type RequestScope } from '../../services/welding/planClient'
import { clone, equal, isObject, need } from '../../services/welding/planRecovery'
import type { useWeldingPlanSession } from './useWeldingPlanSession'
import { resourceDiagram, type ResourceMaintenanceRecord } from '../../services/welding/resourceContracts'
import WeldingJointDiagramPreview from './WeldingJointDiagramPreview.vue'
const props = defineProps<{ session: ReturnType<typeof useWeldingPlanSession> }>()
let diagramChoiceEpoch = 0
const weldId = ref(''), resourceId = ref(''), versionId = ref(''), message = ref(''), busy = ref(false), selected = ref<string[]>([])
const preview = ref<null | { scope: RequestScope; weldId: string; record: ResourceRecord; current: Record<string, unknown>; values: Record<string, unknown> }>(null)
const currentWeld = computed(() => props.session.state.payload.welds.find(w => w.weld_id === weldId.value))
const diagramReady = ref<null | { record: ResourceMaintenanceRecord; scope: RequestScope }>(null)
const currentDiagram = computed(() => ((props.session.state.payload.resource_refs ?? []) as Record<string, unknown>[]).find(r => r.weld_id === weldId.value && r.purpose === 'joint_diagram'))
const diagramStamp = computed(() => JSON.stringify([weldId.value, resourceId.value, versionId.value, props.session.state.owner, props.session.state.planId,
  props.session.state.versionId, props.session.state.editSeq, props.session.state.pending, props.session.state.commandPending]))
const references = computed(() => ((props.session.state.payload.resource_refs ?? []) as Record<string, unknown>[]).filter(r => r.weld_id === weldId.value && !r.purpose))
const display = (v: unknown) => v === undefined ? '未填写' : JSON.stringify(v, null, 2)
watch(() => JSON.stringify([props.session.state.owner, props.session.state.planId, props.session.state.versionId]), () => { preview.value = null; selected.value = []; weldId.value = '' })
watch([weldId, resourceId, versionId], () => { diagramChoiceEpoch++; preview.value = null; selected.value = [] }, { flush: 'sync' })
async function perform(action: () => Promise<void>) { if (busy.value) return; busy.value = true; try { await action(); message.value = '' } catch (e) { message.value = e instanceof Error ? e.message : '资料操作未确认' } finally { busy.value = false } }
async function read(expectedHash?: string) {
  await perform(async () => {
    const session = props.session, scope = session.capture(), target = weldId.value, resource = resourceId.value, version = versionId.value
    const owner = await session.fresh(scope); session.check(scope)
    const record = await session.client.resource(resource, version, scope); session.check(scope)
    need(equal(await session.fresh(scope), owner)); session.check(scope)
    need(weldId.value === target && resourceId.value === resource && versionId.value === version && (!expectedHash || expectedHash === record.content_hash), '固定资料预览已变化')
    const weld = session.state.payload.welds.find(w => w.weld_id === target); need(weld)
    const values = clone(record.payload.suggested_fields)
    if (Array.isArray(values.passes)) values.passes = values.passes.map(pass => { need(isObject(pass)); return { method: '', filler: '', current: null, voltage: null, speed: null, ...pass } })
    preview.value = { scope, weldId: target, record, values, current: Object.fromEntries(Object.keys(values).map(key => [key, clone(weld[key] ?? null)])) }; selected.value = []
  })
}
async function readReference(reference: Record<string, unknown>) { resourceId.value = String(reference.resource_id); versionId.value = String(reference.version_id); await read(String(reference.expected_content_hash)) }
function chooseCurrentDiagram() {
  const current = currentDiagram.value; if (!current) return
  resourceId.value = String(current.resource_id); versionId.value = String(current.version_id)
}
async function loadDiagram(selection: RequestScope) {
  const session = props.session, admitted = session.capture(), target = weldId.value, resource = resourceId.value, version = versionId.value
  const scope: RequestScope = { signal: selection.signal, accepts: () => admitted.accepts() && selection.accepts()
    && weldId.value === target && resourceId.value === resource && versionId.value === version }
  need(target && session.state.payload.welds.some(w => w.weld_id === target))
  const owner = await session.fresh(scope); session.check(scope)
  const record = await session.client.readResource(resource, version, scope); session.check(scope); resourceDiagram(record)
  const current = currentDiagram.value
  if (current?.resource_id === resource && current.version_id === version) need(current.expected_content_hash === record.content_hash, '当前图固定摘要已变化')
  const blob = await session.client.readResourceDiagram(record, scope); session.check(scope)
  need(equal(await session.fresh(scope), owner)); session.check(scope)
  return { blob, record, scope }
}
async function applyDiagram() {
  const p = diagramReady.value
  if (!p || busy.value) return
  const session = props.session
  try {
    need(session.canEdit.value); session.check(p.scope)
    const captured = session.capture(), choiceEpoch = diagramChoiceEpoch
    const scope: RequestScope = { signal: captured.signal, accepts: () => captured.accepts() && choiceEpoch === diagramChoiceEpoch }
    busy.value = true
    const owner = await session.fresh(scope); session.check(scope)
    const record = await session.client.readResource(p.record.resource_id, p.record.item_version_id, scope); session.check(scope)
    resourceDiagram(record); need(record.content_hash === p.record.content_hash, '固定图引用摘要已变化')
    need(equal(await session.fresh(scope), owner)); session.check(scope)
    const next = clone(session.state.payload), target = weldId.value
    need(next.welds.some(w => w.weld_id === target)); resourceDiagram(p.record)
    const refs = ((next.resource_refs ?? []) as Record<string, unknown>[]).filter(r => !(r.weld_id === target && r.purpose === 'joint_diagram'))
    need(refs.length < 500)
    next.resource_refs = [...refs, { reference_id: crypto.randomUUID(), weld_id: target, resource_id: p.record.resource_id,
      version_id: p.record.item_version_id, expected_content_hash: p.record.content_hash, purpose: 'joint_diagram', selected_fields: [] }]
    await session.commitPayload(next, scope); message.value = ''
  } catch (error) { message.value = error instanceof Error ? error.message : '图引用未确认' }
  finally { busy.value = false }
}
async function removeDiagram() {
  await perform(async () => {
    const session = props.session, current = currentDiagram.value; need(current && session.canEdit.value)
    const next = clone(session.state.payload)
    next.resource_refs = ((next.resource_refs ?? []) as Record<string, unknown>[]).filter(r => r.reference_id !== current.reference_id)
    await session.commitPayload(next)
  })
}
async function apply() {
  await perform(async () => {
    const p = preview.value, session = props.session; need(p && session.canEdit.value); session.check(p.scope)
    need(selected.value.length && new Set(selected.value).size === selected.value.length && selected.value.every(key => Object.hasOwn(p.values, key)))
    const next = clone(session.state.payload), weld = next.welds.find(w => w.weld_id === p.weldId); need(weld)
    const previous = (next.resource_refs ?? []) as Record<string, any>[], fields = [...selected.value]
    const same = previous.find(r => !r.purpose && r.weld_id === weld.weld_id && r.resource_id === p.record.resource_id && r.version_id === p.record.item_version_id && r.expected_content_hash === p.record.content_hash)
    const refs = previous.filter(r => r !== same).map(r => !r.purpose && r.weld_id === weld.weld_id ? { ...r, selected_fields: r.selected_fields.filter((key: string) => !fields.includes(key)) } : r).filter(r => r.purpose === 'joint_diagram' || r.selected_fields.length)
    need(refs.length < 500)
    next.resource_refs = [...refs, { reference_id: same?.reference_id ?? crypto.randomUUID(), weld_id: weld.weld_id, resource_id: p.record.resource_id, version_id: p.record.item_version_id, expected_content_hash: p.record.content_hash, selected_fields: [...new Set([...(same?.selected_fields ?? []), ...fields])] }]
    fields.forEach(key => { weld[key] = clone(p.values[key]) })
    await session.commitPayload(next, p.scope); preview.value = null; selected.value = []
  })
}
async function remove(id: string, key: string) { await perform(async () => { const session = props.session; need(session.canEdit.value); const next = clone(session.state.payload); next.resource_refs = ((next.resource_refs ?? []) as Record<string, any>[]).map(r => !r.purpose && r.reference_id === id ? { ...r, selected_fields: r.selected_fields.filter((field: string) => field !== key) } : r).filter(r => r.purpose === 'joint_diagram' || r.selected_fields.length); await session.commitPayload(next); preview.value = null }) }
</script>
<style scoped>
label { display: inline-flex; flex-direction: column; margin: 6px; } td, th { border: 1px solid #d9e2ec; padding: 8px; } pre { white-space: pre-wrap; } button { margin: 5px; }
</style>

<template>
  <section>
    <h3>更换固定底图</h3>
    <p>准备和预览保留当前草稿。确认后，原有焊缝与叠层保留；图纸变更产生的复核义务须逐项处理。</p>
    <label>查找替换图纸<input v-model="query" :disabled="confirming"></label>
    <button :disabled="!session.canChangeDrawing.value || busy || !query.trim()" @click="search">查找图纸</button>
    <ul><li v-for="item in candidates" :key="`${item.item_id}/${item.version_id}/${item.file_id}`">
      <button :disabled="!session.canChangeDrawing.value || confirming" @click="select(item)">{{ item.number }} · {{ item.name }} · {{ item.version_label }} · {{ item.file_id }}</button>
    </li></ul>
    <p v-if="selected">候选：{{ selected.name }} · {{ selected.version_label }} · {{ selected.file_id }}</p>
    <button :disabled="!selected || !session.canChangeDrawing.value || busy" @click="prepare">准备并预览换图</button>
    <button :disabled="!ready || !session.canChangeDrawing.value || busy" @click="confirm">确认换图并保存</button>
    <button :disabled="confirming || (!selected && !busy && !preview)" @click="cancel">取消换图预览</button>
    <button v-if="drawingDiffers" :disabled="!session.canEdit.value || busy" @click="adopt">采用已保存底图并保留其它编辑</button>
    <div v-if="preview"><h4>已保存底图</h4><pre>{{ preview.preparation.source_change.before.payload.drawing }}</pre><h4>候选底图</h4><pre>{{ preview.preparation.source_change.after.payload.drawing }}</pre></div>
    <div :hidden="!preview"><iframe ref="beforeFrame" title="换图前只读预览" /><iframe ref="afterFrame" title="换图后只读预览" /></div>
    <p v-if="preview && !ready">两侧图纸均加载完成后才能确认。</p>
    <p role="alert">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { clone, equal, need } from '../../services/welding/planRecovery'
import { loadReadOnlyCad } from '../../services/welding/cadBridge'
import type { DrawingCandidate, RequestScope } from '../../services/welding/planClient'
import type { SourceChangePreview, useWeldingPlanSession } from './useWeldingPlanSession'
const props = defineProps<{ session: ReturnType<typeof useWeldingPlanSession> }>()
const query = ref(''), selected = ref<DrawingCandidate | null>(null), candidates = ref<DrawingCandidate[]>([])
const preview = ref<SourceChangePreview | null>(null), ready = ref(false), busy = ref(false), confirming = ref(false), message = ref('')
const beforeFrame = ref<HTMLIFrameElement>(), afterFrame = ref<HTMLIFrameElement>()
let epoch = 0, controller = new AbortController(), viewers: Array<ReturnType<typeof loadReadOnlyCad>> = []
const drawingDiffers = computed(() => !!props.session.state.savedPoint && !equal(props.session.state.payload.drawing, props.session.state.savedPoint.payload.drawing))
function clear() { epoch++; controller.abort(); controller = new AbortController(); viewers.forEach(v => v.destroy()); viewers = []; preview.value = null; ready.value = false; busy.value = false; confirming.value = false }
function cancel() { clear(); selected.value = null; message.value = '换图预览已取消，草稿未改变' }
function select(item: DrawingCandidate) { clear(); selected.value = clone(item); message.value = '' }
function capture(): RequestScope {
  const scope = props.session.capture(), current = epoch, point = clone(props.session.state.savedPoint), choice = clone(selected.value)
  return { signal: controller.signal, accepts: () => current === epoch && scope.accepts() && equal(point, props.session.state.savedPoint) && equal(choice, selected.value) }
}
async function search() {
  clear(); selected.value = null; candidates.value = []; const scope = capture(); busy.value = true
  try {
    const owner = await props.session.fresh(scope), result = await props.session.client.drawingCandidates(query.value.trim(), scope)
    need(scope.accepts() && equal(await props.session.fresh(scope), owner)); need(scope.accepts()); candidates.value = result; message.value = ''
  } catch (error) { if (scope.accepts()) message.value = error instanceof Error ? error.message : '候选读取未确认' }
  finally { if (scope.accepts()) busy.value = false }
}
async function prepare() {
  need(selected.value); clear(); const scope = capture(), choice = clone(selected.value); busy.value = true
  try {
    const result = await props.session.prepareDrawing({ item_id: choice.item_id, version_id: choice.version_id, file_id: choice.file_id, file_role: choice.file_role, expected_checksum: choice.checksum.toLowerCase() }, scope)
    need(scope.accepts()); preview.value = result
    for (const side of ['before', 'after'] as const) {
      const ticket = await props.session.client.cadTicket({ purpose: 'preparation', plan_id: result.point.plan_id, version_id: result.point.item_version_id, context_id: result.preparation.context_id, side }, scope)
      need(scope.accepts()); const value = result.preparation.source_change[side]
      const viewer = loadReadOnlyCad(side === 'before' ? beforeFrame.value! : afterFrame.value!, ticket.asset_url, { ...value.document, payload: value.payload }, scope.accepts)
      viewers.push(viewer); await viewer.loaded; need(scope.accepts())
    }
    need(equal(await props.session.fresh(scope), result.owner) && scope.accepts()); ready.value = true; message.value = '两侧只读预览已就绪，尚未换图'
  } catch (error) { if (scope.accepts()) { clear(); message.value = error instanceof Error ? error.message : '换图预览未确认' } }
  finally { if (scope.accepts()) busy.value = false }
}
async function confirm() {
  need(ready.value && preview.value); const scope = capture(), original = clone(preview.value); busy.value = true; confirming.value = true
  try {
    await props.session.confirmDrawing(original, scope)
    if (scope.accepts()) { clear(); message.value = props.session.state.message }
  } catch (error) { if (scope.accepts()) { clear(); message.value = error instanceof Error ? error.message : '换图保存未确认，原请求保留' } }
  finally { if (scope.accepts()) { busy.value = false; confirming.value = false } }
}
async function adopt() {
  clear(); try { await props.session.adoptSavedDrawing() } catch (error) { message.value = error instanceof Error ? error.message : '采用已保存底图未确认' }
}
watch(query, () => { clear(); selected.value = null; candidates.value = [] }, { flush: 'sync' })
watch(() => JSON.stringify([props.session.state.owner, props.session.state.planId, props.session.state.versionId, props.session.state.recoveryId,
  props.session.state.editSeq, props.session.state.draftSeq, props.session.state.contentHash]), () => { clear(); selected.value = null; candidates.value = [] }, { flush: 'sync' })
onScopeDispose(clear)
</script>
<style scoped>
iframe { width: 100%; height: 360px; border: 1px solid #c4d0df; } button { margin: 5px; } pre { white-space: pre-wrap; }
</style>

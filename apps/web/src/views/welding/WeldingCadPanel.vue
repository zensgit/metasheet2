<template>
  <section>
    <h3>VemCAD 工艺图</h3>
    <div class="actions">
      <button :disabled="!session.canEdit.value || !session.state.versionId || cad.state.busy" @click="act(() => cad.open(frame!))">打开固定图纸</button>
      <button :disabled="!cad.state.ready || !!cad.state.intent" @click="cad.close()">关闭图纸</button>
      <button :disabled="!cad.state.ready || !!cad.state.intent" @click="act(cad.revoke)">撤销编辑上下文</button>
      <button :disabled="!session.canHistory.value || !session.state.historyCursor" @click="act(() => cad.history('undo'))">撤销</button>
      <button :disabled="!session.canHistory.value || session.state.historyCursor === session.state.historyLength" @click="act(() => cad.history('redo'))">重做</button>
      <button :disabled="cad.state.intent !== 'draw'" @click="act(cad.cancel)">明确取消绘制</button>
    </div>
    <iframe ref="frame" title="VemCAD 焊接叠层编辑" :inert="cad.state.arming || cad.state.busy || session.state.busy || session.state.atomicBusy" v-show="cad.state.ready || cad.state.busy" />
    <p>{{ cad.state.message }}</p>
    <fieldset :disabled="!cad.canAct.value">
      <label>焊缝<select :value="cad.state.selectedWeld" @change="act(() => cad.select(value($event)))"><option value="">选择焊缝</option><option v-for="w in session.state.payload.welds" :key="w.weld_id" :value="w.weld_id">{{ w.display_no }}</option></select></label>
      <label>新图形视图名称<input v-model="viewName"></label>
      <button v-for="tool in tools" :key="tool.key" @click="act(() => cad.draw(tool.key, viewName))">绘制{{ tool.label }}焊缝</button>
      <button @click="act(() => cad.bind())">将所选几何绑定焊缝</button><button @click="act(() => cad.bind(true))">解除旧格式几何绑定</button>
      <label>复制新编号<input v-model="copyNo"></label><label>偏移 X<input v-model.number="dx" type="number"></label><label>偏移 Y<input v-model.number="dy" type="number"></label>
      <label><input v-model="copyParams" type="checkbox">复制参数</label><label><input v-model="copyRefs" type="checkbox" :disabled="!copyParams">复制固定引用</label>
      <p>副本将参与统计，人工实测长度留空。{{ copyParams ? '复制参数时保留分组、分类和制造要求长度。' : '当前不复制分组、分类和制造要求长度。' }}</p>
      <button @click="act(() => cad.copy(copyNo, copyParams, copyRefs, { x: dx, y: dy }))">完整复制焊缝</button>
      <label>标注/表示<select v-model="cad.state.representationId"><option value="">选择表示</option><option v-for="r in representations" :key="r.representation_id" :value="r.representation_id">{{ r.view_name }}{{ r.representation_id === binding?.primary_representation_id ? '（主）' : '' }}</option></select></label>
      <button @click="act(() => cad.annotate('label'))">生成编号</button><button @click="act(() => cad.annotate('leader'))">生成或更新引线</button><button @click="act(() => cad.annotate('removeLeader'))">移除引线</button>
      <div v-if="overlay && overlay.schema !== 'vemcad-weld-overlay/3'">
        <p>升级复核预览：以下在保存点或当前草稿中绑定的焊缝，保存升级后均需重新复核；前后均未绑定的焊缝保持不变。</p>
        <ul aria-label="升级需复核焊缝"><li v-for="w in upgradeReviews" :key="w.weld_id">{{ w.display_no }} · {{ w.weld_id }}</li></ul>
        <p>首次保存确认后，之前的撤销历史将清除；确认前可撤销本地升级，原保存请求仍须核对。</p>
        <label v-for="b in overlay.bindings" :key="b.weld_id">焊缝 {{ b.weld_id }} 的人工视图名称<input v-model="upgradeNames[b.weld_id]"></label>
        <button @click="act(upgrade)">明确升级为多表示</button>
      </div>
      <div v-if="overlay?.schema === 'vemcad-weld-overlay/3'">
        <label>新增表示目标焊缝<select v-model="representationTarget"><option value="">选择目标焊缝</option><option v-for="w in session.state.payload.welds" :key="w.weld_id" :value="w.weld_id">{{ w.display_no }}</option></select></label>
        <label>表示名称<input v-model="representationName"></label>
        <button :disabled="!canAddRepresentation" @click="act(() => represent('add'))">所选几何新增表示</button><button @click="act(() => represent('copy'))">复制当前表示</button><button @click="act(() => represent('rename'))">重命名表示</button><button @click="act(() => represent('primary'))">设为主表示</button>
        <label>删除后的主表示<select v-model="replacement"><option value="">无替换</option><option v-for="r in representations.filter(r => r.representation_id !== cad.state.representationId)" :key="r.representation_id" :value="r.representation_id">{{ r.view_name }}</option></select></label><button @click="act(() => represent('remove'))">删除当前表示</button>
      </div>
    </fieldset>
    <details><summary>批量编号预览</summary><label v-for="w in session.state.payload.welds" :key="w.weld_id">{{ w.display_no }} → <input v-model="numbers[w.weld_id]" :disabled="!session.canEdit.value"></label><button :disabled="!session.canEdit.value" @click="act(renumber)">确认编号变更</button></details>
    <table v-if="currentMeasurement"><thead><tr><th>焊缝</th><th>主表示几何长度 mm</th></tr></thead><tbody><tr v-for="r in currentMeasurement.rows" :key="r.weld_id"><td>{{ r.weld_id }}</td><td>{{ r.status === 'measured' ? r.length_mm : r.reason }}</td></tr></tbody></table>
    <WeldingStatistics :payload="session.state.payload" :measurement="currentMeasurement" :saved-point="currentSavedPoint" />
    <WeldingBatchFields :session="session" :barrier="cad.barrier" />
    <WeldingSourceChangePanel :session="session" />
    <label>删除焊缝目标<select v-model="deleteWeldTarget" :disabled="!session.canEdit.value || cad.state.busy"><option value="">明确选择焊缝</option><option v-for="weld in session.state.payload.welds" :key="weld.weld_id" :value="weld.weld_id">{{ weld.display_no }}</option></select></label>
    <p>删除将移除此焊缝的参数、关联图形和固定引用；保存后仍需确认删除复核。</p>
    <button :disabled="!deleteWeldTarget || !session.canEdit.value || cad.state.busy || !!cad.state.intent" @click="act(() => cad.removeWeld(deleteWeldTarget))">删除此焊缝及关联图形和引用</button>
    <h3>来源复核义务与固定历史</h3>
    <button :disabled="!session.state.versionId || busy" @click="act(() => readReviews(0))">读取复核义务</button>
    <template v-if="reviews">
      <p>待复核 {{ reviews.summary.pending_count }}；已删除待处理 {{ reviews.summary.removed_pending_count }}。处置是否符合保存内容由 Yuantus 裁定；无绑定确认不替代绑定门槛。</p>
      <pre>{{ reviews.items }}</pre>
      <fieldset :disabled="!reviewEditable">
        <label>复核焊缝<select v-model="reviewWeld"><option value="">明确选择待复核焊缝</option><option v-for="row in reviews.items.filter(row => row.state === 'pending')" :key="row.weld_id" :value="row.weld_id">{{ row.present ? '当前焊缝' : '已删除焊缝' }} {{ row.weld_id }}</option></select></label>
        <template v-if="selectedReview">
          <p>{{ selectedReview.present ? '当前焊缝' : '已删除焊缝' }} {{ selectedReview.weld_id }} · 原因 {{ selectedReview.reason_codes.join('、') }}</p>
          <p>绑定摘要 {{ selectedReview.expected_review_digest }}</p>
          <h4>变更前视图</h4><pre>{{ selectedReview.baseline_view }}</pre><h4>当前视图</h4><pre>{{ selectedReview.view }}</pre>
        </template>
        <label>人工处置<select v-model="reviewDisposition"><option value="">明确选择处置</option><option value="retain">保留未改变的绑定</option><option value="adjusted">确认已调整绑定</option><option value="no_binding">确认当前无绑定</option><option value="remove_weld">确认已删除焊缝</option><option value="cancel_association">确认已取消装配关联</option></select></label>
        <label>复核解释<textarea v-model="reviewNote" maxlength="8000" /></label>
      </fieldset>
      <button :disabled="!canConfirmReview" @click="act(confirmReview)">确认此焊缝复核并保存</button>
      <button :disabled="busy || !reviewOffset" @click="act(() => readReviews(reviewOffset - 50))">上一页义务</button><button :disabled="busy || reviewOffset + 50 >= reviews.total" @click="act(() => readReviews(reviewOffset + 50))">下一页义务</button>
    </template>
    <button :disabled="!session.state.versionId || busy" @click="act(() => readChanges(0))">读取来源历史</button>
    <template v-if="changes"><button v-for="item in changes.items" :key="item.change_id" :disabled="busy" @click="act(() => readChange(item.change_id))">保存序号 {{ item.draft_seq }} · {{ item.change_id }}</button><button :disabled="busy || !changeOffset" @click="act(() => readChanges(changeOffset - 50))">上一页历史</button><button :disabled="busy || changeOffset + 50 >= changes.total" @click="act(() => readChanges(changeOffset + 50))">下一页历史</button></template>
    <div v-if="detail"><h4>固定变更详情</h4><pre>{{ detail.events }}</pre><div v-for="side in sides" :key="side"><h4>{{ side === 'before' ? '变更前' : '变更后' }}</h4><pre>{{ detail[side].payload }}</pre></div></div>
    <div :hidden="!historyReady"><iframe ref="beforeFrame" title="变更前固定图纸" /><iframe ref="afterFrame" title="变更后固定图纸" /></div>
    <p role="alert">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { clone, equal, need, validateReviewResolution, type WeldingOwner } from '../../services/welding/planRecovery'
import type { SourceReview } from '../../services/welding/planClient'
import { loadReadOnlyCad, type CadWire } from '../../services/welding/cadBridge'
import { useWeldingCadSession } from './useWeldingCadSession'
import WeldingStatistics from './WeldingStatistics.vue'
import WeldingBatchFields from './WeldingBatchFields.vue'
import WeldingSourceChangePanel from './WeldingSourceChangePanel.vue'
import type { useWeldingPlanSession } from './useWeldingPlanSession'
const props = defineProps<{ session: ReturnType<typeof useWeldingPlanSession> }>(), cad = useWeldingCadSession(props.session)
const frame = ref<HTMLIFrameElement>(), beforeFrame = ref<HTMLIFrameElement>(), afterFrame = ref<HTMLIFrameElement>()
const viewName = ref(''), copyNo = ref(''), dx = ref(10), dy = ref(10), copyParams = ref(true), copyRefs = ref(false), representationName = ref(''), replacement = ref(''), deleteWeldTarget = ref(''), message = ref(''), busy = ref(false), historyReady = ref(false)
const upgradeNames = reactive<Record<string, string>>({}), numbers = reactive<Record<string, string>>({})
const tools = [{ key: 'line', label: '直线' }, { key: 'arc', label: '圆弧' }, { key: 'polyline', label: '多段线' }] as const, sides = ['before', 'after'] as const
const overlay = computed(() => props.session.state.payload.overlay as CadWire | undefined), binding = computed(() => overlay.value?.bindings?.find((b: CadWire) => b.weld_id === cad.state.selectedWeld)), representations = computed<CadWire[]>(() => binding.value?.representations ?? [])
const upgradeReviews = computed(() => {
  const point = props.session.upgradeReviewBasis(), before = point?.overlay as CadWire | undefined
  const ids = new Set<string>([...(before?.bindings ?? []), ...(overlay.value?.bindings ?? [])].map((b: CadWire) => b.weld_id))
  return [...ids].map(weld_id => ({ weld_id, display_no: props.session.state.payload.welds.find(w => w.weld_id === weld_id)?.display_no
    ?? point?.welds.find(w => w.weld_id === weld_id)?.display_no ?? weld_id }))
})
const representationTarget = ref('')
const canAddRepresentation = computed(() => cad.canAct.value && cad.state.selectedEntities.length > 0 && props.session.state.payload.welds.some(w => w.weld_id === representationTarget.value))
watch(() => JSON.stringify([props.session.state.owner, props.session.state.planId, props.session.state.versionId, props.session.state.recoveryId]), () => { representationTarget.value = '' }, { flush: 'sync' })
watch(() => props.session.state.payload.welds.map(w => w.weld_id), ids => { if (!ids.includes(representationTarget.value)) representationTarget.value = '' }, { flush: 'sync' })
watch(() => props.session.state.payload.welds.map(w => w.weld_id), ids => { if (!ids.includes(deleteWeldTarget.value)) deleteWeldTarget.value = '' }, { flush: 'sync' })
const currentMeasurement = computed(() => cad.state.measurement && equal(cad.state.measurement.overlay, overlay.value) ? cad.state.measurement : null)
const currentSavedPoint = computed(() => {
  const s = props.session.state, point = s.savedPoint
  return point && point.plan_id === s.planId && point.item_version_id === s.versionId && point.draft_seq === s.draftSeq && point.content_hash === s.contentHash ? point : null
})
const reviews = ref<SourceReview | null>(null), changes = ref<CadWire | null>(null), detail = ref<CadWire | null>(null), reviewOffset = ref(0), changeOffset = ref(0)
const reviewOwner = ref<WeldingOwner | null>(null), reviewWeld = ref(''), reviewDisposition = ref(''), reviewNote = ref('')
const selectedReview = computed(() => reviews.value?.items.find(row => row.weld_id === reviewWeld.value && row.state === 'pending'))
const reviewEditable = computed(() => Boolean(reviews.value?.can_write && !busy.value && props.session.canEdit.value && !props.session.state.dirty
  && !props.session.state.storageBlocked && !props.session.state.uncertain && !props.session.state.pending && equal(reviewOwner.value, props.session.state.owner)
  && reviews.value.draft_seq === props.session.state.draftSeq && reviews.value.content_hash === props.session.state.contentHash))
function reviewResolution() { need(selectedReview.value); return validateReviewResolution({ weld_id: selectedReview.value.weld_id, expected_review_digest: selectedReview.value.expected_review_digest, disposition: reviewDisposition.value, note: reviewNote.value }) }
const canConfirmReview = computed(() => { if (!reviewEditable.value) return false; try { reviewResolution(); return true } catch { return false } })
function clearReviews() { reviews.value = null; reviewOwner.value = null; reviewWeld.value = ''; reviewDisposition.value = ''; reviewNote.value = '' }
async function confirmReview() { need(canConfirmReview.value && reviews.value && reviewOwner.value); await props.session.confirmSourceReview(clone(reviews.value), reviewResolution(), clone(reviewOwner.value)) }
let historyEpoch = 0, viewers: Array<ReturnType<typeof loadReadOnlyCad>> = []
const value = (e: Event) => (e.target as HTMLInputElement).value
async function act(action: () => Promise<unknown>) { try { await action(); message.value = '' } catch (e) { message.value = e instanceof Error ? e.message : '操作未确认' } }
async function upgrade() { await cad.representation({ mode: 'upgrade', names: overlay.value!.bindings.map((b: CadWire) => ({ weld_id: b.weld_id, representation_id: crypto.randomUUID(), view_name: upgradeNames[b.weld_id] ?? '' })) }) }
async function represent(mode: string) { if (mode === 'add') need(canAddRepresentation.value, '请选择目标焊缝及未绑定几何'); const common = { mode, weld_id: mode === 'add' ? representationTarget.value : cad.state.selectedWeld, representation_id: cad.state.representationId }; await cad.representation(mode === 'add' ? { ...common, representation_id: crypto.randomUUID(), view_name: representationName.value, entity_ids: clone(cad.state.selectedEntities) } : mode === 'copy' ? { ...common, representation_id: crypto.randomUUID(), source_representation_id: cad.state.representationId, view_name: representationName.value, delta: { x: dx.value, y: dy.value } } : mode === 'rename' ? { ...common, view_name: representationName.value } : mode === 'remove' ? { ...common, replacement_primary_id: replacement.value || null } : common) }
async function renumber() { await cad.renumber(props.session.state.payload.welds.filter(w => numbers[w.weld_id] !== undefined && numbers[w.weld_id] !== w.display_no).map(w => ({ weld_id: w.weld_id, old_no: w.display_no, new_no: numbers[w.weld_id] }))) }
function clearHistory() { historyEpoch++; viewers.forEach(v => v.destroy()); viewers = []; historyReady.value = false; detail.value = null }
async function readReviews(offset: number) { const s = props.session, scope = s.capture(); need(s.state.versionId && !s.state.dirty && !s.state.pending, '请先保存编辑或核对原请求'); clearReviews(); const epoch = historyEpoch; busy.value = true; try { const owner = await s.fresh(scope), result = await s.client.sourceReview(s.state.planId, s.state.versionId!, offset, scope); s.check(scope); need(equal(await s.fresh(scope), owner)); s.check(scope); need(epoch === historyEpoch && result.draft_seq === s.state.draftSeq && result.content_hash === s.state.contentHash); reviews.value = result; reviewOwner.value = clone(owner); reviewOffset.value = offset } finally { busy.value = false } }
async function readChanges(offset: number) { const s = props.session, scope = s.capture(); need(s.state.versionId); clearHistory(); const epoch = historyEpoch; busy.value = true; try { const owner = await s.fresh(scope), result = await s.client.sourceChanges(s.state.planId, s.state.versionId!, offset, scope); s.check(scope); need(equal(await s.fresh(scope), owner)); s.check(scope); need(epoch === historyEpoch); changes.value = result; changeOffset.value = offset } finally { busy.value = false } }
async function readChange(change: string) {
  const s = props.session, scope = s.capture(); need(s.state.versionId && changes.value?.items.some((r: CadWire) => r.change_id === change)); clearHistory(); const epoch = historyEpoch; busy.value = true
  try {
    const owner = await s.fresh(scope), result = await s.client.sourceChange(s.state.planId, s.state.versionId!, change, scope) as CadWire; s.check(scope); need(epoch === historyEpoch)
    if (result.kind === 'drawing') for (const side of sides) {
      const doc = await s.client.sourceDocument(s.state.planId, s.state.versionId!, change, side, scope) as CadWire; s.check(scope); need(equal(doc.payload, result[side].payload) && epoch === historyEpoch)
      const ticket = await s.client.cadTicket({ purpose: 'history', plan_id: s.state.planId, version_id: s.state.versionId!, change_id: change, side }, scope); s.check(scope); need(epoch === historyEpoch)
      const viewer = loadReadOnlyCad(side === 'before' ? beforeFrame.value! : afterFrame.value!, ticket.asset_url, doc, () => scope.accepts() && epoch === historyEpoch); viewers.push(viewer); await viewer.loaded; s.check(scope); need(epoch === historyEpoch)
    }
    need(equal(await s.fresh(scope), owner)); s.check(scope); need(epoch === historyEpoch); detail.value = result; historyReady.value = result.kind === 'drawing'
  } catch (error) { if (epoch === historyEpoch) clearHistory(); throw error } finally { busy.value = false }
}
watch(() => JSON.stringify([props.session.state.owner, props.session.state.planId, props.session.state.versionId, props.session.state.editSeq, props.session.state.draftSeq, props.session.state.contentHash]), () => { clearHistory(); clearReviews(); changes.value = null }, { flush: 'sync' })
watch(reviewWeld, () => { reviewDisposition.value = ''; reviewNote.value = '' })
watch(copyParams, value => { if (!value) copyRefs.value = false })
onScopeDispose(clearHistory)
</script>
<style scoped>
iframe { width: 100%; height: 480px; border: 1px solid #c4d0df; } label { display: inline-flex; flex-direction: column; margin: 6px; } button { margin: 5px; } pre { white-space: pre-wrap; max-height: 300px; overflow: auto; } td, th { padding: 8px; }
</style>

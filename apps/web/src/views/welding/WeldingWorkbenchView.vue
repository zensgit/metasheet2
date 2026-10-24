<template>
  <main class="welding-workbench">
    <header>
      <div><p class="eyebrow">PLM · 焊接工艺</p><h1>焊接工作台</h1></div>
      <router-link to="/plm">返回 PLM</router-link>
    </header>
    <p v-if="!available" role="status">当前焊接读取未开启，请联系管理员。</p>
    <template v-else>
      <p class="scope-note">计划草稿、CAD、完整参数、固定资料与来源历史为当前编制范围。评审、批准文件与正式发布可按服务授权操作；修订、正式目录、历史版本比较与独立复用可按授权使用；单条资料登记与修订可明确请求，完整资料维护仍继续开发；保持 HOLD，尚未业务签收。</p>
      <p v-if="!writable">当前仅可读取；新的保存未开启。</p>
      <p role="status" aria-live="polite">{{ state.message }}</p>
      <WeldingWorkflowPanel :workflow="workflow" :generation="generation.state.current" />
      <WeldingResourceMaintenancePanel :resources="resources" :imports="imports" />
      <div class="workbench-columns">
        <aside>
          <section>
            <h2>工艺计划</h2>
            <div class="actions">
              <button :disabled="state.busy" @click="session.initialize()">重新读取</button>
              <button :disabled="state.busy || !writable || !state.owner" @click="session.newDraft()">新建草稿</button>
            </div>
            <p>共 {{ state.total }} 条</p>
            <ul class="plans">
              <li v-for="plan in state.plans" :key="`${plan.plan_id}:${plan.item_version_id}`">
                <button :disabled="state.busy" @click="session.open(plan.plan_id, plan.item_version_id)">
                  {{ plan.number }} · {{ plan.name }}<small>{{ plan.version_label }} · {{ plan.state }}</small>
                </button>
              </li>
            </ul>
            <div class="actions">
              <button :disabled="state.busy || state.offset === 0" @click="session.refreshList(Math.max(0, state.offset - 50))">上一页</button>
              <button :disabled="state.busy || state.offset + 50 >= state.total" @click="session.refreshList(state.offset + 50)">下一页</button>
            </div>
          </section>
          <section>
            <h2>个人恢复点</h2>
            <button :disabled="state.busy" @click="session.refreshRecoveries()">读取当前个人恢复点</button>
            <ul class="plans">
              <li v-for="point in state.recoveries" :key="point.recovery_id">
                <span>{{ point.draft.number || '未编号' }} · {{ point.draft.name || '未命名' }}</span>
                <small>{{ new Date(point.updated_at).toLocaleString() }}{{ point.pending ? ' · 原请求待确认' : '' }}</small>
                <div class="actions">
                  <button :disabled="state.busy" @click="session.previewRecovery(point)">预览恢复依据</button>
                  <button v-if="point.pending" :disabled="state.busy" @click="session.confirmRecoveryOriginal(point)">核对并重发同原保存</button>
                </div>
              </li>
            </ul>
            <div v-if="state.preview" class="recovery-preview">
              <p>本地 {{ state.preview.record.draft.plan_id }} · 基础序号 {{ state.preview.record.draft.base_draft_seq }}</p>
              <p>服务器序号 {{ state.preview.authority.current?.draft_seq ?? '尚未创建' }}</p>
              <p>{{ state.preview.authority.conflict ? '存在冲突，仅恢复查看' : state.preview.authority.can_write ? '当前可编制，恢复后仍需明确保存' : '当前只能恢复查看' }}</p>
              <button :disabled="state.busy" @click="session.restoreRecovery()">明确恢复到本页</button>
            </div>
          </section>
        </aside>
        <section v-if="state.planId" class="editor">
          <h2>{{ state.versionId ? '固定版本' : '本地新草稿' }}</h2>
          <p class="identity">{{ state.planId }} · {{ state.versionId || '尚未创建版本' }} · {{ state.serverState }}</p>
          <p>服务器保存序号 {{ state.draftSeq }} · 本地编辑序号 {{ state.editSeq }}{{ state.dirty ? ' · 尚未保存' : '' }}</p>
          <p class="hash">服务器内容摘要：{{ state.contentHash || '尚无' }}</p>
          <label>名称<input :value="state.name" :readonly="Boolean(state.versionId)" :disabled="!session.canEdit.value" @input="session.editIdentity('name', inputValue($event))"></label>
          <label>编号<input :value="state.number" :readonly="Boolean(state.versionId)" :disabled="!session.canEdit.value" @input="session.editIdentity('number', inputValue($event))"></label>
          <div v-if="!state.versionId" class="source-pickers">
            <label>产品检索<input v-model="productQuery" :disabled="state.busy" @keydown.enter.prevent="session.searchProducts(productQuery)"></label>
            <button :disabled="state.busy || !productQuery" @click="session.searchProducts(productQuery)">查找产品版本</button>
            <ul><li v-for="product in state.products" :key="`${product.item_id}:${product.version_id}`">
              <button :disabled="!session.canEdit.value" @click="session.selectProduct(product)">{{ product.number }} · {{ product.name }} · {{ product.version_label || product.version_id }}</button>
            </li></ul>
            <label>图纸检索<input v-model="drawingQuery" :disabled="state.busy" @keydown.enter.prevent="session.searchDrawings(drawingQuery)"></label>
            <button :disabled="state.busy || !drawingQuery" @click="session.searchDrawings(drawingQuery)">查找固定图纸</button>
            <ul><li v-for="drawing in state.drawings" :key="`${drawing.item_id}:${drawing.version_id}:${drawing.file_id}:${drawing.file_role}`">
              <button :disabled="!session.canEdit.value" @click="session.selectDrawing(drawing)">{{ drawing.number }} · {{ drawing.version_label || drawing.version_id }} · {{ drawing.file_role }} · {{ drawing.file_id }}</button>
            </li></ul>
          </div>
          <p>产品：{{ state.payload.product?.item_id || '未选择' }} · {{ state.payload.product?.version_id || '' }}</p>
          <p>图纸：{{ state.payload.drawing?.item_id || '未选择' }} · {{ state.payload.drawing?.version_id || '' }} · {{ state.payload.drawing?.file_id || '' }}</p>
          <p v-if="state.blocked">本地副本只读或保存基础已冲突。请明确打开服务器版本核对。</p>
          <button :disabled="!session.canEdit.value" @click="addWeld()">新增焊缝</button>
          <WeldingParameterFields :payload="state.payload" :disabled="!session.canEdit.value" @change="replacePayload" />
          <WeldingResourceFields :session="session" />
          <WeldingAssemblyPanel :session="session" />
          <WeldingCadPanel :session="session" />
          <WeldingGenerationPanel :generation="generation" />
          <div class="actions">
            <button :disabled="!session.canEdit.value || !state.dirty" @click="session.save()">保存草稿</button>
            <button :disabled="!session.canSaveMeasurement.value" @click="session.save(true)">保存并核验几何测量</button>
            <button v-if="state.pending" :disabled="state.busy" @click="session.confirmOriginal()">核对并重发同原保存</button>
          </div>
          <p>首次核验前请保存草稿并打开固定图纸；普通保存不会首次启用几何测量，已启用后几何变化会在保存时重新核验。</p>
          <p v-if="state.pending">原保存标识 {{ state.pending.body.save_id }}。确认前保留原请求，不自动创建新保存。</p>
          <button v-if="state.storageBlocked" :disabled="state.busy || !!state.pending || state.cadBusy || state.atomicBusy" @click="session.retryLocal()">重试本地恢复存储</button>
          <p v-if="state.storageBlocked">本地恢复尚未持久化，保存未发送；编辑仍在内存。</p>
        </section>
        <section v-else class="editor"><h2>选择计划或新建草稿</h2><p>固定产品、图纸和工艺版本由 Yuantus 授权提供。</p></section>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { useFeatureFlags } from '../../stores/featureFlags'
import { parseWeldingEntry } from '../../services/welding/planClient'
import WeldingParameterFields from './WeldingParameterFields.vue'
import WeldingResourceFields from './WeldingResourceFields.vue'
import WeldingResourceMaintenancePanel from './WeldingResourceMaintenancePanel.vue'
import { useWeldingResourceSession } from './useWeldingResourceSession'
import { useWeldingResourceImportSession } from './useWeldingResourceImportSession'
import WeldingAssemblyPanel from './WeldingAssemblyPanel.vue'
import WeldingCadPanel from './WeldingCadPanel.vue'
import WeldingGenerationPanel from './WeldingGenerationPanel.vue'
import WeldingWorkflowPanel from './WeldingWorkflowPanel.vue'
import { useWeldingWorkflowSession } from './useWeldingWorkflowSession'
import { useWeldingGenerationSession } from './useWeldingGenerationSession'
import type { PlanPayload } from '../../services/welding/planRecovery'
import { useWeldingPlanSession } from './useWeldingPlanSession'

const route = useRoute(), flags = useFeatureFlags()
const available = computed(() => flags.hasFeature('plm') && flags.hasFeature('weldingRead'))
const writable = computed(() => available.value && flags.hasFeature('weldingWrite'))
const resources = useWeldingResourceSession({ active: () => available.value, writable: () => writable.value })
const imports = useWeldingResourceImportSession({ active: () => available.value, writable: () => writable.value })
const session = useWeldingPlanSession({ writable: () => writable.value }), state = session.state
const generation = useWeldingGenerationSession({ session, active: () => available.value, writable: () => writable.value })
const workflow = useWeldingWorkflowSession({ session, active: () => available.value, writable: () => writable.value })
let entrySerial = 0
const productQuery = ref(''), drawingQuery = ref('')
const inputValue = (event: Event) => (event.target as HTMLInputElement).value
async function replacePayload(payload: PlanPayload) { try { await session.edit(next => { Object.assign(next, payload) }) } catch (error) { state.message = error instanceof Error ? error.message : '参数未确认' } }
async function addWeld() {
  await session.edit(payload => { payload.welds.push({ weld_id: crypto.randomUUID(), display_no: String(payload.welds.length + 1), passes: [] }) })
}
async function enter() {
  if (!available.value) return
  const serial = ++entrySerial, path = route.fullPath
  try {
    const search = route.fullPath.includes('?') ? route.fullPath.slice(route.fullPath.indexOf('?')).split('#')[0] : ''
    const entry = parseWeldingEntry(search)
    if (entry && 'plan_id' in entry) { void workflow.setFormalTarget(entry.plan_id, entry.version_id); void workflow.setTarget(entry.plan_id, entry.version_id) }
    else { void workflow.setFormalTarget('', ''); void workflow.setTarget('', '') }
    await session.initialize()
    if (serial !== entrySerial || path !== route.fullPath || !available.value) return
    if (entry && 'plan_id' in entry) await session.open(entry.plan_id, entry.version_id)
    else if (entry) { await session.newDraft(); await session.selectProduct({ item_id: entry.product_id, version_id: entry.product_version_id, name: '', number: '', version_label: null }) }
  } catch (error) { state.message = error instanceof Error ? error.message : '入口参数无法确认' }
}
onBeforeRouteLeave(async () => imports.prepareLeave() && resources.prepareLeave() && await session.prepareLeave())
onBeforeRouteUpdate(async () => {
  if (!imports.prepareLeave() || !resources.prepareLeave() || !await session.prepareLeave()) return false
  entrySerial++; imports.resetEntry(); session.resetEntry()
  return true
})
onMounted(enter)
watch(() => route.fullPath, enter)
</script>

<style scoped>
.welding-workbench { max-width: 1440px; margin: 0 auto; padding: 24px; color: #233247; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 { margin: 0 0 16px; } h2 { font-size: 18px; } .eyebrow { color: #60748d; margin: 0 0 6px; }
.scope-note { padding: 12px 16px; background: #f0f5fb; border-left: 3px solid #5278a3; }
.workbench-columns { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 24px; }
section { border: 1px solid #d9e2ec; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
label { display: inline-flex; flex-direction: column; gap: 5px; margin: 6px 12px 6px 0; }
input, select, button { font: inherit; padding: 7px 10px; border: 1px solid #c4d0df; border-radius: 4px; }
button { cursor: pointer; background: white; } button:disabled { cursor: default; opacity: .55; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.plans { list-style: none; padding: 0; } .plans li { margin: 10px 0; } .plans button { text-align: left; }
small { display: block; color: #65788e; } .identity, .hash { font-size: 13px; overflow-wrap: anywhere; }
.weld-card { border-top: 1px solid #d9e2ec; margin-top: 16px; padding-top: 8px; }
fieldset { border: 1px solid #d9e2ec; border-radius: 6px; } .quantity { display: inline-flex; align-items: end; }
.quantity select { margin: 0 10px 6px 0; } .recovery-preview { background: #f4f7fa; padding: 10px; }
@media (max-width: 800px) { .workbench-columns { grid-template-columns: minmax(0, 1fr); } .welding-workbench { padding: 12px; } }
</style>

<template>
  <section v-if="state.planId && state.versionId" aria-label="评审工作台">
    <h2>评审工作台</h2>
    <p role="status" aria-live="polite">{{ state.message }}</p>
    <button :disabled="state.working" @click="workflow.refresh()">读取评审状态与历史</button>
    <template v-if="state.current">
      <p>评审状态：{{ state.current.state }}{{ state.current.is_current ? '' : ' · 历史版本' }}</p>
      <p v-if="state.current.approval">申请人：{{ state.current.approval.submission.requester.display_name }} · 指定评审人：{{ state.current.approval.submission.reviewer.display_name }}</p>
      <p v-if="state.current.approval?.decision">评审意见：{{ state.current.approval.decision.decision.opinion || '无附加意见' }}</p>
      <p v-if="state.current.issues.length">当前检查：{{ state.current.issues.map(issueName).join('、') }}</p>
      <button :disabled="state.working" @click="workflow.validate()">检查当前保存点</button>
      <p v-if="state.validation">{{ state.validation.ready ? '检查通过' : '尚不可提交' }}{{ state.validation.issues.length ? ' · ' + state.validation.issues.map(issueName).join('、') : '' }}</p>
      <div v-if="state.current.allowed_actions.includes('submit')">
        <p>提交前请保存正文，并在生成工作台选择已完成的评审生成物。</p>
        <label>指定评审人 RBAC ID<input v-model="reviewer" inputmode="numeric" :disabled="state.working" /></label>
        <p>{{ generation?.status === 'Ready' ? '已选择完成的评审生成物' : '尚未选择完成的评审生成物' }}</p>
        <button :disabled="!workflow.canAction('submit') || !reviewerId || generation?.status !== 'Ready'" @click="workflow.command('submit', { reviewer: reviewerId, generation: generation ?? undefined })">提交评审</button>
      </div>
      <div v-if="state.current.allowed_actions.some(action => ['approve', 'reject'].includes(action))">
        <label>评审意见<textarea v-model="opinion" :disabled="state.working" maxlength="8000" /></label>
        <button v-if="state.current.allowed_actions.includes('approve')" :disabled="!workflow.canAction('approve')" @click="workflow.command('approve', { opinion })">批准</button>
        <button v-if="state.current.allowed_actions.includes('reject')" :disabled="!workflow.canAction('reject') || !opinion.trim()" @click="workflow.command('reject', { opinion })">拒绝</button>
      </div>
      <div v-if="state.current.allowed_actions.some(action => ['withdraw', 'reopen', 'revise'].includes(action))">
        <label>原因<textarea v-model="reason" :disabled="state.working" maxlength="8000" /></label>
        <button v-if="state.current.allowed_actions.includes('withdraw')" :disabled="!workflow.canAction('withdraw') || !reason.trim()" @click="workflow.command('withdraw', { reason })">撤回评审</button>
        <button v-if="state.current.allowed_actions.includes('reopen')" :disabled="!workflow.canAction('reopen') || !reason.trim()" @click="workflow.command('reopen', { reason })">重新编制</button>
        <button v-if="state.current.state === 'Released' && state.current.allowed_actions.includes('revise')" :disabled="!workflow.canAction('revise') || !reason.trim()" @click="workflow.command('revise', { reason })">创建修订</button>
      </div>
      <div v-if="state.current.state === 'Approved'">
        <p v-if="state.current.final_generation">批准文件：{{ state.current.final_generation.status }} · 第 {{ state.current.final_generation.attempt }} 次</p>
        <button v-if="state.current.final_generation" :disabled="state.polling || state.working" @click="workflow.refreshFinal()">读取批准文件状态</button>
        <button v-if="state.current.allowed_actions.includes('final-render')" :disabled="!workflow.canAction('final-render')" @click="workflow.command('final-render', {})">生成批准文件</button>
        <button v-if="state.current.allowed_actions.includes('final-retry')" :disabled="!workflow.canAction('final-retry')" @click="workflow.command('final-retry', {})">重试批准文件</button>
        <button v-if="state.current.allowed_actions.includes('release')" :disabled="!workflow.canAction('release')" @click="workflow.command('release', {})">发布</button>
      </div>
      <div v-if="state.current.publication">
        <p>正式发布：{{ state.current.publication.version_label }} · {{ state.current.publication.published_at }}</p>
        <button :disabled="!workflow.canDownloadPublication.value" @click="workflow.downloadPublication('pdf')">下载正式 PDF</button>
        <button :disabled="!workflow.canDownloadPublication.value" @click="workflow.downloadPublication('docx')">下载正式 DOCX</button>
      </div>
    </template>
    <section v-if="workflow.reuse && state.current?.state === 'Released'" aria-label="复用正式计划">
      <h3>复用到另一产品的独立草稿</h3>
      <p>仅复制明确选择的正式焊缝业务值与固定资料关联；目标需要重新绑定图纸、编制和评审。来源计划保持原样。</p>
      <p v-if="!workflow.reuseWeldIds.value.length">请先读取来源正文及匹配的正式批准依据；尚不能选择焊缝。</p>
      <label v-for="id in workflow.reuseWeldIds.value" :key="id"><input v-model="workflow.reuse.selectedWeldIds" type="checkbox" :value="id" :disabled="state.working || !!state.pending" />{{ id }}</label>
      <label>复用目标名称<input v-model="workflow.reuse.name" :disabled="state.working || !!state.pending" maxlength="256" /></label>
      <label>复用目标编号<input v-model="workflow.reuse.number" :disabled="state.working || !!state.pending" maxlength="256" /></label>
      <label>目标产品检索<input v-model="reuseProductQuery" :disabled="state.working" /></label>
      <button :disabled="state.working || !reuseProductQuery" @click="workflow.searchReuseProducts(reuseProductQuery)">查找复用目标产品</button>
      <ul><li v-for="product in workflow.reuse.products" :key="`${product.item_id}:${product.version_id}`"><button :disabled="state.working || !!state.pending" @click="workflow.selectReuseProduct(product)">{{ product.number }} · {{ product.name }} · {{ product.version_label || product.version_id }}</button></li></ul>
      <p>目标产品：{{ workflow.reuse.product?.item_id || '未选择' }} · {{ workflow.reuse.product?.version_id || '' }}</p>
      <label>目标图纸检索<input v-model="reuseDrawingQuery" :disabled="state.working" /></label>
      <button :disabled="state.working || !reuseDrawingQuery" @click="workflow.searchReuseDrawings(reuseDrawingQuery)">查找复用固定图纸</button>
      <ul><li v-for="drawing in workflow.reuse.drawings" :key="`${drawing.item_id}:${drawing.version_id}:${drawing.file_id}:${drawing.file_role}`"><button :disabled="state.working || !!state.pending" @click="workflow.selectReuseDrawing(drawing)">{{ drawing.number }} · {{ drawing.version_label || drawing.version_id }} · {{ drawing.file_role }} · {{ drawing.file_id }}</button></li></ul>
      <p>目标图纸：{{ workflow.reuse.drawing?.item_id || '未选择' }} · {{ workflow.reuse.drawing?.version_id || '' }} · {{ workflow.reuse.drawing?.file_id || '' }}</p>
      <button :disabled="!workflow.reuse.product || state.working || !!state.pending || workflow.reuse.bomWorking" @click="workflow.loadReuseBoms()">读取可选 BOM</button>
      <p role="status">{{ workflow.reuse.bomMessage }}</p>
      <p>目标 BOM：{{ workflow.reuse.bom?.baseline_id || '不采用 BOM' }}</p>
      <button :disabled="state.working || !!state.pending" @click="workflow.selectReuseBom(null)">不采用 BOM</button>
      <button v-for="bom in workflow.reuse.boms" :key="bom.baseline_id" :disabled="state.working || !!state.pending || workflow.reuse.bomWorking" @click="workflow.selectReuseBom(bom)">采用 {{ bom.number }} · {{ bom.name }}</button>
      <label>复用原因<textarea v-model="workflow.reuse.reason" :disabled="state.working || !!state.pending" maxlength="8000" /></label>
      <button :disabled="!workflow.canCreateReuse.value" @click="workflow.createReuse()">明确创建独立复用草稿</button>
    </section>
    <div v-if="state.pending?.action === 'reuse'">
      <p>来源原复用请求保留。核对结果不会自动打开或清理。</p>
      <button :disabled="!workflow.canResolve.value" @click="workflow.resolveReuse()">核对原复用请求结果</button>
      <button :disabled="!workflow.canReplay.value" @click="workflow.replayReuse()">明确重发同一原复用请求</button>
    </div>
    <div v-else-if="state.pending">
      <p>此版本有原评审请求待确认。核对结果后再继续。</p>
      <button :disabled="!workflow.canResolve.value" @click="workflow.resolve()">核对原评审请求结果</button>
      <button :disabled="!workflow.canReplay.value" @click="workflow.replay()">明确重发同一原评审请求</button>
    </div>
    <div v-if="state.revisionAck">
      <p>修订已建立：{{ state.revisionAck.target_version_label }} · {{ state.revisionAck.target_version_id }}。原修订请求保留。</p>
      <button :disabled="!workflow.canOpenRevision.value" @click="workflow.openRevisionTarget()">打开目标版本</button>
    </div>
    <div v-if="state.revisionCleanup">
      <p>目标已打开：{{ state.revisionCleanup.opened.item_version_id }}。原修订来源 {{ state.revisionCleanup.original.plan_id }} · {{ state.revisionCleanup.original.item_version_id }} 仍待核对。</p>
      <button :disabled="!workflow.canCleanupRevision.value" @click="workflow.cleanupRevision()">明确清理原修订请求</button>
    </div>
    <div v-if="state.reuseAck">
      <p>独立草稿已建立：{{ state.reuseAck.target_plan_id }} · {{ state.reuseAck.target_version_id }}。来源原请求保留。</p>
      <button :disabled="!workflow.canOpenReuse.value" @click="workflow.openReuseTarget()">打开独立目标计划</button>
    </div>
    <div v-if="state.reuseCleanup">
      <p>已打开 {{ state.reuseCleanup.opened.plan_id }} · {{ state.reuseCleanup.opened.item_version_id }}。来源 {{ state.reuseCleanup.original.plan_id }} · {{ state.reuseCleanup.original.item_version_id }} 原请求待单独清理。</p>
      <button :disabled="!workflow.canCleanupReuse.value" @click="workflow.cleanupReuse()">明确清理来源复用请求</button>
    </div>
    <section v-if="workflow.provenance && state.planId && state.versionId" aria-label="复用来源读取">
      <h3>复用来源（初始采用）</h3>
      <button :disabled="workflow.provenance.working" @click="workflow.readReuseProvenance()">读取授权复用来源</button>
      <p role="status">{{ workflow.provenance.message }}</p>
      <template v-if="workflow.provenance.current">
        <p>来源 {{ workflow.provenance.current.basis.metadata.source_plan_id }} · {{ workflow.provenance.current.basis.metadata.source_version_id }} · 正式归档 {{ workflow.provenance.current.basis.metadata.source_publication_id }} · 保存序号 {{ workflow.provenance.current.basis.source.draft_seq }}</p>
        <p>初始采用版本 {{ workflow.provenance.current.basis.metadata.target_version_id }} · {{ workflow.provenance.current.basis.metadata.actor.display_name }} · {{ workflow.provenance.current.basis.metadata.created_at }}</p>
        <p>原因：{{ workflow.provenance.current.basis.metadata.reason }}</p>
        <ul><li v-for="mapping in workflow.provenance.current.basis.mappings" :key="mapping.source_weld_id">{{ mapping.source_weld_id }} → {{ mapping.target_weld_id }}</li></ul>
      </template>
    </section>
    <section v-if="formal?.planId" aria-label="正式文件读取">
      <h3>正式目录</h3>
      <p role="status">{{ formal.message }}</p>
      <button :disabled="formal.working" @click="workflow.refreshFormal()">读取正式目录</button>
      <template v-if="formal.directory">
        <p v-if="formal.directory.current_publication">当前可见正式版：{{ formal.directory.current_publication.version_label }} · {{ formal.directory.current_publication.item_version_id }}</p>
        <p v-else>没有可见的当前正式版</p>
        <button v-if="formal.directory.current_publication" :disabled="formal.working" @click="workflow.selectFormal(formal.directory.current_publication, 'selected')">查看当前正式版</button>
        <p>可见正式记录共 {{ formal.directory.total }} 条</p>
        <ul><li v-for="entry in formal.directory.items" :key="entry.publication_id">
          {{ entry.version_label }} · {{ entry.state }} · {{ entry.published_at }}
          <button :disabled="formal.working" @click="workflow.selectFormal(entry, 'selected')">查看此正式版</button>
          <button :disabled="formal.working" @click="workflow.selectFormal(entry, 'from')">选为比较前版本</button>
          <button :disabled="formal.working" @click="workflow.selectFormal(entry, 'to')">选为比较后版本</button>
        </li></ul>
        <button :disabled="formal.working || formal.directory.offset === 0" @click="workflow.refreshFormal(Math.max(0, formal.directory.offset - 20))">上一页正式目录</button>
        <button :disabled="formal.working || formal.directory.offset + formal.directory.limit >= formal.directory.total" @click="workflow.refreshFormal(formal.directory.offset + formal.directory.limit)">下一页正式目录</button>
      </template>
      <div v-if="formal.selected">
        <p>选定正式版本：{{ formal.selected.version_label }} · {{ formal.selected.state }}</p>
        <button :disabled="formal.working || formal.downloading" @click="workflow.downloadFormal('pdf')">下载选定正式 PDF</button>
        <button :disabled="formal.working || formal.downloading" @click="workflow.downloadFormal('docx')">下载选定正式 DOCX</button>
      </div>
      <div v-if="formal.from || formal.to">
        <p>比较前：{{ formal.from?.version_label || '未选择' }} → 比较后：{{ formal.to?.version_label || '未选择' }}</p>
        <button :disabled="formal.working || !formal.from || !formal.to || formal.from.item_version_id === formal.to.item_version_id" @click="workflow.compareFormal()">比较正式版本</button>
        <template v-for="side in (['from', 'to'] as const)" :key="side">
          <template v-if="formal[side]">
            <button :disabled="formal.working || formal.downloading" @click="workflow.downloadFormal('pdf', side)">{{ side === 'from' ? '比较前' : '比较后' }} PDF</button>
            <button :disabled="formal.working || formal.downloading" @click="workflow.downloadFormal('docx', side)">{{ side === 'from' ? '比较前' : '比较后' }} DOCX</button>
          </template>
        </template>
      </div>
      <div v-if="formal.comparison">
        <p>新增 {{ formal.comparison.summary.added }} · 移除 {{ formal.comparison.summary.removed }} · 变化 {{ formal.comparison.summary.changed }} · 未变 {{ formal.comparison.summary.unchanged }}</p>
        <p>计划变化类别：{{ formal.comparison.plan_changes.map(categoryName).join('、') || '无' }}</p>
        <ul><li v-for="weld in formal.comparison.welds" :key="weld.weld_id">{{ weld.weld_id }} · {{ kindName(weld.kind) }} · {{ weld.changed_fields.map(categoryName).join('、') }}</li></ul>
        <p>比较只展示服务提供的变化类别；具体内容请读取两侧正式 PDF／DOCX。</p>
      </div>
    </section>
    <template v-if="state.history">
      <h3>冻结评审历史 · 共 {{ state.history.total }} 条</h3>
      <ul>
        <li v-for="item in state.history.items" :key="item.event_id">
          {{ actionName(item.action) }} · {{ item.actor.display_name }} · {{ item.created_at }}
          <p>{{ item.from_state || '新建' }} → {{ item.to_state }}{{ item.note ? ' · ' + item.note : '' }}</p>
          <p v-if="item.approval">申请人 {{ item.approval.submission.requester.display_name }} · 评审人 {{ item.approval.submission.reviewer.display_name }}{{ item.approval.decision ? ' · ' + item.approval.decision.decision.opinion : '' }}</p>
        </li>
      </ul>
      <button :disabled="state.working || state.history.offset === 0" @click="workflow.refresh(Math.max(0, state.history.offset - 50))">上一页评审历史</button>
      <button :disabled="state.working || state.history.offset + 50 >= state.history.total" @click="workflow.refresh(state.history.offset + 50)">下一页评审历史</button>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ReviewGeneration } from '../../services/welding/planClient'
import type { useWeldingWorkflowSession } from './useWeldingWorkflowSession'
const props = defineProps<{ workflow: ReturnType<typeof useWeldingWorkflowSession>; generation: ReviewGeneration | null }>()
const formal = props.workflow.formal
const state = props.workflow.state, reviewer = ref(''), opinion = ref(''), reason = ref('')
const reuseProductQuery = ref(''), reuseDrawingQuery = ref('')
const reviewerId = computed(() => /^\d+$/.test(reviewer.value) && Number.isSafeInteger(Number(reviewer.value)) && Number(reviewer.value) > 0 ? Number(reviewer.value) : undefined)
watch([() => state.planId, () => state.versionId, () => state.owner?.tenant_id, () => state.owner?.org_id, () => state.owner?.auth_user_id, () => state.owner?.rbac_user_id], () => { reviewer.value = ''; opinion.value = ''; reason.value = ''; reuseProductQuery.value = ''; reuseDrawingQuery.value = '' })
const categoryName = (field: string) => ({ display_no: '焊缝编号', group_name: '分组', classification: '分类', included: '是否纳入', parameters: '参数', welding_steps: '焊接步骤', geometry: '几何', process_refs: '工艺资料', resource_refs: '资源资料', order: '顺序', drawing: '图纸', product: '产品', bom: 'BOM', preparation_notes: '编制备注', overlay: '图纸标注' } as Record<string, string>)[field] ?? field
const kindName = (kind: string) => ({ added: '新增', removed: '移除', changed: '变化', unchanged: '未变' } as Record<string, string>)[kind]
const issueName = (issue: string) => ({ 'current-draft-required': '需要当前草稿', 'source-review-or-binding-incomplete': '来源复核或焊缝绑定未完成', 'submit-action-unavailable': '当前没有提交资格', 'lifecycle-setup-required': '状态流程尚未配置', 'submit-transition-unavailable': '当前不能提交评审', 'editor-inactive': '当前编制未开启', 'revision-setup-required': '修订准备尚未完成', 'final-generation-setup-required': '批准文件准备尚未完成' } as Record<string, string>)[issue] ?? '有检查尚未完成'
const actionName = (action: string) => ({ created: '创建', submit: '提交评审', approve: '批准', reject: '拒绝', withdraw: '撤回', reopen: '重新编制', release: '发布', revise: '修订' } as Record<string, string>)[action]
</script>
<style scoped>
section { border: 1px solid #d9e2ec; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
label { display: inline-flex; flex-direction: column; gap: 5px; margin: 6px 12px 6px 0; }
input, textarea, button { font: inherit; padding: 7px 10px; border: 1px solid #c4d0df; border-radius: 4px; }
button { margin: 4px; cursor: pointer; background: white; } button:disabled { cursor: default; opacity: .55; }
</style>

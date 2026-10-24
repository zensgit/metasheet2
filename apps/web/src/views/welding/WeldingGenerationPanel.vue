<template>
  <section class="generation-panel">
    <h2>指导书</h2>
    <p>评审文件对应明确保存的工艺内容；生成完成后仍需单独评审和发布。</p>
    <p role="status" aria-live="polite">{{ state.message }}</p>
    <button :disabled="state.working" @click="generation.refresh()">读取模板与任务</button>
    <fieldset :disabled="state.working || !!state.pending">
      <legend>评审模板</legend>
      <label>模板<select :value="state.templateIndex" @change="generation.selectTemplate(Number(input($event)))">
        <option value="-1" disabled>请选择模板</option>
        <option v-for="(template, index) in state.templates" :key="`${template.id}:${template.version}`" :value="index">{{ template.name }} · {{ template.version }}{{ template.available ? '' : ' · 暂不可用' }}</option>
      </select></label>
      <p v-if="selected && !selected.available">模板暂不可用：{{ selected.unavailable_reason || '当前生成服务不可用' }}</p>
      <label>组织名称<input v-model="state.options.organization_name" maxlength="128"></label>
      <label>页眉<input v-model="state.options.header_text" maxlength="256"></label>
      <label>页脚<input v-model="state.options.footer_text" maxlength="256"></label>
      <div class="columns"><label v-for="column in columns" :key="column.key"><input v-model="state.options.optional_columns" type="checkbox" :value="column.key">{{ column.label }}</label></div>
      <details><summary>企业标识（可选固定参考附件）</summary>
        <label>资料编号<input v-model="logo.item_id"></label>
        <label>资料版本<input v-model="logo.version_id"></label>
        <label>附件编号<input v-model="logo.file_id"></label>
        <label>附件内容摘要<input v-model="logo.expected_checksum"></label>
        <button @click="applyLogo">使用此固定附件</button><button @click="generation.setLogo(null)">不用企业标识</button>
        <p>{{ state.options.logo ? '已选固定参考附件；生成时仍会核对内容和权限。' : '未使用企业标识' }}</p>
        <p role="status">{{ logoMessage }}</p>
      </details>
    </fieldset>
    <div class="actions">
      <button :disabled="!generation.canCreate.value" @click="generation.create()">生成评审文件</button>
      <button v-if="state.pending" :disabled="!generation.canConfirm.value" @click="generation.confirmOriginal()">核对并重发原生成请求</button>
      <button :disabled="!generation.canRetry.value" @click="generation.retryFailed()">重试失败的评审任务</button>
    </div>
    <p v-if="state.pending">原请求结果待确认；新请求暂不可发出。对应工艺 {{ state.pending.plan_id }} · {{ state.pending.item_version_id }}。</p>
    <template v-if="state.pending">
      <p v-if="state.pending.action === 'create'">原请求来自保存 {{ state.pending.body.expected_draft_seq }}，使用 A4 {{ state.pending.body.template_version }} 评审模板。组织：{{ state.pending.body.template_options.organization_name || '未填写' }}；页眉：{{ state.pending.body.template_options.header_text || '未填写' }}；页脚：{{ state.pending.body.template_options.footer_text || '未填写' }}。</p>
      <p v-else>原请求重试保存 {{ state.pending.basis.draft_seq }} 的 A4 {{ state.pending.basis.template.version }} 评审任务，原尝试次数 {{ state.pending.body.expected_attempt }}。</p>
    </template>
    <p>共 {{ state.total }} 份评审任务</p>
    <ul>
      <li v-for="item in state.items" :key="item.generation_id"><button :disabled="state.working" @click="generation.select(item.generation_id)">保存 {{ item.draft_seq }} · {{ statusLabel[item.status] }} · {{ item.created_at }}</button> · {{ generation.freshness(item) }}</li>
    </ul>
    <div class="actions"><button :disabled="state.working || state.offset === 0" @click="generation.refresh(Math.max(0, state.offset - 20))">上一页评审任务</button><button :disabled="state.working || state.offset + state.items.length >= state.total" @click="generation.refresh(state.offset + 20)">下一页评审任务</button></div>
    <div v-if="state.current">
      <p>保存 {{ state.current.draft_seq }} · {{ generation.freshness(state.current) }} · {{ statusLabel[state.current.status] }} · 第 {{ state.current.attempt }} 次尝试</p>
      <p>待复核 {{ state.current.review.pending_count }} · 未绑定 {{ state.current.review.unbound_count }}</p>
      <p v-if="state.current.error">生成失败：{{ state.current.error.message }}</p>
      <div class="actions"><button :disabled="state.working || state.current.status !== 'Ready'" @click="generation.download('pdf', true)">预览评审 PDF</button><button :disabled="state.working || state.current.status !== 'Ready'" @click="generation.download('pdf')">下载评审 PDF</button><button :disabled="state.working || state.current.status !== 'Ready'" @click="generation.download('docx')">下载评审 DOCX</button></div>
    </div>
    <button v-if="state.working || state.previewUrl" @click="generation.cancelDownload()">停止读取并关闭预览</button>
    <iframe v-if="state.previewUrl" :src="state.previewUrl" title="固定草稿评审 PDF 预览" />
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { useWeldingGenerationSession } from './useWeldingGenerationSession'
const props = defineProps<{ generation: ReturnType<typeof useWeldingGenerationSession> }>()
const state = props.generation.state, selected = computed(() => state.templates[state.templateIndex])
const input = (event: Event) => (event.target as HTMLInputElement).value
const columns = [{ key: 'group_name', label: '分组' }, { key: 'classification', label: '分类' }, { key: 'filler', label: '填充材料' }]
const statusLabel = { Queued: '排队中', Running: '生成中', Ready: '评审文件已生成', Failed: '生成失败' }
const logo = reactive({ item_id: '', version_id: '', file_id: '', expected_checksum: '' }), logoMessage = ref('')
function applyLogo() { try { props.generation.setLogo({ ...logo, file_role: 'reference' }); logoMessage.value = '' } catch { logoMessage.value = '请核对固定资料、版本、附件和内容摘要。' } }
</script>

<style scoped>
.generation-panel { margin-top: 16px; } label { display: inline-flex; flex-direction: column; gap: 5px; margin: 6px 12px 6px 0; }
fieldset { border: 1px solid #d9e2ec; border-radius: 6px; } input, select, button { font: inherit; padding: 7px 10px; }
.columns label { flex-direction: row; align-items: center; } .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
iframe { width: 100%; height: 600px; border: 1px solid #d9e2ec; } button:disabled { opacity: .55; }
</style>

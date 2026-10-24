<template>
  <section class="resource-import" aria-label="整批资料导入">
    <h3>CSV / XLSX 整批新建资料</h3>
    <p>使用固定 22 列模板，一份文件 1–100 行、最多 5 MiB。整批仅新建 Draft；任一失败整体不创建，不代表批准或专业适用性。</p>
    <button :disabled="s.busy" @click="act(imports.initialize)">核对整批导入身份与原请求</button>
    <p v-if="s.owner">导入身份 {{ s.owner.tenant_id }} / {{ s.owner.org_id }} · {{ s.owner.auth_user_id }} / {{ s.owner.rbac_user_id }}</p>
    <button :disabled="s.busy || !s.owner" @click="act(() => imports.downloadTemplate('csv'))">下载 CSV 固定模板</button>
    <button :disabled="s.busy || !s.owner" @click="act(() => imports.downloadTemplate('xlsx'))">下载 XLSX 固定模板</button>
    <label>原文件格式<select :value="s.format" :disabled="!imports.canSelect.value" @change="formatChanged"><option>csv</option><option>xlsx</option></select></label>
    <label>选择整批原文件<input type="file" :disabled="!imports.canSelect.value" @change="fileChanged"></label>
    <p v-if="s.fileName">当前选件：{{ s.fileName }} · {{ s.fileSize }} bytes · {{ s.format }} · SHA256 {{ s.rawHash || '尚未完成读取' }}</p>
    <button :disabled="!imports.canPreview.value" @click="act(imports.preview)">预检当前整份文件</button>
    <p v-if="s.storageBlocked">原请求存储尚未安全核对，提交不会发送。已有记录保持，请重新核对。</p>
    <p>当前阶段：{{ s.phase }}</p>
    <section v-if="s.preview" aria-label="整批预检全部行">
      <p>总行数 {{ s.preview.total_rows }} · 有效解析行 {{ s.preview.rows.length }} · 问题 {{ s.preview.errors.length }} · {{ s.preview.ready ? '可明确确认' : '不能提交' }}</p>
      <p>{{ s.preview.schema }} · {{ s.preview.format }}<br>原件 SHA256 {{ s.preview.raw_sha256 }}<br>规范化 SHA256 {{ s.preview.normalized_sha256 }}<br>授权预检摘要 {{ s.preview.preview_digest }}</p>
      <ol><li v-for="row in s.preview.rows" :key="row.row" :value="row.row" data-import-preview-row>
        文件行 {{ row.row }} · {{ row.row_key }} · {{ row.number }} · {{ row.name }} · {{ row.payload.kind }}
        <details><summary>全部登记内容与固定来源（文件行 {{ row.row }}）</summary><pre>{{ display(row) }}</pre></details>
      </li></ol>
      <button :disabled="!imports.canCommit.value" @click="act(imports.commit)">确认整批新建 {{ s.preview.total_rows }} 条 Draft</button>
    </section>
    <ul v-if="s.issues.length" aria-label="整批全部问题"><li v-for="(issue, index) in s.issues" :key="index" data-import-issue>
      {{ issue.row === null ? '文件级问题' : `文件行 ${issue.row}` }} · {{ issue.column }} · {{ issue.code }} · {{ issue.message }}
    </li></ul>
    <section v-if="s.pending" aria-label="整批原请求待核对">
      <h4>原请求待核对，服务器可能已经提交</h4>
      <p>{{ s.pending.import_id }} · {{ s.pending.format }} · {{ s.pendingBytes }} bytes · {{ s.pending.total_rows }} 行。当前选件不会替换原件；重放使用持久化的同一二进制、标识和摘要。</p>
      <details><summary>核对原请求全部身份、摘要与行映射</summary><pre>{{ display(s.pending) }}</pre></details>
      <button :disabled="!imports.canReplay.value" @click="act(imports.replay)">明确重放同一整批原请求</button>
    </section>
    <section v-if="s.receipt" aria-label="完整整批确认回执">
      <h4>完整确认 {{ s.receipt.total_rows }} 条 Draft</h4>
      <p>{{ s.receipt.schema }} · 批次 {{ s.receipt.import_id }}<br>原件 SHA256 {{ s.receipt.raw_sha256 }}<br>规范化 SHA256 {{ s.receipt.normalized_sha256 }}<br>授权预检摘要 {{ s.receipt.preview_digest }}</p>
      <ol><li v-for="item in s.receipt.items" :key="item.row" :value="item.row" data-import-receipt-row>
        文件行 {{ item.row }} · {{ item.row_key }} · {{ item.number }} · {{ item.name }} · {{ item.kind }} · {{ item.state }}
        <p>{{ item.resource_id }} / {{ item.item_version_id }} · {{ item.version_label }} · {{ item.content_hash }}</p>
        <button :disabled="s.busy || !s.owner" @click="act(() => imports.readItem(item))">鲜读固定版本 {{ item.item_version_id }}</button>
      </li></ol>
      <p>内容摘要来自 Yuantus。逐项鲜读核对当前可读固定详情，不自动读取全部资料，不替换单条维护表单。</p>
    </section>
    <details v-if="s.detail" open aria-label="导入固定详情"><summary>已核对固定详情 {{ s.detail.resource_id }} / {{ s.detail.item_version_id }}</summary><pre>{{ display(s.detail) }}</pre></details>
    <p v-if="s.responseStatus || s.responseCode" role="status">{{ s.responseStatus ? `服务器 HTTP ${s.responseStatus}` : '未取得可信回应' }} · {{ s.responseCode }}</p>
    <p role="alert">{{ s.message }}</p>
  </section>
</template>
<script setup lang="ts">
import type { ResourceImportFormat } from '../../services/welding/resourceImportContracts'
import type { useWeldingResourceImportSession } from './useWeldingResourceImportSession'
const props = defineProps<{ imports: ReturnType<typeof useWeldingResourceImportSession> }>()
const imports = props.imports, s = imports.state
const display = (value: unknown) => JSON.stringify(value, null, 2)
async function act(action: () => unknown) { try { await action() } catch (error) { s.message = error instanceof Error ? error.message : '整批动作未确认' } }
function formatChanged(event: Event) { void act(() => imports.selectFormat((event.target as HTMLSelectElement).value as ResourceImportFormat)) }
function fileChanged(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0] ?? null
  input.value = ''; void act(() => imports.selectFile(file))
}
</script>
<style scoped>
.resource-import { border-top: 1px solid #d9e2ec; margin-top: 16px; padding-top: 12px; }
label { display: inline-flex; flex-direction: column; margin: 6px; } button { margin: 6px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; } p, li { overflow-wrap: anywhere; } li { margin: 10px 0; }
</style>

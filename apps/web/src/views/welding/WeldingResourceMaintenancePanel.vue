<template>
  <section class="resource-maintenance">
    <h2>企业资料查询、登记与修订</h2>
    <p>固定资料仍为 Draft；此处不批准或判断专业适用性，也不自动更新已有工艺包引用。</p>
    <button :disabled="s.busy" @click="act(resources.initialize)">核对身份与个人原资料请求</button>
    <p v-if="s.owner">当前身份 {{ s.owner.tenant_id }} / {{ s.owner.org_id }} · {{ s.owner.auth_user_id }} / {{ s.owner.rbac_user_id }}。资料与来源权限由服务器逐次判定。</p>
    <p v-if="s.storageBlocked">个人原请求尚未安全核对，新的资料命令不发送。</p>
    <section aria-label="资料条件查询">
      <h3>按已登记字段查询资料</h3>
      <label>查询类别<select v-model="s.catalog.filters.kind"><option value="">全部类别</option><option v-for="kind in resourceKinds" :key="kind" :value="kind">{{ labels[kind] }}</option></select></label>
      <label v-for="key in queryTextFields" :key="key">查询{{ resourceFields[key] }}<input v-model="s.catalog.filters[key]" maxlength="256"></label>
      <template v-for="side in querySides" :key="side">
        <label>查询板厚 {{ side.toUpperCase() }} 数值<input :value="s.catalog.filters[`thickness_${side}_value`]" type="number" min="0" step="any" @input="s.catalog.filters[`thickness_${side}_value`] = inputValue($event)"></label>
        <label>查询板厚 {{ side.toUpperCase() }} 单位<select v-model="s.catalog.filters[`thickness_${side}_unit`]"><option value="">不指定</option><option>mm</option><option>in</option></select></label>
      </template>
      <label>每页资料数<input v-model.number="s.catalog.filters.limit" type="number" min="1" max="20"></label>
      <button :disabled="s.busy || !s.owner" @click="act(() => resources.searchCatalog())">查询资料</button>
      <p>文字按已录入值筛选，数值与单位须成对；不推断专业适用性。</p>
      <ul><li v-for="row in s.catalog.items" :key="`${row.resource_id}/${row.item_version_id}`">{{ row.number }} · {{ row.name }} · {{ labels[row.kind] }} · {{ row.version_label }} · {{ row.state }} · {{ row.resource_id }} / {{ row.item_version_id }}
        <button :disabled="selectionBlocked" @click="act(() => resources.selectSummary(row))">选择并鲜读 {{ row.number }} / {{ row.item_version_id }}</button>
        <button :disabled="s.busy || !s.owner" @click="openHistory(row.resource_id)">查看 {{ row.number }} 的版本</button>
      </li></ul>
      <p v-if="s.catalog.loaded && !s.catalog.message && !s.catalog.items.length">本次查询未返回可读匹配资料。</p>
      <p v-if="s.catalog.message" role="alert">资料查询失败：{{ s.catalog.message }}；已加载页未作为新结果更新。</p>
      <button :disabled="s.busy || !s.owner || !s.catalog.nextCursor" @click="act(() => resources.searchCatalog(true))">下一页资料</button>
    </section>
    <section aria-label="资料版本历史">
      <h3>选择固定历史版本</h3>
      <label>历史资料 ID<input v-model="s.history.resourceId" maxlength="64"></label>
      <button :disabled="s.busy || !s.owner" @click="act(() => resources.searchHistory())">查询版本历史</button>
      <p>版本 ID 按字面排序，不代表创建时序。选择后重新读取固定详情，不自动升级工艺包引用。</p>
      <p v-if="s.history.loaded">{{ s.history.currentVersionId ? `本次可读 current：${s.history.currentVersionId}（可能位于其他页）` : '本次未披露可读 current；不表示资料没有 current。' }}</p>
      <ul><li v-for="row in s.history.items" :key="row.item_version_id">{{ row.item_version_id }} · {{ row.version_label }} · {{ row.name }} · {{ row.state }}
        <button :disabled="selectionBlocked" @click="act(() => resources.selectSummary(row, true))">读取历史版本 {{ row.item_version_id }}</button>
      </li></ul>
      <p v-if="s.history.loaded && !s.history.message && !s.history.items.length">本页没有可读版本。</p>
      <p v-if="s.history.message" role="alert">版本查询失败：{{ s.history.message }}；已加载页未作为新结果更新。</p>
      <button :disabled="s.busy || !s.owner || !s.history.nextCursor" @click="act(() => resources.searchHistory(true))">下一页版本</button>
    </section>
    <div class="actions">
      <label>固定资料 ID<input v-model="resourceId" :disabled="s.busy || !!s.pending"></label>
      <label>固定版本 ID<input v-model="versionId" :disabled="s.busy || !!s.pending"></label>
      <button :disabled="s.busy || !!s.pending || !s.owner || s.storageBlocked" @click="act(() => resources.read(resourceId, versionId))">读取固定资料版本</button>
      <button :disabled="s.busy || !!s.pending || !s.owner || s.storageBlocked" @click="act(resources.newResource)">准备新资料登记</button>
    </div>
    <p v-if="s.record">{{ s.record.resource_id }} / {{ s.record.item_version_id }} · {{ s.record.version_label }} · {{ s.record.state }} · {{ s.record.content_hash }}</p>
    <WeldingJointDiagramPreview v-if="s.record?.kind === 'joint_diagram'" :stamp="JSON.stringify([s.owner, s.record, s.form, resourceId, versionId])" :disabled="!s.owner" :load="resources.readDiagram" />
    <section aria-label="固定文档候选">
      <h3>查询并明确选择固定文档</h3>
      <label>文档查询<input v-model="s.documents.query" maxlength="100"></label>
      <button :disabled="s.busy || !s.owner" @click="act(() => resources.searchDocuments())">查询文档候选</button>
      <ul><li v-for="row in s.documents.items" :key="JSON.stringify([row.item_id, row.version_id, row.file_id, row.file_role])">{{ row.title }} · {{ row.version_label }} · {{ row.file_name }} · {{ row.state }} · {{ row.item_id }} / {{ row.version_id }} / {{ row.file_id }} / {{ row.file_role }}
        <p>固定指纹 {{ row.fingerprint }}</p>
        <button :disabled="selectionBlocked" @click="act(() => resources.selectDocument(row))">明确选择文档 {{ row.file_name }}</button>
      </li></ul>
      <p v-if="s.documents.loaded && !s.documents.message && !s.documents.items.length">本页没有可读文档候选。</p>
      <p v-if="s.documents.message" role="alert">文档查询失败：{{ s.documents.message }}；已加载页未作为新结果更新。</p>
      <button :disabled="s.busy || !s.owner || !s.documents.nextCursor" @click="act(() => resources.searchDocuments(true))">下一页文档</button>
      <p>只固定所选文档与版本，不提交登记；资料提交时仍核对权限和指纹。</p>
    </section>
    <fieldset :disabled="s.busy || !!s.pending || !s.owner">
      <legend>{{ s.record ? '以固定旧版准备修订' : '新资料登记' }}</legend>
      <label>资料名称<input v-model="s.form.name" maxlength="128"></label>
      <label>资料编号<input v-model="s.form.number" maxlength="128" :readonly="!!s.record"></label>
      <label>资料类别<select :value="s.form.payload.kind" :disabled="!!s.record" @change="changeKind($event)"><option v-for="kind in resourceKinds" :key="kind" :value="kind">{{ labels[kind] }}</option></select></label>
      <div v-for="key in fields" :key="key" class="field-row">
        <label><input type="checkbox" :checked="has(key)" @change="toggleField(key, $event)">明确登记 {{ resourceFields[key] }}</label>
        <template v-if="has(key)">
          <template v-if="key === 'thickness_a' || key === 'thickness_b'">
            <input :aria-label="`${resourceFields[key]}数值`" type="number" min="0" step="any" :value="amount(key).value as number | null" @input="setAmount(key, 'value', $event)">
            <select :aria-label="`${resourceFields[key]}单位`" :value="amount(key).unit" @change="setAmount(key, 'unit', $event)"><option value="">请选择单位</option><option>mm</option><option>in</option></select>
          </template>
          <template v-else-if="key === 'passes'">
            <label>明确层道 JSON（sequence 唯一；current A、voltage V、speed mm/min 或 in/min）<textarea :value="passesText" rows="4" @input="setPasses($event)" /></label>
          </template>
          <textarea v-else-if="key.endsWith('requirements')" :aria-label="resourceFields[key]" :value="String(s.form.payload.suggested_fields[key])" maxlength="4000" @input="setText(key, $event)" />
          <input v-else :aria-label="resourceFields[key]" :value="String(s.form.payload.suggested_fields[key])" maxlength="256" @input="setText(key, $event)">
        </template>
      </div>
      <label><input type="checkbox" :checked="!!s.form.payload.document" :disabled="documentRequired" @change="toggleDocument($event)">明确固定文档来源{{ documentRequired ? '（此类别必填）' : '（可省略）' }}</label>
      <button v-if="documentRequired && !s.form.payload.document" @click="addDocument()">填写必需固定文档来源</button>
      <div v-if="s.form.payload.document" class="document-fields">
        <label>文档 Item ID<input v-model="s.form.payload.document.item_id" maxlength="64"></label>
        <label>文档版本 ID<input v-model="s.form.payload.document.version_id" maxlength="64"></label>
        <label>文档 File ID<input v-model="s.form.payload.document.file_id" maxlength="64"></label>
        <label>文档文件角色<select v-model="s.form.payload.document.file_role"><option>attachment</option><option>reference</option></select></label>
        <label>文档预期指纹<input v-model="s.form.payload.document.expected_fingerprint" maxlength="64"></label>
      </div>
      <p>填写已授权固定来源的五字段；不上传文件，不从文件名称推断身份。未勾选字段省略；明确空字符串／空层道保持。</p>
    </fieldset>
    <button v-if="s.record" :disabled="s.busy || !!s.pending || s.record.state !== 'Draft'" @click="act(resources.compare)">比较旧版与拟登记内容</button>
    <div v-if="s.comparison" class="comparison">
      <h3>明确确认前的旧新比较</h3>
      <div><h4>固定旧版</h4><pre>{{ display(s.record && { name: s.record.name, number: s.record.number, payload: s.record.payload }) }}</pre></div>
      <div><h4>拟登记内容</h4><pre>{{ display(s.comparison) }}</pre></div>
    </div>
    <button :disabled="!resources.canRequest.value" @click="act(resources.submit)">{{ s.record ? '确认请求登记新版本' : '确认请求登记资料草稿' }}</button>
    <div v-if="s.pending">
      <p>原请求 {{ s.pending.body.request_id }} · POST {{ resources.resourcePath(s.pending) }}。未取得可信 ACK 前保持；不会自动改键、清除或发送新内容。</p>
      <details><summary>核对完整原请求</summary><pre>{{ display(s.pending.body) }}</pre></details>
      <button :disabled="!resources.canConfirm.value" @click="act(resources.confirmOriginal)">明确重发同一原资料请求</button>
    </div>
    <p role="alert">{{ s.message }}</p>
    <WeldingResourceImportPanel v-if="imports" :imports="imports" />
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { resourceFields } from '../../services/welding/planClient'
import WeldingJointDiagramPreview from './WeldingJointDiagramPreview.vue'
import { isObject } from '../../services/welding/planRecovery'
import { resourceKindFields, resourceKinds, type ResourceKind } from '../../services/welding/resourceContracts'
import type { useWeldingResourceSession } from './useWeldingResourceSession'
import WeldingResourceImportPanel from './WeldingResourceImportPanel.vue'
import type { useWeldingResourceImportSession } from './useWeldingResourceImportSession'
const props = defineProps<{ resources: ReturnType<typeof useWeldingResourceSession>; imports?: ReturnType<typeof useWeldingResourceImportSession> }>()
const resources = props.resources, s = resources.state, resourceId = ref(''), versionId = ref('')
const labels: Record<ResourceKind, string> = { wps: 'WPS', pqr: 'PQR', parameter_reference: '参数参考', requirements: '要求', material: '母材', filler: '填充材料', joint_diagram: '接头图' }
const fields = computed(() => resourceKindFields[s.form.payload.kind])
const queryTextFields = ['method', 'material_a', 'material_b', 'filler', 'joint_type'] as const
const querySides = ['a', 'b'] as const
const selectionBlocked = computed(() => s.busy || !!s.pending || !s.owner || s.storageBlocked)
const documentRequired = computed(() => ['wps', 'pqr', 'joint_diagram'].includes(s.form.payload.kind))
const has = (key: string) => Object.keys(s.form.payload.suggested_fields).includes(key)
const display = (value: unknown) => JSON.stringify(value, null, 2)
const passesText = computed(() => { const value = s.form.payload.suggested_fields.passes; return Array.isArray(value) ? display(value) : String(value ?? '') })
const inputValue = (event: Event) => (event.target as HTMLInputElement).value
const checked = (event: Event) => (event.target as HTMLInputElement).checked
async function act(action: () => unknown) { try { await action() } catch (error) { s.message = error instanceof Error ? error.message : '资料动作未确认' } }
async function openHistory(resource: string) { s.history.resourceId = resource; await act(() => resources.searchHistory()) }
function changeKind(event: Event) {
  const kind = inputValue(event) as ResourceKind
  if (!resourceKinds.includes(kind) || kind === s.form.payload.kind) return
  if ((Object.keys(s.form.payload.suggested_fields).length || s.form.payload.document) && !window.confirm('更换类别将清空当前登记字段和固定来源，是否继续？')) { (event.target as HTMLSelectElement).value = s.form.payload.kind; return }
  s.form.payload = { schema_version: 1, kind, suggested_fields: {} }
}
function toggleField(key: string, event: Event) {
  if (!checked(event)) delete s.form.payload.suggested_fields[key]
  else s.form.payload.suggested_fields[key] = key === 'passes' ? [] : key.startsWith('thickness_') ? { value: null, unit: '' } : ''
}
function setText(key: string, event: Event) { s.form.payload.suggested_fields[key] = inputValue(event) }
function amount(key: string): Record<string, unknown> { const value = s.form.payload.suggested_fields[key]; return isObject(value) ? value : {} }
function setAmount(key: string, member: string, event: Event) {
  const value = inputValue(event); s.form.payload.suggested_fields[key] = { ...amount(key), [member]: member === 'value' ? value === '' ? null : Number(value) : value }
}
function setPasses(event: Event) { const raw = inputValue(event); try { s.form.payload.suggested_fields.passes = JSON.parse(raw) } catch { s.form.payload.suggested_fields.passes = raw } }
function addDocument() { s.form.payload.document = { item_id: '', version_id: '', file_id: '', file_role: 'attachment', expected_fingerprint: '' } }
function toggleDocument(event: Event) { if (checked(event)) addDocument(); else delete s.form.payload.document }
</script>
<style scoped>
.resource-maintenance { border: 1px solid #d9e2ec; padding: 16px; margin-bottom: 16px; }
label { display: inline-flex; flex-direction: column; margin: 6px; } button { margin: 6px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.comparison { display: flex; flex-wrap: wrap; gap: 16px; } .comparison > div { min-width: 0; flex: 1 1 260px; }
textarea { min-width: 240px; max-width: 100%; } .document-fields input { max-width: 100%; }
</style>

<template>
  <section class="sp-yida-preview" data-testid="stock-prep-yida-preview-panel">
    <h3>宜搭静态预演（不发送）</h3>
    <p>仅在本页处理粘贴的本地 JSON；请勿填写凭据。目标标识和远端状态均未核验。</p>
    <p>预演不会查询或推送。项目分配是用户选择的本地候选，尚非获批准的生产数量政策。</p>
    <fieldset class="sp-yida-preview__editor" :disabled="ownerSendLocked || initializationLocked">
    <label>预演合同<select v-model="previewMode" data-testid="sp-yida-preview-mode"><option value="mapping">字段映射 v1（默认）</option><option value="protocol">表单字段目录与协议 v2（仅本地）</option></select></label>
    <div class="sp-yida-preview__examples">
      <button type="button" data-testid="sp-yida-example-primary" @click="loadExample('primary')">填入合成样例 A（创建）</button>
      <button type="button" data-testid="sp-yida-example-renamed" @click="loadExample('renamed')">填入合成样例 B（另一布局）</button>
    </div>
    <div v-if="previewMode === 'protocol'" class="sp-yida-preview__examples">
      <button type="button" data-testid="sp-yida-protocol-example-primary" @click="loadProtocolExample('primary')">填入七项身份合成样例 A</button>
      <button type="button" data-testid="sp-yida-protocol-example-renamed" @click="loadProtocolExample('renamed')">填入七项身份合成样例 B（另一布局）</button>
    </div>
    <div class="sp-yida-preview__fields">
      <label>appType（本地未核验）<input v-model="appType" data-testid="sp-yida-app-type" autocomplete="off"></label>
      <label>formUuid（本地未核验）<input v-model="formUuid" data-testid="sp-yida-form-uuid" autocomplete="off"></label>
      <label>意图<select v-model="intent" data-testid="sp-yida-intent"><option value="create">计划创建</option><option value="update">计划更新</option></select></label>
      <label v-if="intent === 'update'">instanceIdField（本地行中的实例 ID 字段）<input v-model="instanceIdField" data-testid="sp-yida-instance-id-field" autocomplete="off"></label>
    </div>
    <section v-if="previewMode === 'protocol'" class="sp-yida-preview__catalog" data-testid="sp-yida-catalog">
      <h4>本地表单字段目录</h4>
      <p>字段目录由你明确填写，未向宜搭查询；控件标识、类型、选项和必填要求均未获远端核验。映射须引用目录中已有的字段。</p>
      <div v-for="(entry, index) in fieldCatalog" :key="index" class="sp-yida-preview__map-row" :data-testid="`sp-yida-catalog-row-${index}`">
        <label>字段 ID<input v-model="entry.id" :data-testid="`sp-yida-catalog-id-${index}`" autocomplete="off"></label>
        <label>控件<select v-model="entry.control" :data-testid="`sp-yida-catalog-control-${index}`"><option value="text">文本</option><option value="number">数字</option><option value="select">单选</option><option value="radio">单选按钮</option></select></label>
        <label><input v-model="entry.required" type="checkbox" :data-testid="`sp-yida-catalog-required-${index}`">目录必填</label>
        <template v-if="entry.control === 'select' || entry.control === 'radio'">
          <label>选项表示<select v-model="entry.optionsMode" :data-testid="`sp-yida-catalog-options-mode-${index}`"><option value="lines">逐行文本（一行一项）</option><option value="json">JSON 字符串数组（保留选项内换行）</option></select></label>
          <label>选项（精确匹配；切换表示后请核对格式）<textarea v-model="entry.optionsText" :data-testid="`sp-yida-catalog-options-${index}`" rows="3" spellcheck="false"></textarea></label>
        </template>
        <button type="button" :data-testid="`sp-yida-catalog-remove-${index}`" @click="fieldCatalog.splice(index, 1)">移除目录字段</button>
      </div>
      <button type="button" data-testid="sp-yida-catalog-add" @click="fieldCatalog.push(blankCatalogEntry())">添加目录字段</button>
      <p data-testid="sp-yida-empty-key-hint">允许空键仅用于本地身份比较：勾选的可选字符串业务键将缺失、null、空字符串视为同一身份；空白字符串不属于这个规则。不会往候选表单写入空值或清空字段。</p>
    </section>
    <div class="sp-yida-preview__mapping">
      <h4>字段映射</h4>
      <p>source 是本地 JSON 字段；target 是目标表单字段。业务键仅作本地重复检查，不能验证远端状态。</p>
      <div v-for="(entry, index) in fieldMap" :key="index" class="sp-yida-preview__map-row" :data-testid="`sp-yida-map-row-${index}`">
        <label>source<input v-model="entry.source" :data-testid="`sp-yida-map-source-${index}`" autocomplete="off"></label>
        <label>target<input v-model="entry.target" :data-testid="`sp-yida-map-target-${index}`" autocomplete="off"></label>
        <label>type<select v-model="entry.type" :data-testid="`sp-yida-map-type-${index}`"><option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option></select></label>
        <label><input v-model="entry.required" type="checkbox" :data-testid="`sp-yida-map-required-${index}`">必填</label>
        <label><input v-model="entry.businessKey" type="checkbox" :data-testid="`sp-yida-map-key-${index}`">业务键</label>
        <label v-if="previewMode === 'protocol'"><input v-model="entry.emptyKey" type="checkbox" :data-testid="`sp-yida-map-empty-key-${index}`">允许空键（仅可选字符串业务键）</label>
        <button type="button" :data-testid="`sp-yida-map-remove-${index}`" @click="fieldMap.splice(index, 1)">移除</button>
      </div>
      <button type="button" data-testid="sp-yida-map-add" @click="fieldMap.push(blankFieldMap())">添加映射行</button>
    </div>
    <div class="sp-yida-preview__allocation">
      <h4>项目数量分配（本地候选）</h4>
      <p>不从看板、范围或斜杠语法推断项目。整数模式必须整除；小数模式至多六位且不舍入。单位可否拆分、余数归属和旧复合键仍需生产政策批准。</p>
      <p>项目字段由明确项目列表覆盖，原值可缺省；其它映射字段仍须满足校验。项目列表不接受空行或制表符。</p>
      <label>模式<select v-model="allocationMode" data-testid="sp-yida-allocation-mode"><option value="original">原已整理逐表单（默认）</option><option value="equal_integer">整数精确均分</option><option value="equal_decimal_exact">小数精确均分（最多 6 位，不舍入）</option></select></label>
      <div v-if="allocationMode !== 'original'" class="sp-yida-preview__allocation-fields" data-testid="sp-yida-allocation-fields">
        <label>明确项目列表（一行一个完整项目号）<textarea v-model="allocationProjectsText" data-testid="sp-yida-allocation-projects" rows="4" spellcheck="false" placeholder="SYN-PROJECT-01&#10;SYN-PROJECT-02"></textarea></label>
        <label>源项目字段<select v-model="allocationProjectField" data-testid="sp-yida-allocation-project-field"><option value="">请选择</option><option v-for="source in mappedSources" :key="source" :value="source">{{ source }}</option></select></label>
        <label>源数量字段<select v-model="allocationQuantityField" data-testid="sp-yida-allocation-quantity-field"><option value="">请选择</option><option v-for="source in mappedSources" :key="source" :value="source">{{ source }}</option></select></label>
      </div>
      <p v-if="allocationMode !== 'original' && intent === 'update'" class="sp-yida-preview__error" data-testid="sp-yida-allocation-update-blocked">禁止更新扇出：项目分配只能计划创建，不能将一个 update instanceId 扇出到多个项目。</p>
    </div>
    <section class="sp-yida-preview__rule-template" data-testid="sp-yida-rule-template">
      <h4>复用本地规则草稿</h4>
      <p>仅导出字段规则和分配角色，不含目标、项目清单、行数据或授权。字段标识和选项可能含敏感业务配置，请人工核对文本及自行保存的位置；这不是凭据清洗器，也不是服务器保存或发布。</p>
      <button type="button" data-testid="sp-yida-rule-export" @click="exportRuleTemplate">生成规则草稿 JSON</button>
      <label>生成的规则草稿（只读，可自行保存文本）<textarea :value="ruleExportText" readonly data-testid="sp-yida-rule-export-text" rows="8" spellcheck="false"></textarea></label>
      <label>粘贴规则草稿 JSON（最多 2 MiB；与输出区独立）<textarea v-model="ruleImportText" data-testid="sp-yida-rule-import-text" rows="8" spellcheck="false"></textarea></label>
      <button type="button" data-testid="sp-yida-rule-import" @click="importRuleTemplate">加载粘贴的规则草稿 JSON</button>
      <p v-if="ruleImportNotice" data-testid="sp-yida-rule-import-notice">{{ ruleImportNotice }}</p>
    </section>
    <label class="sp-yida-preview__rows-label">本地 rows JSON（最大 128 KiB / 100 行）<textarea v-model="rowsText" data-testid="sp-yida-rows" rows="9" spellcheck="false" placeholder='[{"itemCode":"SYN-001","quantity":0,"active":false}]'></textarea></label>
    <button type="button" class="sp-yida-preview__run" data-testid="sp-yida-run" @click="runPreview">只在本地预演</button>
    </fieldset>
    <p v-if="errorCode" class="sp-yida-preview__error" data-testid="sp-yida-error">{{ errorCode }}</p>
    <ul v-if="configIssues.length" data-testid="sp-yida-config-issues"><li v-for="(issue, index) in configIssues" :key="index">{{ issue.field }}: {{ issue.code }}</li></ul>
    <section v-if="allocationPreview" class="sp-yida-preview__allocation-result" data-testid="sp-yida-allocation-result">
      <h4>分配分析（仅本地候选）</h4>
      <p data-testid="sp-yida-allocation-evidence">来源行 {{ allocationPreview.evidence.sourceRows }}；项目 {{ allocationPreview.evidence.projectCount }}；展开 {{ allocationPreview.evidence.expandedRows }}；无效来源 {{ allocationPreview.evidence.invalidSourceRows }}。</p>
      <ol><li v-for="item in allocationPreview.analysis" :key="item.sourceIndex" :data-testid="`sp-yida-allocation-analysis-${item.sourceIndex}`">源行 {{ item.sourceIndex + 1 }}；原总量 {{ displayNumber(item.sourceTotal) }}；项目数 {{ item.projectCount }}；每项目 {{ displayNumber(item.perProjectQuantity) }}；分配合计 {{ displayNumber(item.allocatedTotal) }}；差额 {{ displayNumber(item.difference) }}<span v-if="item.issues.length">；拒因 {{ item.issues.join(', ') }}</span><ul v-if="item.candidates.length"><li v-for="candidate in item.candidates" :key="candidate.expandedIndex" :data-testid="`sp-yida-allocation-candidate-${candidate.expandedIndex}`">源行 {{ item.sourceIndex + 1 }}；{{ candidateProjectLabel(candidate.expandedIndex, candidate.project) }}；候选 {{ candidate.expandedIndex + 1 }}：{{ rowStatus(candidate.status) }}<span v-if="candidate.issues.length">；拒因 {{ candidateReasons(candidate.expandedIndex) }}</span></li></ul></li></ol>
      <p v-if="allocationPreview.issues.length" data-testid="sp-yida-allocation-issues">{{ allocationPreview.issues.map((issue) => `${issue.index === null ? '整体' : `源行 ${issue.index + 1}`}: ${issue.code}`).join('；') }}</p>
    </section>
    <section v-if="plan" class="sp-yida-preview__result" data-testid="sp-yida-result">
      <h4>仅本地计划；远端状态未核验</h4>
      <p data-testid="sp-yida-summary">共 {{ plan.evidence.rowCount }} 行；计划创建 {{ plan.evidence.plannedCreate }}；计划更新 {{ plan.evidence.plannedUpdate }}；无效 {{ plan.evidence.invalid }}；本地重复键 {{ plan.evidence.duplicateKeyCount }}。</p>
      <p data-testid="sp-yida-no-apply">不可执行：canApply={{ plan.canApply }}，不会生成执行令牌、查询远端或写入外部系统。</p>
      <p v-if="previewMode === 'protocol'" data-testid="sp-yida-protocol-warning">以下仅为 SDK 数据字段 DTO，不含认证、令牌或执行用户，不能作为完整请求发送。远端表单和实例均未核验；本地重复检查不证明远端幂等。</p>
      <ol><li v-for="row in plan.rows" :key="row.index" :data-testid="`sp-yida-result-row-${row.index}`"><strong>{{ row.index + 1 }}. {{ rowStatus(row.status) }}</strong> · 远端未核验<span v-if="candidateOrigins.has(row.index)"> · {{ candidateOrigins.get(row.index) }}</span><span v-if="row.status !== 'invalid' && row.localBusinessKey"> · 本地业务键：{{ row.localBusinessKey }}</span><span v-if="row.instanceId"> · 本地 instanceId：{{ row.instanceId }}</span><ul v-if="row.issues.length"><li v-for="(issue, issueIndex) in row.issues" :key="issueIndex" :data-testid="`sp-yida-row-issue-${row.index}-${issueIndex}`">{{ rowIssueReason(issue) }}</li></ul><pre v-if="row.payload" :data-testid="`sp-yida-payload-${row.index}`">{{ JSON.stringify(row.payload, null, 2) }}</pre><div v-if="row.status !== 'invalid' && row.protocolPreview" :data-testid="`sp-yida-protocol-${row.index}`"><p>协议 {{ row.protocolPreview.contract }}；完整性 {{ row.protocolPreview.completeness }}（仅数据字段）</p><pre :data-testid="`sp-yida-protocol-data-${row.index}`">{{ JSON.stringify(row.protocolPreview.data, null, 2) }}</pre></div></li></ol>
    </section>
    <section v-if="persistentInput" class="sp-yida-preview__owner-entry">
      <p>独立本地初始化可在发送开关 OFF 下使用；只由服务器预指定 owner 管理永久单槽，不交换令牌或授权发送。</p>
      <button v-if="!initializationOpen" type="button" data-testid="sp-yida-initialization-open" :disabled="ownerSendLocked" @click="initializationOpen = true">打开本地初始化（不发送）</button>
      <StockPreparationYidaInitializationPanel v-if="initializationOpen" :draft-input="persistentInput" @locked-change="initializationLocked = $event" />
      <p>以下是独立服务器确认流程，默认关闭；仅当前人工登记目标的 owner 且具备集成管理员权限可用。它不会把上面的本地预演当发送许可。</p>
      <button v-if="!ownerSendOpen" type="button" data-testid="sp-yida-owner-open" :disabled="initializationLocked" @click="ownerSendOpen = true">打开单行 CREATE 确认（需服务器开通）</button>
      <StockPreparationYidaOwnerSendPanel v-if="ownerSendOpen" :draft-input="persistentInput" @locked-change="ownerSendLocked = $event" />
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { buildYidaStaticPlan, createYidaStaticExample, createYidaProtocolExample, parseYidaStaticRows, validateYidaStaticConfig, YidaStaticPlanError, type YidaProtocolCatalogEntry, type YidaProtocolExample, type YidaStaticConfig, type YidaStaticExample, type YidaStaticPlan, type YidaStaticRowIssue, type YidaStaticRowIssueCode } from '../../../../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'
import { buildYidaProjectAllocationPreview, YidaAllocationError, type YidaProjectAllocationPreview } from '../../../../../../plugins/plugin-integration-core/lib/stock-preparation-yida-allocation.mjs'
import { exportYidaRuleTemplate, parseYidaRuleTemplate, YidaRuleTemplateError, type YidaRuleTemplateRules, type YidaRuleTemplateAllocation } from '../../../../../../plugins/plugin-integration-core/lib/yida-rule-template.mjs'
import StockPreparationYidaOwnerSendPanel from './StockPreparationYidaOwnerSendPanel.vue'
import StockPreparationYidaInitializationPanel from './StockPreparationYidaInitializationPanel.vue'
import type { YidaOwnerDraftInput } from '../../../services/integration/yidaOwner'

type FieldMapEntry = YidaStaticConfig['fieldMap'][number] & { businessKey: boolean; emptyKey: boolean }
type CatalogEntry = { id: string; control: 'text' | 'number' | 'select' | 'radio'; required: boolean; optionsText: string; optionsMode: 'lines' | 'json' }
type AllocationMode = 'original' | 'equal_integer' | 'equal_decimal_exact'
function blankFieldMap(): FieldMapEntry { return { source: '', target: '', type: 'string', required: false, businessKey: false, emptyKey: false } }
function blankCatalogEntry(): CatalogEntry { return { id: '', control: 'text', required: false, optionsText: '', optionsMode: 'lines' } }
const previewMode = ref<'mapping' | 'protocol'>('mapping')
const persistentInput = ref<YidaOwnerDraftInput | null>(null)
const ownerSendOpen = ref(false)
const ownerSendLocked = ref(false)
const initializationOpen = ref(false)
const initializationLocked = ref(false)
const fieldCatalog = reactive<CatalogEntry[]>([])
const appType = ref('')
const formUuid = ref('')
const intent = ref<YidaStaticConfig['intent']>('create')
const instanceIdField = ref('')
const fieldMap = reactive<FieldMapEntry[]>([blankFieldMap()])
const businessKeyOrder = ref<string[]>([])
const emptyKeyOrder = ref<string[]>([])
const rowsText = ref('')
const allocationMode = ref<AllocationMode>('original')
const allocationProjectsText = ref('')
const allocationProjectField = ref('')
const allocationQuantityField = ref('')
const plan = ref<YidaStaticPlan | null>(null)
const allocationPreview = ref<YidaProjectAllocationPreview | null>(null)
const errorCode = ref('')
const configIssues = ref<Array<{ code: string; field: string }>>([])
const ruleExportText = ref('')
const ruleImportText = ref('')
const ruleImportNotice = ref('')
const mappedSources = computed(() => [...new Set(fieldMap.map((entry) => entry.source).filter((source) => source.length > 0))])
const candidateOrigins = computed(() => new Map(allocationPreview.value?.analysis.flatMap((item) =>
  item.candidates.map((candidate) => [candidate.expandedIndex, `源行 ${item.sourceIndex + 1}；${candidateProjectLabel(candidate.expandedIndex, candidate.project)}`] as const)) ?? []))
function candidateProjectLabel(expandedIndex: number, project: string): string {
  const projectRejected = plan.value?.rows.find((row) => row.index === expandedIndex)?.issues.some((issue) =>
    issue.fields?.some((field) => field.source === allocationProjectField.value))
  if (projectRejected) return '项目字段未通过校验'
  return `项目 ${project}`
}
function candidateReason(code: YidaStaticRowIssueCode): string {
  const labels: Record<YidaStaticRowIssueCode, string> = {
    KEY_MISSING: 'KEY_MISSING（业务键缺失）',
    FIELD_REQUIRED: 'FIELD_REQUIRED（必填字段缺失）',
    FIELD_TYPE: 'FIELD_TYPE（字段类型不符）',
    INSTANCE_ID_MISSING: 'INSTANCE_ID_MISSING（实例标识缺失）',
    DUPLICATE_LOCAL_KEY: 'DUPLICATE_LOCAL_KEY（本地业务键重复）',
    FIELD_OPTION_INVALID: 'FIELD_OPTION_INVALID（选项不符，须使用配置的合法选项）',
    FIELD_NUMBER_INVALID: 'FIELD_NUMBER_INVALID（数字须有限且不是负零，整数须在安全范围内）',
  }
  return labels[code] ?? '候选校验失败'
}
function rowIssueReason(issue: YidaStaticRowIssue): string {
  const types = { string: '文本', number: '数字', boolean: '布尔值' }
  return [candidateReason(issue.code), ...(issue.fields ?? []).map((field) =>
    `${field.source} → ${field.target}（期望${types[field.type]}）`)].join('；')
}
function candidateReasons(expandedIndex: number): string {
  // Allocation candidates keep their code-only contract; details belong to the actual planner row.
  return plan.value?.rows.find((row) => row.index === expandedIndex)?.issues.map(rowIssueReason).join(', ') ?? ''
}
function clearResults(): void {
  persistentInput.value = null; ownerSendOpen.value = false; ownerSendLocked.value = false
  initializationOpen.value = false; initializationLocked.value = false
  plan.value = null; allocationPreview.value = null; errorCode.value = ''; configIssues.value = []
}
function invalidateOutputs(): void { clearResults(); ruleExportText.value = ''; ruleImportNotice.value = '' }
watch([previewMode, fieldCatalog, appType, formUuid, intent, instanceIdField, fieldMap, businessKeyOrder, emptyKeyOrder, rowsText, allocationMode, allocationProjectsText, allocationProjectField, allocationQuantityField, ruleImportText], invalidateOutputs, { deep: true, flush: 'sync' })
function loadExample(kind: 'primary' | 'renamed'): void {
  applyExample(createYidaStaticExample(kind))
}
function loadProtocolExample(kind: 'primary' | 'renamed'): void {
  applyExample(createYidaProtocolExample(kind))
}
function applyExample(example: YidaStaticExample | YidaProtocolExample): void {
  const config = example.config
  previewMode.value = config.version === 2 ? 'protocol' : 'mapping'
  appType.value = example.config.target.appType; formUuid.value = example.config.target.formUuid; intent.value = example.config.intent; instanceIdField.value = example.config.instanceIdField ?? ''
  fieldMap.splice(0, fieldMap.length, ...mapEditorEntries(config))
  fieldCatalog.splice(0, fieldCatalog.length, ...catalogEditorEntries(config, 'lines'))
  businessKeyOrder.value = [...config.businessKey]; emptyKeyOrder.value = config.version === 2 ? [...config.emptyKeyFields] : []
  rowsText.value = example.text; allocationMode.value = 'original'; allocationProjectsText.value = 'SYN-PROJECT-01\nSYN-PROJECT-02'; allocationProjectField.value = config.businessKey[0] ?? ''; allocationQuantityField.value = config.fieldMap.find((entry) => entry.type === 'number')?.source ?? ''; invalidateOutputs()
}
function mapEditorEntries(config: YidaRuleTemplateRules): FieldMapEntry[] {
  const marked = new Set<string>()
  return config.fieldMap.map((entry) => {
    const first = !marked.has(entry.source); marked.add(entry.source)
    return { ...entry, businessKey: first && config.businessKey.includes(entry.source), emptyKey: first && config.version === 2 && config.emptyKeyFields.includes(entry.source) }
  })
}
function catalogEditorEntries(config: YidaRuleTemplateRules, optionsMode: CatalogEntry['optionsMode']): CatalogEntry[] {
  return config.version === 2 ? config.fieldCatalog.map((entry) => ({
    id: entry.id, control: entry.control, required: entry.required, optionsMode,
    optionsText: entry.options ? optionsMode === 'json' ? JSON.stringify(entry.options, null, 2) : entry.options.join('\n') : '',
  })) : []
}
function selectedKeys(role: 'businessKey' | 'emptyKey', order: string[]): string[] {
  const selected = fieldMap.filter((entry) => entry[role]).map((entry) => entry.source)
  return [...order.filter((source) => selected.includes(source)), ...selected.filter((source) => !order.includes(source))]
}
function currentConfig(): YidaStaticConfig {
  const common = { target: { appType: appType.value, formUuid: formUuid.value }, businessKey: selectedKeys('businessKey', businessKeyOrder.value), fieldMap: fieldMap.map(({ source, target, type, required }) => ({ source, target, type, required })) }
  const base = previewMode.value === 'protocol'
    ? { ...common, version: 2 as const, kind: 'yida-form-protocol-static' as const,
      emptyKeyFields: selectedKeys('emptyKey', emptyKeyOrder.value),
      fieldCatalog: fieldCatalog.map(catalogConfig),
    }
    : { ...common, version: 1 as const, kind: 'yida-form-static' as const }
  return intent.value === 'update' ? { ...base, intent: 'update', instanceIdField: instanceIdField.value } : { ...base, intent: 'create' }
}
function catalogConfig({ id, control, required, optionsText, optionsMode }: CatalogEntry): YidaProtocolCatalogEntry {
  if (control !== 'select' && control !== 'radio') return { id, control, required }
  const options: unknown = optionsMode === 'json' ? JSON.parse(optionsText) : optionsText.split(/\r?\n/)
  if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
  return { id, control, required, options }
}
function exportRuleTemplate(): void {
  invalidateOutputs()
  try {
    const config = currentConfig()
    const common = { fieldMap: config.fieldMap, businessKey: config.businessKey }
    const base = config.version === 2
      ? { ...common, version: 2 as const, kind: 'yida-form-protocol-static' as const, fieldCatalog: config.fieldCatalog, emptyKeyFields: config.emptyKeyFields }
      : { ...common, version: 1 as const, kind: 'yida-form-static' as const }
    const rules = config.intent === 'update' ? { ...base, intent: 'update' as const, instanceIdField: config.instanceIdField } : { ...base, intent: 'create' as const }
    const allocation: YidaRuleTemplateAllocation = allocationMode.value === 'original' ? { mode: 'original' }
      : { mode: allocationMode.value, projectField: allocationProjectField.value, quantityField: allocationQuantityField.value }
    ruleExportText.value = exportYidaRuleTemplate({ rules, allocation })
  } catch (error) { errorCode.value = error instanceof YidaRuleTemplateError ? error.code : 'YIDA_RULE_TEMPLATE_CONFIG' }
}
function importRuleTemplate(): void {
  invalidateOutputs()
  try {
    const { rules, allocation } = parseYidaRuleTemplate(ruleImportText.value)
    // Stage the entire editor representation before changing any current input.
    const nextMap = mapEditorEntries(rules)
    const nextCatalog = catalogEditorEntries(rules, 'json')
    previewMode.value = rules.version === 2 ? 'protocol' : 'mapping'; intent.value = rules.intent; instanceIdField.value = rules.instanceIdField ?? ''
    fieldMap.splice(0, fieldMap.length, ...nextMap); fieldCatalog.splice(0, fieldCatalog.length, ...nextCatalog)
    businessKeyOrder.value = [...rules.businessKey]; emptyKeyOrder.value = rules.version === 2 ? [...rules.emptyKeyFields] : []
    allocationMode.value = allocation.mode
    allocationProjectField.value = allocation.mode === 'original' ? '' : allocation.projectField
    allocationQuantityField.value = allocation.mode === 'original' ? '' : allocation.quantityField
    appType.value = ''; formUuid.value = ''; rowsText.value = ''; allocationProjectsText.value = ''
    ruleImportNotice.value = '仅本地规则，目标和数据待填写；未保存到服务器，未发布或授权。'
  } catch (error) { errorCode.value = error instanceof YidaRuleTemplateError ? error.code : 'YIDA_RULE_TEMPLATE_INPUT' }
}
function allocationSettings(): { mode: Exclude<AllocationMode, 'original'>; projects: string[]; projectField: string; quantityField: string } { return { mode: allocationMode.value as Exclude<AllocationMode, 'original'>, projects: allocationProjectsText.value.split(/\r?\n/), projectField: allocationProjectField.value, quantityField: allocationQuantityField.value } }
function capturePersistentInput(config: YidaStaticConfig): void {
  const current = plan.value
  if (config.version !== 2 || config.intent !== 'create' || !current || current.evidence.invalid !== 0
    || current.evidence.duplicateKeyCount !== 0 || current.rows.length === 0
    || current.rows.some(row => row.status !== 'planned_create') || (allocationPreview.value?.issues.length ?? 0) !== 0) return
  // No transport or storage here. The server recompiles and returns its own
  // immutable member identities; never zip these browser rows with rowKey.
  persistentInput.value = JSON.parse(JSON.stringify({ config, rowsText: rowsText.value,
    allocation: allocationMode.value === 'original' ? { mode: 'original' } : allocationSettings() })) as YidaOwnerDraftInput
}
function runPreview(): void {
  clearResults()
  let config: YidaStaticConfig
  try { config = currentConfig() } catch { errorCode.value = 'YIDA_STATIC_CONFIG_INVALID'; return }
  if (allocationMode.value !== 'original') {
    try { const preview = buildYidaProjectAllocationPreview({ config, rowsText: rowsText.value, allocation: allocationSettings() }); allocationPreview.value = preview; plan.value = preview.plan; capturePersistentInput(config) } catch (error) { errorCode.value = error instanceof YidaAllocationError ? error.code : 'YIDA_ALLOCATION_INPUT_INVALID' }
    return
  }
  const checked = validateYidaStaticConfig(config)
  if (!checked.valid) { errorCode.value = 'YIDA_STATIC_CONFIG_INVALID'; configIssues.value = checked.issues; return }
  try { plan.value = buildYidaStaticPlan({ config: checked.normalized, rows: parseYidaStaticRows(rowsText.value, checked.normalized) }); capturePersistentInput(checked.normalized) } catch (error) { errorCode.value = error instanceof YidaStaticPlanError ? error.code : 'YIDA_STATIC_INPUT_INVALID' }
}
function rowStatus(status: YidaStaticPlan['rows'][number]['status']): string { return status === 'planned_create' ? '计划创建' : status === 'planned_update' ? '计划更新' : '无效' }
function displayNumber(value: number | null | undefined): string { return value === null || value === undefined ? '—' : String(value) }
</script>

<style scoped>
.sp-yida-preview { display: grid; gap: var(--ms-space-3); min-width: 0; padding: var(--ms-space-4); border: 1px solid var(--ms-border-light); border-radius: 8px; background: var(--ms-bg-page); }
.sp-yida-preview h3, .sp-yida-preview h4, .sp-yida-preview p { margin: 0; }
.sp-yida-preview__editor { display: grid; gap: var(--ms-space-3); margin: 0; padding: 0; border: 0; min-width: 0; }
.sp-yida-preview__owner-entry { display: grid; gap: var(--ms-space-3); }
.sp-yida-preview__examples, .sp-yida-preview__fields, .sp-yida-preview__map-row, .sp-yida-preview__allocation-fields { display: flex; flex-wrap: wrap; gap: var(--ms-space-3); }
.sp-yida-preview label, .sp-yida-preview__mapping, .sp-yida-preview__catalog, .sp-yida-preview__allocation, .sp-yida-preview__rule-template { display: grid; gap: var(--ms-space-2); }
.sp-yida-preview input, .sp-yida-preview select, .sp-yida-preview textarea, .sp-yida-preview button { font: inherit; }
.sp-yida-preview input, .sp-yida-preview select, .sp-yida-preview textarea { padding: 6px; border: 1px solid var(--ms-border-light); border-radius: 6px; }
.sp-yida-preview__rows-label textarea, .sp-yida-preview__allocation textarea, .sp-yida-preview__rule-template textarea { width: 100%; box-sizing: border-box; }
.sp-yida-preview button { justify-self: start; padding: 6px 12px; border: 1px solid var(--ms-border-light); border-radius: 6px; background: var(--ms-bg-page); cursor: pointer; }
.sp-yida-preview__error { color: var(--ms-danger, #b42318); }
.sp-yida-preview__result, .sp-yida-preview__result li, .sp-yida-preview__allocation-result { min-width: 0; overflow-wrap: anywhere; }
.sp-yida-preview__result pre { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

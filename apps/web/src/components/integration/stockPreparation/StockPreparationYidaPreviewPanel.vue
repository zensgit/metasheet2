<template>
  <section class="sp-yida-setup" data-testid="stock-prep-yida-preview-panel">
    <h3>宜搭表单配置（不发送）</h3>
    <!-- Four operator steps (T-13, owner 2026-11-23). The contract version, the status read and the rule-draft
         archive are done by the page itself and are not steps. Display only: every server gate is unchanged. -->
    <ol class="sp-yida-setup__steps" data-testid="sp-yida-steps" aria-label="宜搭配置步骤">
      <li v-for="step in stepGuide" :key="step.number" :data-testid="`sp-yida-step-${step.number}`" :data-state="step.state"
        :aria-current="step.state === 'current' ? 'step' : undefined">{{ step.number }} {{ step.label }}<span v-if="step.state === 'done'">（已完成）</span><span v-else-if="step.state === 'current'">（当前）</span></li>
    </ol>
    <p data-testid="sp-yida-status">{{ statusText }}</p>
    <button v-if="showStatusRetry" type="button" data-testid="sp-yida-status-retry" :disabled="busy" @click="refresh()">重新读取状态</button>
    <p v-if="errorCode" role="alert" class="sp-yida-setup__error" data-testid="sp-yida-error">{{ errorCode }}</p>
    <p v-if="errorHint" data-testid="sp-yida-error-hint">{{ errorHint }}</p>

    <!-- ── 第 1 步：表单信息与测试连接 ── -->
    <fieldset class="sp-yida-setup__step" data-testid="sp-yida-form-info" :disabled="formLocked">
      <legend>1 表单信息与测试连接</legend>
      <p>凭据只在本页内存里，不保存到文件、不写日志；离开本页即清空。测试连接只换一次令牌、读一次表单字段，不写宜搭。</p>
      <div class="sp-yida-setup__grid">
        <label>appType（宜搭应用编码）<span class="sp-yida-setup__req" aria-hidden="true">*</span><input v-model="appType" data-testid="sp-yida-app-type" autocomplete="off" required aria-required="true"></label>
        <label>formUuid（表单 ID）<span class="sp-yida-setup__req" aria-hidden="true">*</span><input v-model="formUuid" data-testid="sp-yida-form-uuid" autocomplete="off" required aria-required="true"></label>
        <label>organizationId（钉钉组织 ID）<span class="sp-yida-setup__req" aria-hidden="true">*</span><input :value="organizationId" data-testid="sp-yida-organization" autocomplete="off" required aria-required="true" @input="setText('organization', $event)"></label>
        <label v-for="field in secretFields" :key="field">{{ field }}<span class="sp-yida-setup__req" aria-hidden="true">*</span><input type="password" :value="material[field]" :data-testid="`sp-yida-${field}`" autocomplete="off" spellcheck="false" required aria-required="true" @input="setMaterial(field, $event)" @paste="pasteMaterial(field, $event)"></label>
        <label>userId（执行人钉钉 userId）<span class="sp-yida-setup__req" aria-hidden="true">*</span><input :value="material.userId" data-testid="sp-yida-userId" autocomplete="off" spellcheck="false" required aria-required="true" @input="setMaterial('userId', $event)"></label>
      </div>
      <p class="sp-yida-setup__note">带 * 的七项都必填。appKey、appSecret、systemToken 会自动去掉首尾空白和换行；中间含空白或不可见字符时不发送。</p>
      <p v-if="blockedFields.length > 0" data-testid="sp-yida-material-hint">{{ blockedFields.join('、') }} 去掉首尾空白后仍含空白、换行或不可见字符，本页不会发送；请从原处重新复制。</p>
      <button type="button" data-testid="sp-yida-connection-test" :disabled="!mayTestConnection" @click="testConnection">测试连接{{ formFieldsReadOn ? '并读取表单字段' : '' }}</button>
      <p v-if="connectionTestBlockedReason" data-testid="sp-yida-connection-blocked">暂不能测试：{{ connectionTestBlockedReason }}</p>
      <p v-if="shownOutcome" data-testid="sp-yida-connection-result">{{ outcomeCopy[shownOutcome] }}</p>
      <p v-if="shownFormOutcome" data-testid="sp-yida-form-read-result">{{ formReadCopy }}</p>
      <p v-if="testedPairMismatch" data-testid="sp-yida-connection-mismatch">已测试的 appKey/appSecret 与当前输入不一致，请重新测试。</p>
      <p v-if="fieldsStale" data-testid="sp-yida-fields-stale">appType 或 formUuid 已改，字段列表属于上一张表单，请重新测试连接。</p>
      <p v-if="state && !formFieldsReadOn && state.status === 'ready'" data-testid="sp-yida-fields-manual">服务器未开启「读取表单字段」：第 2 步请手动填写宜搭组件 ID。</p>
    </fieldset>

    <!-- ── 第 2 步：字段映射 ── -->
    <fieldset class="sp-yida-setup__step" data-testid="sp-yida-mapping" :disabled="localLocked">
      <legend>2 字段映射</legend>
      <p>左边选备料字段，右边选宜搭字段。七项身份字段（项目号、图号、名称、规格、材质、版本、父组件图号）和数量必须映射，系统自动把七项身份作为业务键。</p>
      <div v-for="(row, index) in mappingRows" :key="index" class="sp-yida-setup__map-row" :data-testid="`sp-yida-map-row-${index}`">
        <label>备料字段<select v-model="row.source" :data-testid="`sp-yida-map-source-${index}`" @change="sourceChanged(row)"><option value="">请选择</option><option v-for="field in sourceOptions(index)" :key="field.source" :value="field.source">{{ field.label }}{{ field.identity || field.required ? '（必映射）' : '' }}</option></select></label>
        <label v-if="!manualTargets">宜搭字段<select :value="row.target" :data-testid="`sp-yida-map-target-${index}`" @change="targetChanged(row, $event)"><option value="">请选择</option><option v-for="field in targetOptions(index)" :key="field.fieldId" :value="field.fieldId">{{ field.label || field.fieldId }} · {{ componentLabel(field.componentName) }} · {{ field.fieldId }}</option></select></label>
        <template v-else>
          <label>宜搭组件 ID<input v-model="row.target" :data-testid="`sp-yida-map-target-${index}`" autocomplete="off"></label>
          <label>控件<select v-model="row.control" :data-testid="`sp-yida-map-control-${index}`"><option value="text">文本</option><option value="number">数字</option><option value="select">下拉单选</option><option value="radio">单选</option></select></label>
        </template>
        <label v-if="row.control === 'select' || row.control === 'radio'">选项（一行一项，与宜搭里完全一致）<textarea v-model="row.optionsText" :data-testid="`sp-yida-map-options-${index}`" rows="2" spellcheck="false"></textarea></label>
        <label><input v-model="row.yidaRequired" type="checkbox" :data-testid="`sp-yida-map-required-${index}`">宜搭里是必填</label>
        <button type="button" :data-testid="`sp-yida-map-remove-${index}`" @click="mappingRows.splice(index, 1)">移除</button>
      </div>
      <button v-if="mappingRows.length < sourceFields.length" type="button" data-testid="sp-yida-map-add" @click="mappingRows.push(blankMappingRow())">添加映射行</button>
      <ul v-if="mappingIssues.length > 0" data-testid="sp-yida-map-issues"><li v-for="(issue, index) in mappingIssues" :key="index">{{ issue.row === null ? '' : `第 ${issue.row + 1} 行：` }}{{ issue.message }}</li></ul>
    </fieldset>

    <!-- ── 第 3 步：预演 ── -->
    <fieldset class="sp-yida-setup__step" data-testid="sp-yida-preview" :disabled="localLocked">
      <legend>3 预演（只在本页，不发送）</legend>
      <details data-testid="sp-yida-rows-details" :open="rowsText.length === 0">
        <summary>预演数据（默认用合成样例）</summary>
        <button type="button" data-testid="sp-yida-example-primary" @click="loadExample">填入合成样例</button>
        <label class="sp-yida-setup__wide">本地 rows JSON（最大 128 KiB / 100 行；字段名同左侧备料字段）<textarea v-model="rowsText" data-testid="sp-yida-rows" rows="6" spellcheck="false" placeholder='[{"projectNo":"SYN-P1","componentCode":"SYN-001","quantity":1}]'></textarea></label>
      </details>
      <details data-testid="sp-yida-allocation">
        <summary>项目数量分配（可选，默认不分配）</summary>
        <p>整数模式必须整除；小数模式至多六位且不舍入。项目列表一行一个完整项目号。</p>
        <label>模式<select v-model="allocationMode" data-testid="sp-yida-allocation-mode"><option value="original">不分配（默认）</option><option value="equal_integer">整数精确均分</option><option value="equal_decimal_exact">小数精确均分（最多 6 位）</option></select></label>
        <label v-if="allocationMode !== 'original'" class="sp-yida-setup__wide">明确项目列表<textarea v-model="allocationProjectsText" data-testid="sp-yida-allocation-projects" rows="3" spellcheck="false"></textarea></label>
      </details>
      <button type="button" data-testid="sp-yida-run" :disabled="!buildResult.ok" @click="runPreview">预演</button>
      <p v-if="previewError" class="sp-yida-setup__error" data-testid="sp-yida-preview-error">{{ previewError }}</p>
      <section v-if="plan" data-testid="sp-yida-result">
        <p data-testid="sp-yida-summary">共 {{ plan.evidence.rowCount }} 行；计划创建 {{ plan.evidence.plannedCreate }}；无效 {{ plan.evidence.invalid }}；本地重复键 {{ plan.evidence.duplicateKeyCount }}。远端未核验，不会写入宜搭。</p>
        <p v-if="previewBlockedReason" data-testid="sp-yida-preview-blocked">还不能保存：{{ previewBlockedReason }}</p>
        <details>
          <summary>逐行结果</summary>
          <ol><li v-for="row in plan.rows" :key="row.index" :data-testid="`sp-yida-result-row-${row.index}`">{{ row.index + 1 }}. {{ row.status === 'planned_create' ? '计划创建' : '无效' }}<span v-if="row.issues.length">：{{ row.issues.map(rowIssueReason).join('；') }}</span></li></ol>
        </details>
      </section>
    </fieldset>

    <!-- ── 第 4 步：保存启用 ── -->
    <fieldset v-if="state?.status !== 'initialized'" class="sp-yida-setup__step" data-testid="sp-yida-save" :disabled="busy || invalidated || uncertain">
      <legend>4 保存启用</legend>
      <p>保存后，凭据由服务器加密封存，这张表单占用一个永久槽位（不能改、删或换表单）；保存不发送任何数据。规则草稿会同时自动存档（下载一份 JSON）。</p>
      <label>人工审核编号<span class="sp-yida-setup__req" aria-hidden="true">*</span><input :value="reviewRef" data-testid="sp-yida-review" autocomplete="off" @input="setText('review', $event)"></label>
      <label v-if="testedPairMismatch"><input :checked="overrideTested" type="checkbox" data-testid="sp-yida-connection-override" @change="setOverride">不重新测试，仍按当前 appKey/appSecret 保存（owner 明确决定）</label>
      <label><input :checked="acknowledged" type="checkbox" data-testid="sp-yida-ack" @change="setAcknowledgement">我已人工核对表单与执行身份，确认这张表单永久占用一个槽位；此操作不发送。</label>
      <button type="button" class="sp-yida-setup__primary" data-testid="sp-yida-save-submit" :disabled="!maySave" @click="save">保存启用</button>
      <p v-if="saveBlockedReason" data-testid="sp-yida-save-blocked">暂不能保存：{{ saveBlockedReason }}</p>
    </fieldset>
    <section v-else-if="state.draft" data-testid="sp-yida-initialized">
      <h4>已保存启用</h4>
      <p>本地配置已初始化；canSend=false，未签发令牌，未写宜搭。目标：{{ state.draft.targetRef }}；草稿 {{ state.draft.rowCount }} 行。</p>
      <p v-if="archivedName" data-testid="sp-yida-archived">规则草稿已自动存档：{{ archivedName }}</p>
    </section>
    <details v-if="ruleArchiveText" data-testid="sp-yida-rule-archive">
      <summary>规则草稿（只读，自动存档的内容）</summary>
      <textarea :value="ruleArchiveText" readonly rows="6" spellcheck="false" data-testid="sp-yida-rule-archive-text"></textarea>
    </details>

    <section v-if="state?.status === 'initialized' && (state.sendEnabled || ownerSendOpen)" data-testid="sp-yida-owner-entry">
      <p>以下是独立的服务器确认流程，仅当前目标的 owner 且具备集成管理员权限可用；本页预演不是发送许可。</p>
      <p v-if="!persistentInput" data-testid="sp-yida-owner-needs-preview">单行发送确认需要本页的预演结果：请先在第 3 步预演一次。</p>
      <button v-if="!ownerSendOpen" type="button" data-testid="sp-yida-owner-open" :disabled="!persistentInput" @click="ownerSendOpen = true">打开单行 CREATE 确认（服务器已开通）</button>
      <StockPreparationYidaOwnerSendPanel v-if="ownerSendOpen" :draft-input="persistentInput" :multi-target="state.multiTargetEnabled" @locked-change="ownerSendLocked = $event" />
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { buildYidaStaticPlan, createYidaProtocolExample, parseYidaStaticRows, validateYidaStaticConfig, YidaStaticPlanError, type YidaProtocolConfig, type YidaStaticPlan, type YidaStaticRowIssue } from '../../../../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'
import { buildYidaProjectAllocationPreview, YidaAllocationError, type YidaProjectAllocationPreview } from '../../../../../../plugins/plugin-integration-core/lib/stock-preparation-yida-allocation.mjs'
import { exportYidaRuleTemplate } from '../../../../../../plugins/plugin-integration-core/lib/yida-rule-template.mjs'
import StockPreparationYidaOwnerSendPanel from './StockPreparationYidaOwnerSendPanel.vue'
import { createYidaInitializationClient, YidaInitializationClientError, yidaCredentialHasInnerBlank,
  type YidaConnectionTestOutcome, type YidaConnectionTestResult, type YidaFormFieldDefinition, type YidaInitializationMaterial, type YidaInitializationState } from '../../../services/integration/yidaInitialization'
import type { YidaOwnerDraftInput } from '../../../services/integration/yidaOwner'
import { blankMappingRow, buildYidaSetupConfig, defaultMappingRows, mappableYidaFields, STOCK_PREP_YIDA_SOURCE_FIELDS,
  stockPrepYidaSourceField, yidaComponentLabel, yidaControlOf, type YidaSetupMappingRow } from '../../../services/integration/yidaSetupMapping'

type AllocationMode = 'original' | 'equal_integer' | 'equal_decimal_exact'
const sourceFields = STOCK_PREP_YIDA_SOURCE_FIELDS
const secretFields = ['appKey', 'appSecret', 'systemToken'] as const
type SecretField = typeof secretFields[number]

// ── form info and credentials (browser memory only) ────────────────────────────────────────────────
const appType = ref(''), formUuid = ref(''), organizationId = ref(''), reviewRef = ref(''), acknowledged = ref(false)
const material = reactive<Record<keyof YidaInitializationMaterial, string>>({ appKey: '', appSecret: '', systemToken: '', userId: '' })
// appKey/appSecret/systemToken go out without surrounding whitespace (a paste often brings a hidden line break; the
// server refuses padding). The inner text is never changed: whitespace or an invisible character inside blocks sending.
function sendable(field: SecretField): string { return material[field].trim() }
const blockedFields = computed(() => secretFields.filter(field => yidaCredentialHasInnerBlank(material[field])))
function clearPrivate(): void {
  for (const field of Object.keys(material) as Array<keyof YidaInitializationMaterial>) material[field] = ''
  reviewRef.value = ''; acknowledged.value = false
  forgetTestedPair()
}

// ── server status: read automatically, never a step ─────────────────────────────────────────────────
const state = shallowRef<YidaInitializationState | null>(null)
const commandId = ref<string | null>(null)
const busy = ref(false), uncertain = ref(false), invalidated = ref(false), errorCode = ref(''), probeErrorCode = ref('')
const retriesLeft = ref(0)
let retryTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0
let client: ReturnType<typeof createYidaInitializationClient> | null = null
const formFieldsReadOn = computed(() => state.value?.formFieldsReadEnabled === true)
const formLocked = computed(() => busy.value || invalidated.value || uncertain.value || state.value?.status === 'initialized' || ownerSendLocked.value)
// Steps 2 and 3 are local only (no request, no credential): they stay editable while the status is being read.
const localLocked = computed(() => state.value?.status === 'initialized' || ownerSendLocked.value)

function invalidateSession(code?: string): void {
  generation += 1; client?.dispose(); client = null; clearRetry()
  clearPrivate(); state.value = null; commandId.value = null
  busy.value = false; uncertain.value = false; invalidated.value = true; probeErrorCode.value = ''
  errorCode.value = code ?? 'YIDA_INITIALIZATION_SESSION_CHANGED'
}
function sessionClient(): ReturnType<typeof createYidaInitializationClient> {
  if (invalidated.value) throw new YidaInitializationClientError('YIDA_INITIALIZATION_SESSION_CHANGED')
  if (!client) client = createYidaInitializationClient({ onInvalidated: invalidateSession })
  client.assertCurrentSession()
  return client
}
function editAllowed(): boolean {
  if (busy.value || uncertain.value || invalidated.value || state.value?.status === 'initialized') return false
  try { sessionClient(); return true } catch { clearPrivate(); return false }
}
function setMaterial(field: keyof YidaInitializationMaterial, event: Event): void {
  if (editAllowed()) material[field] = (event.target as HTMLInputElement).value
}
function pasteMaterial(field: keyof YidaInitializationMaterial, event: ClipboardEvent): void {
  event.preventDefault()
  if (editAllowed() && event.clipboardData) material[field] = event.clipboardData.getData('text')
}
function setText(field: 'review' | 'organization', event: Event): void {
  if (!editAllowed()) return
  const value = (event.target as HTMLInputElement).value
  if (field === 'review') reviewRef.value = value
  else organizationId.value = value
}
function setAcknowledgement(event: Event): void { if (editAllowed()) acknowledged.value = (event.target as HTMLInputElement).checked }
function clearRetry(): void { if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null } }
// After an unconfirmed POST or a failed read the page re-reads by itself (2 s, 5 s, 10 s); only then does it
// offer one 「重新读取状态」 button. A read never allocates a new command and never infers absence.
const RETRY_DELAYS = [2000, 5000, 10000]
function scheduleRetry(): void {
  clearRetry()
  if (invalidated.value || retriesLeft.value <= 0) return
  const delay = RETRY_DELAYS[RETRY_DELAYS.length - retriesLeft.value]
  retriesLeft.value -= 1
  retryTimer = setTimeout(() => { retryTimer = null; void refresh(false) }, delay)
}
async function refresh(manual = true): Promise<void> {
  if (busy.value || invalidated.value) return
  if (manual) retriesLeft.value = 0
  clearRetry()
  const active = generation
  busy.value = true; errorCode.value = ''; probeErrorCode.value = ''
  const wasUncertain = uncertain.value
  uncertain.value = true
  try {
    const result = await sessionClient().observe()
    if (active !== generation) return
    // A different command means a different slot state: what was typed for the old one is dropped.
    if (commandId.value !== null && result.commandId !== commandId.value) clearPrivate()
    commandId.value = result.commandId; state.value = result; uncertain.value = false; retriesLeft.value = 0
    if (result.status === 'initialized') clearPrivate()
  } catch (error) {
    if (active !== generation) return
    errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'
    // A read that never answered leaves the earlier knowledge as it was (unknown stays unknown).
    uncertain.value = wasUncertain || state.value === null
    scheduleRetry()
  } finally { if (active === generation) busy.value = false }
}
const showStatusRetry = computed(() => !invalidated.value && !busy.value && retriesLeft.value === 0 && retryTimer === null
  && (uncertain.value || state.value === null) && errorCode.value !== '')
const statusText = computed(() => {
  if (invalidated.value) return errorCode.value.endsWith('_DENIED') ? '当前登录账号不是宜搭锚点 owner 或没有权限；请用锚点 owner 账号登录。' : '登录会话已变化；请刷新页面。'
  if (busy.value && state.value === null) return '正在读取服务器状态…'
  if (uncertain.value) return '服务器状态未确认，系统正在自动重新读取；确认之前不能保存。'
  if (!state.value) return '尚未读到服务器状态。'
  if (state.value.status === 'initialized') return '这张表单已保存启用。'
  return '服务器已就绪：可以填写表单信息并测试连接。'
})

// ── 测试连接 (+ form fields) ────────────────────────────────────────────────────────────────────────
const outcomeCopy: Readonly<Record<YidaConnectionTestOutcome, string>> = Object.freeze({
  ok: 'appKey/appSecret 有效：钉钉发了令牌（令牌已在服务器丢弃）。',
  upstream_rejected: '钉钉有应答但没有发令牌：最常见是 appKey/appSecret 不匹配，也可能是限流或网络中间设备拦截，系统无法区分。',
  unreachable: '连不上钉钉：DNS、TLS、建立连接或重定向失败；出网被防火墙丢弃也显示为这一类。与凭据无关。',
  timeout: '已连上但 12 秒内钉钉没有应答：可能是钉钉或中间网络慢；与凭据无关。',
})
const refusalHints: Readonly<Record<string, string>> = Object.freeze({
  YIDA_CONNECTION_TEST_DISABLED: '服务器的测试连接（或读取表单字段）开关现在是关的；系统已重新读取状态。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_DENIED: '服务器拒绝：当前登录不是部署指定的 owner、租户不符或已无管理员权限；本页材料已清空。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_CONFLICT: '另一次测试正在进行，或这张表单已保存启用；系统已重新读取状态。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_THROTTLED: '两次测试至少间隔约 5 秒，请稍候再点。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_INPUT: '服务器拒绝了请求格式（appType/formUuid 只能含字母、数字、下划线、连字符；userId 不能有首尾空白）。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_INACTIVE: '服务器上的测试连接组件没有启用（插件未加载，或安装包缺少探针组件）。请稍后重试一次，仍然出现再请服务器操作员检查。',
  YIDA_CONNECTION_TEST_CANCELLED: '服务器中途取消了本次测试；无法确定钉钉是否已收到请求，令牌不会被保留。可稍后重试。',
  YIDA_CONNECTION_TEST_UNAVAILABLE: '服务器未能完成本次测试；无法确定钉钉是否已收到请求，令牌不会被保留。请稍后重试一次。',
  YIDA_INITIALIZATION_CANCELLED: '页面 15 秒内没有收到服务器答复，已停止等待；无法确定钉钉是否已收到请求。可稍后重试。',
  YIDA_INITIALIZATION_UNAVAILABLE: '没有收到服务器的有效答复（网络或服务器故障）。可稍后重试。',
})
const saveHints: Readonly<Record<string, string>> = Object.freeze({
  YIDA_INITIALIZATION_ENCRYPTION_NOT_READY: '本次保存未写入数据：服务器的 ENCRYPTION_KEY / ENCRYPTION_SALT 未正确配置（为空、相同或用了默认值）。请服务器操作员按安装手册配置并重启后端，然后重新填写并保存。',
})
const errorHint = computed(() => {
  if (errorCode.value === '') return ''
  if (errorCode.value.startsWith('YIDA_CONNECTION_TEST_') || errorCode.value === probeErrorCode.value) return refusalHints[errorCode.value] ?? ''
  return saveHints[errorCode.value] ?? ''
})
// The pair sent for the shown outcome and the pair that got 'ok' are NON-reactive copies, never exposed to the
// template or devtools state; only a version counter is reactive.
const connectionOutcome = ref<YidaConnectionTestOutcome | ''>(''), overrideTested = ref(false), testedVersion = ref(0)
let testedPair: { appKey: string; appSecret: string } | null = null
let outcomePair: { appKey: string; appSecret: string } | null = null
const formRead = shallowRef<NonNullable<YidaConnectionTestResult['formRead']> | null>(null)
const fieldsFor = ref<{ appType: string; formUuid: string } | null>(null)
const yidaFields = shallowRef<readonly YidaFormFieldDefinition[]>([])
function forgetTestedPair(): void { testedPair = null; outcomePair = null; testedVersion.value += 1; overrideTested.value = false; connectionOutcome.value = ''; formRead.value = null }
const testedPairMismatch = computed(() => testedVersion.value >= 0 && testedPair !== null
  && (testedPair.appKey !== sendable('appKey') || testedPair.appSecret !== sendable('appSecret')))
const shownOutcome = computed(() => testedVersion.value >= 0 && outcomePair !== null
  && outcomePair.appKey === sendable('appKey') && outcomePair.appSecret === sendable('appSecret') ? connectionOutcome.value : '')
const shownFormOutcome = computed(() => shownOutcome.value !== '' && formRead.value !== null ? formRead.value.outcome : '')
const fieldsStale = computed(() => fieldsFor.value !== null && (fieldsFor.value.appType !== appType.value.trim() || fieldsFor.value.formUuid !== formUuid.value.trim()))
const formReadCopy = computed(() => {
  const read = formRead.value
  if (!read) return ''
  if (read.outcome === 'ok') {
    const usable = mappableYidaFields(read.fields).length
    return `已读到这张表单的 ${read.fields.length} 个字段（可映射 ${usable} 个），第 2 步可直接选择。这也说明 systemToken、userId、appType、formUuid 能读取这张表单；写入权限要到首次发送才验证。`
  }
  if (read.outcome === 'not_attempted') return 'appKey/appSecret 没通过，未读取表单字段。'
  if (read.outcome === 'upstream_rejected') return '钉钉拒绝了读取表单字段：常见原因是钉钉应用没有开通「宜搭表单数据读权限」、systemToken 或 userId 不对、appType/formUuid 填错，或 userId 没有这个宜搭应用的权限；系统无法区分。'
  if (read.outcome === 'unreachable') return '读取表单字段时连不上钉钉；与凭据无关，可稍后重试。'
  return '读取表单字段超时（12 秒内没有应答）；可稍后重试。'
})
watch([() => material.appKey, () => material.appSecret], () => { overrideTested.value = false }, { flush: 'sync' })
const formTargetReady = computed(() => /^[A-Za-z0-9_-]{1,128}$/u.test(appType.value.trim()) && /^[A-Za-z0-9_-]{1,128}$/u.test(formUuid.value.trim())
  && sendable('systemToken').length > 0 && material.userId.length > 0 && material.userId.trim() === material.userId)
const connectionTestBlockedReason = computed(() => {
  if (state.value?.status === 'initialized') return '这张表单已保存启用；测试连接只在保存之前可用。'
  if (invalidated.value) return ''
  if (busy.value) return '请求进行中，请稍候。'
  if (uncertain.value || !state.value || !commandId.value) return '服务器状态还没确认，系统正在读取。'
  if (state.value.connectionTestEnabled !== true) return '服务器未开启测试连接：请服务器管理员在 docker\\app.env 打开测试开关并用包内脚本重启后端，本页会在重新打开时读到新状态。'
  if (material.appKey.trim().length === 0 || material.appSecret.trim().length === 0) return '请先填写 appKey 和 appSecret。'
  if (blockedFields.value.some(field => field === 'appKey' || field === 'appSecret')) return 'appKey 或 appSecret 含不可发送的字符。'
  if (formFieldsReadOn.value && !formTargetReady.value) return '读取表单字段还需要 appType、formUuid、systemToken 和 userId（userId 不能有首尾空白）。'
  if (formFieldsReadOn.value && blockedFields.value.includes('systemToken')) return 'systemToken 含不可发送的字符。'
  return ''
})
const mayTestConnection = computed(() => connectionTestBlockedReason.value === '' && !invalidated.value)
async function testConnection(): Promise<void> {
  if (!mayTestConnection.value || !commandId.value) return
  const active = generation
  const sent = { appKey: sendable('appKey'), appSecret: sendable('appSecret') }
  const target = formFieldsReadOn.value ? { appType: appType.value.trim(), formUuid: formUuid.value.trim(), systemToken: sendable('systemToken'), userId: material.userId } : null
  busy.value = true; errorCode.value = ''; probeErrorCode.value = ''; forgetTestedPair()
  let refreshAfter = false
  try {
    const tested = await sessionClient().testConnection({ commandId: commandId.value, mode: 'candidate', material: { ...sent }, ...(target ? { form: { ...target } } : {}) })
    if (active !== generation) return
    connectionOutcome.value = tested.outcome; outcomePair = { ...sent }
    if (tested.outcome === 'ok') testedPair = { ...sent }
    if (tested.formRead && target) {
      formRead.value = tested.formRead
      if (tested.formRead.outcome === 'ok') {
        yidaFields.value = tested.formRead.fields; fieldsFor.value = { appType: target.appType, formUuid: target.formUuid }
        adoptFields(tested.formRead.fields)
      }
    }
    testedVersion.value += 1
  } catch (error) {
    if (active === generation) {
      errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'
      probeErrorCode.value = errorCode.value
      refreshAfter = errorCode.value === 'YIDA_CONNECTION_TEST_DISABLED' || errorCode.value === 'YIDA_CONNECTION_TEST_CONFLICT'
    }
  } finally { if (active === generation) busy.value = false }
  // The page re-reads the status itself where the old flow said 「请手动 GET」; typed values are kept.
  if (refreshAfter && active === generation) { const code = errorCode.value; await refresh(false); if (!errorCode.value) { errorCode.value = code; probeErrorCode.value = code } }
}
function setOverride(event: Event): void { if (editAllowed()) overrideTested.value = (event.target as HTMLInputElement).checked }

// ── 字段映射 ───────────────────────────────────────────────────────────────────────────────────────
const mappingRows = reactive<YidaSetupMappingRow[]>(defaultMappingRows([]))
const manualTargets = computed(() => yidaFields.value.length === 0 || fieldsStale.value)
const mappable = computed(() => mappableYidaFields(yidaFields.value))
function componentLabel(name: string): string { return yidaComponentLabel(name) }
// A fresh field list fills in only the rows the operator has not chosen yet, and drops a choice that is not on this form.
function adoptFields(fields: readonly YidaFormFieldDefinition[]): void {
  const ids = new Set(mappableYidaFields(fields).map(field => field.fieldId))
  const defaults = defaultMappingRows(fields)
  for (const row of mappingRows) {
    if (row.target && !ids.has(row.target)) row.target = ''
    if (!row.target) {
      const match = defaults.find(candidate => candidate.source === row.source && candidate.target && !mappingRows.some(other => other.target === candidate.target))
      if (match) { row.target = match.target; row.control = match.control }
    } else {
      const field = fields.find(candidate => candidate.fieldId === row.target)
      const control = field ? yidaControlOf(field.componentName) : null
      if (control) row.control = control
    }
  }
}
function sourceOptions(index: number) {
  return sourceFields.filter(field => field.source === mappingRows[index]?.source || !mappingRows.some(row => row.source === field.source))
}
function targetOptions(index: number) {
  const own = mappingRows[index]
  const source = own ? stockPrepYidaSourceField(own.source) : undefined
  return mappable.value.filter(field => {
    const control = yidaControlOf(field.componentName)
    if (source && (control === 'number') !== (source.type === 'number')) return false
    return field.fieldId === own?.target || !mappingRows.some(row => row.target === field.fieldId)
  })
}
function sourceChanged(row: YidaSetupMappingRow): void {
  const field = stockPrepYidaSourceField(row.source)
  if (field) row.yidaRequired = row.yidaRequired || field.required
  if (manualTargets.value && field) row.control = field.type === 'number' ? 'number' : row.control === 'number' ? 'text' : row.control
}
function targetChanged(row: YidaSetupMappingRow, event: Event): void {
  row.target = (event.target as HTMLSelectElement).value
  const field = yidaFields.value.find(candidate => candidate.fieldId === row.target)
  const control = field ? yidaControlOf(field.componentName) : null
  if (control) row.control = control
}
const buildResult = computed(() => buildYidaSetupConfig({ appType: appType.value, formUuid: formUuid.value, rows: mappingRows }))
const mappingIssues = computed(() => buildResult.value.ok ? [] : buildResult.value.issues)

// ── 预演 ───────────────────────────────────────────────────────────────────────────────────────────
const rowsText = ref('')
const allocationMode = ref<AllocationMode>('original')
const allocationProjectsText = ref('')
const plan = ref<YidaStaticPlan | null>(null)
const allocationPreview = ref<YidaProjectAllocationPreview | null>(null)
const previewError = ref('')
const persistentInput = ref<YidaOwnerDraftInput | null>(null)
const ownerSendOpen = ref(false), ownerSendLocked = ref(false)
function clearPreview(): void {
  plan.value = null; allocationPreview.value = null; previewError.value = ''; persistentInput.value = null
  if (!ownerSendLocked.value) ownerSendOpen.value = false
}
watch([appType, formUuid, mappingRows, rowsText, allocationMode, allocationProjectsText], clearPreview, { deep: true, flush: 'sync' })
function loadExample(): void { rowsText.value = createYidaProtocolExample('primary').text }
function rowIssueReason(issue: YidaStaticRowIssue): string {
  const labels: Record<string, string> = {
    KEY_MISSING: '业务键缺失', FIELD_REQUIRED: '必填字段缺失', FIELD_TYPE: '字段类型不符', DUPLICATE_LOCAL_KEY: '本地业务键重复',
    FIELD_OPTION_INVALID: '选项不在宜搭选项里', FIELD_NUMBER_INVALID: '数字无效',
  }
  const fields = (issue.fields ?? []).map(field => stockPrepYidaSourceField(field.source ?? '')?.label ?? field.source ?? field.target)
  return [labels[issue.code] ?? issue.code, ...fields].join('：')
}
function allocationSettings() {
  return { mode: allocationMode.value as Exclude<AllocationMode, 'original'>, projects: allocationProjectsText.value.split(/\r?\n/u),
    projectField: 'projectNo', quantityField: 'quantity' }
}
function capture(config: YidaProtocolConfig): void {
  const current = plan.value
  // R-71 ⑦.3: only a clean v2 create preview may become the initialization draft.
  if (!current || current.evidence.invalid !== 0 || current.evidence.duplicateKeyCount !== 0 || current.rows.length === 0
    || current.rows.some(row => row.status !== 'planned_create') || (allocationPreview.value?.issues.length ?? 0) !== 0) return
  persistentInput.value = JSON.parse(JSON.stringify({ config, rowsText: rowsText.value,
    allocation: allocationMode.value === 'original' ? { mode: 'original' } : allocationSettings() })) as YidaOwnerDraftInput
}
function runPreview(): void {
  clearPreview()
  const built = buildResult.value
  if (!built.ok) { previewError.value = '字段映射还没完成（见第 2 步）。'; return }
  if (rowsText.value.trim().length === 0) loadExample()
  const checked = validateYidaStaticConfig(built.config)
  if (!checked.valid) { previewError.value = `映射没有通过合同校验：${checked.issues.map(issue => issue.code).join('、')}`; return }
  const config = checked.normalized as YidaProtocolConfig
  try {
    if (allocationMode.value !== 'original') {
      const preview = buildYidaProjectAllocationPreview({ config, rowsText: rowsText.value, allocation: allocationSettings() })
      allocationPreview.value = preview; plan.value = preview.plan
    } else {
      plan.value = buildYidaStaticPlan({ config, rows: parseYidaStaticRows(rowsText.value, config) })
    }
    capture(config)
  } catch (error) {
    previewError.value = error instanceof YidaStaticPlanError || error instanceof YidaAllocationError ? `预演数据没有通过：${error.code}` : '预演数据没有通过：请检查 rows JSON。'
  }
}
const previewBlockedReason = computed(() => {
  const current = plan.value
  if (!current || persistentInput.value) return ''
  if ((allocationPreview.value?.issues.length ?? 0) !== 0) return '项目数量分配有拒因。'
  if (current.evidence.duplicateKeyCount !== 0) return `有 ${current.evidence.duplicateKeyCount} 行本地业务键重复。`
  if (current.evidence.invalid !== 0) return `有 ${current.evidence.invalid} 行无效（展开「逐行结果」查看原因）。`
  return '预演结果没有可创建的行。'
})

// ── 保存启用 (initialization; the rule draft is archived automatically) ───────────────────────────────
const ruleArchiveText = ref(''), archivedName = ref('')
const saveBlockedReason = computed(() => {
  if (!state.value || uncertain.value) return '服务器状态还没确认。'
  if (state.value.status !== 'ready') return ''
  if (!appType.value.trim() || !formUuid.value.trim() || !organizationId.value) return '第 1 步的表单信息没有填完。'
  if (!(['appKey', 'appSecret', 'systemToken', 'userId'] as const).every(field => material[field].trim().length > 0)) return '第 1 步的四项凭据没有填完。'
  if (blockedFields.value.length > 0) return '有凭据含不可发送的字符。'
  if (shownOutcome.value !== 'ok' && !(testedPairMismatch.value && overrideTested.value)) return '第 1 步的测试连接还没有通过。'
  if (!persistentInput.value) return '第 3 步的预演还没有通过。'
  if (!reviewRef.value) return '请填写人工审核编号。'
  if (!acknowledged.value) return '请勾选确认。'
  return ''
})
const maySave = computed(() => !busy.value && !invalidated.value && !uncertain.value && state.value?.status === 'ready'
  && !!commandId.value && saveBlockedReason.value === '' && (!testedPairMismatch.value || overrideTested.value))
function archiveRuleDraft(input: YidaOwnerDraftInput): void {
  // 「规则草稿在保存时自动存档」: the rules only (no target, rows or credential), downloaded once.
  try {
    const { target: _target, ...rules } = input.config as YidaProtocolConfig
    const chosen = input.allocation as { mode: AllocationMode; projectField?: string; quantityField?: string }
    // The rule template keeps the allocation roles, never the project list.
    const allocation = chosen.mode === 'original' ? { mode: 'original' as const }
      : { mode: chosen.mode, projectField: chosen.projectField, quantityField: chosen.quantityField }
    ruleArchiveText.value = exportYidaRuleTemplate({ rules, allocation })
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/gu, '')
    const name = `yida-rule-draft-${formUuid.value.trim()}-${stamp}.json`
    if (typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([ruleArchiveText.value], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
      URL.revokeObjectURL(url)
    }
    archivedName.value = name
  } catch { archivedName.value = '' }
}
async function save(): Promise<void> {
  if (!maySave.value || !persistentInput.value || !commandId.value) return
  const active = generation
  const draft = JSON.parse(JSON.stringify(persistentInput.value)) as YidaOwnerDraftInput
  archiveRuleDraft(draft)
  busy.value = true; uncertain.value = true; errorCode.value = ''; probeErrorCode.value = ''
  try {
    const pending = sessionClient().initialize({ commandId: commandId.value, material: { appKey: sendable('appKey'),
      appSecret: sendable('appSecret'), systemToken: sendable('systemToken'), userId: material.userId }, draft,
      attestation: { kind: 'owner-reviewed-target', reviewRef: reviewRef.value, organizationId: organizationId.value, executionIdentity: material.userId } })
    // The request owns its detached strings; the inputs no longer hold them.
    clearPrivate()
    const result = await pending
    if (active !== generation) return
    state.value = result; uncertain.value = false
  } catch (error) {
    if (active === generation) {
      errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'
      // Unknown outcome: never retried as a POST; the status is re-read until it is known.
      retriesLeft.value = RETRY_DELAYS.length
    }
  } finally { if (active === generation) { clearPrivate(); busy.value = false } }
  if (active === generation && uncertain.value) { const code = errorCode.value; await refresh(false); if (code && !errorCode.value && state.value?.status !== 'initialized') errorCode.value = code }
}

// ── step guide (display only) ───────────────────────────────────────────────────────────────────────
const stepGuide = computed(() => {
  const initialized = state.value?.status === 'initialized'
  const tested = shownOutcome.value === 'ok' && (!formFieldsReadOn.value || (formRead.value?.outcome === 'ok' && !fieldsStale.value))
  const done = [initialized || tested, initialized || buildResult.value.ok, initialized || persistentInput.value !== null, initialized]
  const current = done.indexOf(false)
  return ['表单信息与测试连接', '字段映射', '预演', '保存启用'].map((label, index) => ({ number: index + 1, label,
    state: done[index] ? 'done' : index === current ? 'current' : 'todo' }))
})

onMounted(() => {
  // Capture a real session now, so a principal change clears typed secrets even before the first read.
  try { sessionClient() } catch (error) { invalidated.value = true; errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'; return }
  retriesLeft.value = RETRY_DELAYS.length
  void refresh(false)
})
onBeforeUnmount(() => { generation += 1; clearRetry(); client?.dispose(); client = null; clearPrivate(); state.value = null; commandId.value = null })
</script>

<style scoped>
.sp-yida-setup { display: grid; gap: var(--ms-space-3); min-width: 0; padding: var(--ms-space-4); border: 1px solid var(--ms-border-light); border-radius: 8px; background: var(--ms-bg-page); }
.sp-yida-setup h3, .sp-yida-setup h4, .sp-yida-setup p { margin: 0; overflow-wrap: anywhere; }
.sp-yida-setup__steps { display: flex; flex-wrap: wrap; gap: var(--ms-space-2); margin: 0; padding: 0; list-style: none; }
.sp-yida-setup__steps li { padding: 2px 8px; border: 1px solid var(--ms-border-light); border-radius: 6px; color: var(--ms-text-3); }
.sp-yida-setup__steps li[data-state="done"] { color: var(--ms-text-2); }
.sp-yida-setup__steps li[data-state="current"] { color: var(--ms-text-1); border-color: var(--ms-color-primary); font-weight: 600; }
.sp-yida-setup__step { display: grid; gap: var(--ms-space-3); min-width: 0; margin: 0; padding: var(--ms-space-3); border: 1px solid var(--ms-border-light); border-radius: 6px; }
.sp-yida-setup__step legend { font-weight: 600; padding: 0 4px; }
.sp-yida-setup__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--ms-space-3); }
.sp-yida-setup__map-row { display: flex; flex-wrap: wrap; gap: var(--ms-space-3); align-items: end; }
.sp-yida-setup label { display: grid; gap: var(--ms-space-2); min-width: 0; }
.sp-yida-setup__wide, .sp-yida-setup textarea { width: 100%; box-sizing: border-box; }
.sp-yida-setup input, .sp-yida-setup select, .sp-yida-setup textarea, .sp-yida-setup button { font: inherit; }
.sp-yida-setup input, .sp-yida-setup select, .sp-yida-setup textarea { padding: 6px; border: 1px solid var(--ms-border-light); border-radius: 6px; }
.sp-yida-setup button { justify-self: start; padding: 6px 12px; border: 1px solid var(--ms-border-light); border-radius: 6px; background: var(--ms-bg-page); cursor: pointer; }
.sp-yida-setup__primary { border-color: var(--ms-color-primary); font-weight: 600; }
.sp-yida-setup__req { color: var(--ms-danger); margin-left: 2px; }
.sp-yida-setup__note { color: var(--ms-text-3); }
.sp-yida-setup__error { color: var(--ms-danger); }
.sp-yida-setup details { display: grid; gap: var(--ms-space-2); }
</style>

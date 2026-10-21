<template>
  <section class="sp-yida-auto" data-testid="sp-yida-auto-panel">
    <h4>宜搭有限自动授权（默认不发送）</h4>
    <p>项目 {{ projectNo || '未选择' }}。只使用服务端草稿与逐行预览；不是任意项目授权。每行最多一次创建尝试，最多十行、十五分钟。K3 永久不写回。</p>
    <p>登记授权不代表已发送、定时已恢复或业务成功。发送开关与当前权限、版本、材料、次数均由服务器逐次重验。</p>
    <p v-if="!sheetId || !projectNo">请先打开有已核实目标表的项目。</p>
    <fieldset :disabled="busy || frozen || disabled || !sheetId || !projectNo">
      <legend>1. 选择规则与服务端草稿（不授权）</legend>
      <button type="button" data-testid="sp-yida-auto-load" @click="load">读取规则与本地初始化草稿</button>
      <label>规则<select v-model="ruleId" data-testid="sp-yida-auto-rule"><option value="">请选择</option><option v-for="rule in rules" :key="rule.id" :value="rule.id" :disabled="!rule.enabled">{{ rule.name }} · 每 {{ rule.intervalMs / 1000 }} 秒{{ rule.enabled ? '' : '（未启用）' }}</option></select></label>
      <label>新规则间隔（秒）<input v-model.number="intervalSeconds" type="number" min="1" max="86400" data-testid="sp-yida-auto-interval"></label>
      <button type="button" data-testid="sp-yida-auto-create-rule" :disabled="!!ruleCommand || !validInterval" @click="createRule">创建并启用宜搭规则（尚未授权发送）</button>
      <p v-if="draft" data-testid="sp-yida-auto-draft">已取得服务端草稿；{{ draft.rowCount }} 行，目标引用 {{ draft.targetRef }}。只可选择以下服务端成员。</p>
      <label v-for="row in draft?.rows ?? []" :key="row.rowKey"><input v-model="selectedKeys" type="checkbox" :value="row.rowKey" :data-testid="`sp-yida-auto-row-${row.index}`" :disabled="selectedKeys.length >= 10 && !selectedKeys.includes(row.rowKey)">第 {{ row.index + 1 }} 行</label>
      <button type="button" data-testid="sp-yida-auto-preview" :disabled="!selectedKeys.length || selectedKeys.length > 10" @click="previewRows">读取所有已选行的服务端预览</button>
      <p>逐行预览沿用现有手动流程的开关与 Owner 门；关闭或拒绝时不能授权，不用本地 JSON 冒充预览。</p>
    </fieldset>
    <section v-if="previews.length" data-testid="sp-yida-auto-previews">
      <h5>2. 核对有限目标与内容</h5>
      <p>以下为服务端人工登记的单一目标，不是远端业务认证。</p>
      <article v-for="(preview, index) in previews" :key="preview.rowKey"><p>已选行 {{ index + 1 }}；目标 {{ preview.target.targetRef }}；组织 {{ preview.target.organizationId }}；应用 {{ preview.target.appType }}；表单 {{ preview.target.formUuid }}；审核 {{ preview.target.reviewRef }}</p><pre>{{ JSON.stringify(preview.payload, null, 2) }}</pre></article>
      <fieldset :disabled="busy || frozen || disabled">
        <legend>明确批准范围</legend>
        <label><input v-model="allowManual" type="checkbox" data-testid="sp-yida-auto-manual">允许手动提出有限运行请求</label>
        <label><input v-model="allowInterval" type="checkbox" data-testid="sp-yida-auto-schedule">允许当前规则的定时触发</label>
        <label>有效期（秒）<input v-model.number="ttlSeconds" type="number" min="1" max="900" data-testid="sp-yida-auto-ttl"></label>
        <p>最多 {{ selectedKeys.length }} 次准入，仅限这些已核对行；失败和未知不退次数，不自动重试创建。</p>
        <label><input v-model="acknowledged" type="checkbox" data-testid="sp-yida-auto-ack">我已核对项目、目标和所有内容，明确批准所选触发类型、有限次数与期限；结果未知必须人工核对。</label>
        <button type="button" data-testid="sp-yida-auto-approve" :disabled="!canApprove" @click="approve">登记上述有限授权</button>
      </fieldset>
    </section>
    <section v-if="ruleCommand && !ruleCommandConfirmed" data-testid="sp-yida-auto-rule-uncertain">
      <p>规则创建回执未确认。不能再创建；仅可按原 slot 刷新查找，查到唯一规则才继续。</p><button type="button" :disabled="busy || disabled" @click="recoverRule">查找原规则（只读）</button>
    </section>
    <section v-if="approvalCommand && !grant" data-testid="sp-yida-auto-approval-uncertain">
      <p>服务器可能已登记。仅保留原确认标识和全部原参数，不更换授权或自动重试。</p><button type="button" :disabled="busy || disabled" @click="approve">手动核对原确认</button>
    </section>
    <section v-if="!approvalCommand && !grant">
      <label>已有授权记录标识<input v-model="restoreId" data-testid="sp-yida-auto-restore-id" :disabled="busy"></label>
      <button type="button" data-testid="sp-yida-auto-restore" :disabled="busy || !restoreId" @click="restore">仅查看原记录（不恢复定时资格）</button>
    </section>
    <section v-if="grant" data-testid="sp-yida-auto-grant">
      <h5>3. 持久记录（登记不等于发送）</h5>
      <p>授权记录 {{ grant.grantId }}；状态 {{ grant.status }}；已准入 {{ grant.usedExecutions }}/{{ grant.maxExecutions }}；到期 {{ new Date(grant.expiresAt).toISOString() }}。历史回执不恢复已停用的定时资格。</p>
      <button type="button" :disabled="busy" data-testid="sp-yida-auto-refresh" @click="refresh">手动查看持久记录</button>
      <button type="button" :disabled="busy || grant.revoked" data-testid="sp-yida-auto-revoke" @click="revoke">撤销此授权</button>
      <p v-if="grant.revoked">已撤销；已发出的远端请求仍可能在途，撤销不等于远端撤回。</p>
      <button v-if="grant.revoked" type="button" :disabled="busy" @click="reset">清除本页状态（不删除授权历史）</button>
      <button v-if="approvalCommand?.allowedTriggers.includes('manual')" type="button" :disabled="busy || !mayRequest" data-testid="sp-yida-auto-request" @click="request">{{ requestCommand && !requestAccepted ? '用原请求键核对（不新增）' : '明确提出下一行运行请求（不代表成功）' }}</button>
      <p v-if="requestCommand && !requestAccepted" data-testid="sp-yida-auto-request-uncertain">提交结果未确认，只能核对同一请求，不得另建请求键。</p>
      <p v-if="requestAccepted">请求已持久排队；并不代表已发送或业务创建成功，请手动刷新核对。</p>
      <ul v-if="observed"><li v-for="entry in observed.requests" :key="entry.requestId" :data-testid="`sp-yida-auto-result-${entry.rowOrdinal}`">第 {{ entry.rowOrdinal + 1 }} 行：{{ resultLabel(entry.status, entry.ledgerStatus) }}</li></ul>
      <p>发送中、结果未知或未确认的记录禁止重试 CREATE；协议 ACK 也不是业务成功。</p>
      <template v-for="entry in observed?.requests ?? []" :key="entry.requestId">
        <StockPreparationYidaReconciliationPanel v-if="entry.admissionId" :grant-id="grant.grantId" :request-id="entry.requestId"
          :ledger-status="entry.ledgerStatus" :scope-key="scopeKey" :disabled="disabled" />
      </template>
    </section>
    <p v-if="errorCode" role="alert" data-testid="sp-yida-auto-error">{{ errorCode }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { randomUuid } from '../../../utils/uuid'
import StockPreparationYidaReconciliationPanel from './StockPreparationYidaReconciliationPanel.vue'
import { createYidaAutomationClient, YidaAutomationClientError, type YidaAutomationRule,
  type YidaAutomationConsent, type YidaAutomationSummary, type YidaAutomationObservation } from '../../../services/integration/yidaAutomation'
import { createYidaInitializationClient, YidaInitializationClientError } from '../../../services/integration/yidaInitialization'
import { createYidaOwnerClient, YidaOwnerClientError, type YidaOwnerDraft, type YidaOwnerPreview } from '../../../services/integration/yidaOwner'

const props = defineProps<{ sheetId: string | null; projectNo: string; scopeKey: string; disabled?: boolean }>()
const emit = defineEmits<{ 'locked-change': [locked: boolean] }>()
const rules = shallowRef<readonly YidaAutomationRule[]>([]), ruleId = ref(''), draft = shallowRef<YidaOwnerDraft | null>(null)
const selectedKeys = ref<string[]>([]), previews = shallowRef<readonly YidaOwnerPreview[]>([])
const intervalSeconds = ref(60), ttlSeconds = ref(900), allowManual = ref(false), allowInterval = ref(false), acknowledged = ref(false)
const busy = ref(false), errorCode = ref(''), grant = shallowRef<YidaAutomationSummary | null>(null), observed = shallowRef<YidaAutomationObservation | null>(null)
const restoreId = ref('')
const ruleCommand = shallowRef<Readonly<{ sheetId: string; slot: string; intervalMs: number }> | null>(null), ruleCommandConfirmed = ref(false)
const approvalCommand = shallowRef<YidaAutomationConsent | null>(null), requestCommand = ref<string | null>(null), requestAccepted = ref<string | null>(null)
let generation = 0
let client: ReturnType<typeof createYidaAutomationClient> | null = null
let initial: ReturnType<typeof createYidaInitializationClient> | null = null
let owner: ReturnType<typeof createYidaOwnerClient> | null = null
const chosen = computed(() => rules.value.find(rule => rule.id === ruleId.value) ?? null)
const frozen = computed(() => !!approvalCommand.value || !!grant.value || !!ruleCommand.value && !ruleCommandConfirmed.value)
const validInterval = computed(() => Number.isSafeInteger(intervalSeconds.value) && intervalSeconds.value >= 1 && intervalSeconds.value <= 86400)
const canApprove = computed(() => !frozen.value && chosen.value?.enabled && acknowledged.value && !!draft.value
  && (allowManual.value || allowInterval.value) && Number.isSafeInteger(ttlSeconds.value) && ttlSeconds.value >= 1 && ttlSeconds.value <= 900
  && selectedKeys.value.length >= 1 && selectedKeys.value.length <= 10 && previews.value.length === selectedKeys.value.length
  && previews.value.every((row, index) => row.rowKey === selectedKeys.value[index] && row.operationId === draft.value?.operationId))
const mayRequest = computed(() => {
  if (!grant.value || grant.value.revoked || grant.value.status !== 'recorded' || Date.now() >= grant.value.expiresAt) return false
  if (requestCommand.value && !requestAccepted.value) return true // Original command only, no new authority.
  return !!observed.value && !observed.value.serialBlocked && observed.value.usedExecutions < observed.value.maxExecutions
    && observed.value.requests.every(row => row.status === 'closed_observed' && row.ledgerStatus === 'acknowledged')
})
watch(() => frozen.value || busy.value, value => emit('locked-change', value), { immediate: true, flush: 'sync' })
function reset() {
  generation++; client?.dispose(); initial?.dispose(); owner?.dispose(); client = null; initial = null; owner = null
  rules.value = []; ruleId.value = ''; draft.value = null; selectedKeys.value = []; previews.value = []
  ruleCommand.value = null; ruleCommandConfirmed.value = false; approvalCommand.value = null; requestCommand.value = null; requestAccepted.value = null
  grant.value = null; observed.value = null; restoreId.value = ''; errorCode.value = ''; acknowledged.value = false; allowManual.value = false; allowInterval.value = false; busy.value = false
}
watch(() => [props.sheetId, props.projectNo, props.scopeKey], reset, { flush: 'sync' })
watch(selectedKeys, () => { previews.value = []; acknowledged.value = false }, { deep: true, flush: 'sync' })
watch([ruleId, ttlSeconds, allowManual, allowInterval], () => { acknowledged.value = false }, { flush: 'sync' })
onBeforeUnmount(reset)
function sessions() {
  const onInvalidated = () => { reset(); errorCode.value = 'YIDA_AUTOMATION_SESSION_CHANGED' }
  client ??= createYidaAutomationClient({ onInvalidated }); initial ??= createYidaInitializationClient({ onInvalidated }); owner ??= createYidaOwnerClient({ onInvalidated })
  return { client, initial, owner }
}
async function perform<T>(work: (s: ReturnType<typeof sessions>) => Promise<T>, apply: (result: T) => void) {
  if (busy.value) return
  const started = generation; busy.value = true; errorCode.value = ''
  try { const result = await work(sessions()); if (started === generation) apply(result) }
  catch (error) { if (started === generation) errorCode.value = error instanceof YidaAutomationClientError || error instanceof YidaInitializationClientError
    || error instanceof YidaOwnerClientError ? error.code : 'YIDA_AUTOMATION_UNAVAILABLE' }
  finally { if (started === generation) busy.value = false }
}
async function load() {
  if (frozen.value || props.disabled || !props.sheetId || !props.projectNo) return
  const sheetId = props.sheetId
  await perform(async s => ({ rules: await s.client.listRules(sheetId), state: await s.initial.observe() }), result => {
    rules.value = result.rules; ruleId.value = ''; selectedKeys.value = []; previews.value = []
    draft.value = result.state.status === 'initialized' ? result.state.draft : null
  })
}
async function createRule() {
  if (frozen.value || ruleCommand.value || props.disabled || !props.sheetId || !props.projectNo || !validInterval.value) return
  ruleCommand.value = Object.freeze({ sheetId: props.sheetId, slot: randomUuid(), intervalMs: intervalSeconds.value * 1000 })
  const command = ruleCommand.value
  await perform(s => s.client.createRule(command.sheetId, command.slot, command.intervalMs), saved => {
    rules.value = Object.freeze([...rules.value.filter(row => row.id !== saved.id), saved]); ruleId.value = saved.id; ruleCommandConfirmed.value = true
  })
}
async function recoverRule() {
  if (!ruleCommand.value || props.disabled) return
  const command = ruleCommand.value
  await perform(s => s.client.listRules(command.sheetId), values => {
    const matches = values.filter(row => row.slot === command.slot && row.intervalMs === command.intervalMs && row.enabled)
    if (matches.length !== 1) { errorCode.value = 'YIDA_AUTOMATION_RULE_UNCONFIRMED'; return }
    rules.value = values; ruleId.value = matches[0].id; ruleCommandConfirmed.value = true
  })
}
async function previewRows() {
  if (frozen.value || props.disabled || !draft.value || selectedKeys.value.length < 1 || selectedKeys.value.length > 10) return
  const keys = [...selectedKeys.value], snapshot = draft.value
  previews.value = []; acknowledged.value = false
  if (keys.some(key => !snapshot.rows.some(row => row.rowKey === key))) return
  await perform(async s => {
    const values: YidaOwnerPreview[] = []
    for (const rowKey of keys) values.push(await s.owner.preview({ operationId: snapshot.operationId, rowKey }))
    // The draft uses a local-unverified 091 identity, not the approved 090
    // target identity. Compare actual server previews with each other; each
    // preview's operation/member is independently checked by the real client.
    if (values.some(row => row.target.targetRef !== values[0].target.targetRef || row.planDigest !== values[0].planDigest
      || row.target.reviewRef !== values[0].target.reviewRef || row.target.organizationId !== values[0].target.organizationId
      || row.target.appType !== values[0].target.appType || row.target.formUuid !== values[0].target.formUuid)) throw new YidaAutomationClientError('YIDA_AUTOMATION_RESPONSE_INVALID')
    return Object.freeze(values)
  }, values => { previews.value = values })
}
async function approve() {
  if (props.disabled || busy.value || grant.value) return
  if (!approvalCommand.value) {
    if (!canApprove.value || !chosen.value || !draft.value) return
    approvalCommand.value = Object.freeze({ confirmationId: randomUuid(), ruleId: chosen.value.id, expectedRuleRevision: chosen.value.revision,
      actionId: chosen.value.slot, projectNo: props.projectNo, operationId: draft.value.operationId, rowKeys: Object.freeze([...selectedKeys.value]),
      allowedTriggers: Object.freeze([...(allowManual.value ? ['manual' as const] : []), ...(allowInterval.value ? ['schedule.interval' as const] : [])]),
      maxExecutions: selectedKeys.value.length, ttlMs: ttlSeconds.value * 1000 })
  }
  const command = approvalCommand.value
  await perform(s => s.client.createApproval(command), saved => { grant.value = saved; observed.value = null })
}
async function refresh() {
  if (!grant.value) return
  const id = grant.value.grantId
  await perform(s => s.client.inspect(id), saved => {
    grant.value = saved; observed.value = saved
    if (requestAccepted.value && saved.requests.some(row => row.requestId === requestAccepted.value && row.status === 'closed_observed' && row.ledgerStatus === 'acknowledged')) {
      requestCommand.value = null; requestAccepted.value = null
    }
  })
}
async function restore() {
  if (grant.value || approvalCommand.value || !restoreId.value) return
  const id = restoreId.value
  await perform(s => s.client.inspect(id), saved => { grant.value = saved; observed.value = saved })
}
async function revoke() {
  if (!grant.value || grant.value.revoked) return
  const id = grant.value.grantId
  await perform(s => s.client.revoke(id), saved => { grant.value = saved })
}
async function request() {
  if (busy.value || !mayRequest.value || !grant.value || !approvalCommand.value?.allowedTriggers.includes('manual') || Date.now() >= grant.value.expiresAt) return
  requestCommand.value ??= randomUuid()
  const id = grant.value.grantId, key = requestCommand.value
  await perform(s => s.client.requestManual(id, key), accepted => { requestAccepted.value = accepted.requestId; observed.value = null })
}
function resultLabel(status: string, ledger: string | null): string {
  if (status === 'closed_observed' && ledger === 'acknowledged') return '已收到协议 ACK，业务成功尚未核验'
  if (ledger === 'outcome_unknown' || ledger === 'dispatching' || status === 'closed_unknown') return '结果未确认，禁止再次 CREATE，需人工核对'
  if (status === 'closed_not_sent' && ledger === 'not_sent') return '记录为未发送；不得自动重试或恢复次数'
  return '已排队或处理中，尚无业务成功证据'
}
</script>

<style scoped>
.sp-yida-auto, .sp-yida-auto fieldset { display: grid; gap: var(--ms-space-3); min-width: 0; }
.sp-yida-auto { padding: var(--ms-space-3); border: 1px solid var(--ms-border-light); border-radius: 6px; }
.sp-yida-auto p, .sp-yida-auto h4, .sp-yida-auto h5 { margin: 0; overflow-wrap: anywhere; }
.sp-yida-auto label { display: flex; flex-wrap: wrap; gap: var(--ms-space-2); align-items: center; }
.sp-yida-auto button, .sp-yida-auto input, .sp-yida-auto select { font: inherit; padding: 6px; }
.sp-yida-auto button { justify-self: start; }
.sp-yida-auto pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

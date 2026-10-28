<template>
  <section class="sp-yida-initialization" data-testid="stock-prep-yida-initialization-panel">
    <h4>宜搭本地初始化（不发送）</h4>
    <p>发送开关关闭时也可独立配置；服务器仍核部署指定 owner、租户及实时权限。初始化本身不交换令牌，不查询宜搭，不授权发送。</p>
    <p>先手动查看本地状态。永久单槽不可通过此页转移、清空或重建；材料仅暂存在本页，离开即清空。</p>
    <button type="button" data-testid="sp-yida-init-refresh" :disabled="busy || invalidated" @click="refresh">手动 GET 本地初始化状态</button>
    <p v-if="commandId" data-testid="sp-yida-init-command">初始化命令：{{ commandId }}</p>
    <p v-if="state?.status === 'ready' && !uncertain" data-testid="sp-yida-init-ready">已确认本地空槽；仍须填写材料并人工确认，才能手动初始化。</p>
    <p v-if="uncertain" data-testid="sp-yida-init-uncertain">状态未确认，禁止重做或换命令；仅可手动 GET 确认真实提交或回滚结果。</p>
    <fieldset v-if="state?.status !== 'initialized'" :disabled="busy || invalidated || uncertain" class="sp-yida-initialization__inputs">
      <legend>临时材料（不进入预演或导出）</legend>
      <p>粘贴会保留完整原字符串，不修剪、不截断；输入框可能不显示换行。userId 同时作为人工执行身份，须为最多 128 字符、无首尾空白或控制字符的原值。人工审核不是官方组织认证。</p>
      <label v-for="field in materialFields" :key="field">{{ field }}<input type="password" :value="material[field]" :data-testid="`sp-yida-init-${field}`" autocomplete="off" spellcheck="false" @input="setMaterial(field, $event)" @paste="pasteMaterial(field, $event)"></label>
      <label>人工审核编号<input :value="reviewRef" data-testid="sp-yida-init-review" autocomplete="off" @input="setReview('review', $event)"></label>
      <label>人工确认 organizationId<input :value="organizationId" data-testid="sp-yida-init-organization" autocomplete="off" @input="setReview('organization', $event)"></label>
      <section v-if="state?.status === 'ready' && state.connectionTestEnabled === true" class="sp-yida-initialization__connection" data-testid="sp-yida-init-connection">
        <p>测试连接（服务器已开通）：只用上面的 appKey/appSecret 向钉钉换一次令牌并当场丢弃；不写宜搭、不保存、不授权发送。须先由服务器操作员执行 bootstrap-yida-initialization-owner 建立锚点，并已手动 GET 到初始化命令。结果 ok 只证明 appKey/appSecret 是有效应用对；systemToken、userId、appType、formUuid 要到首次真实新建才知道。</p>
        <button type="button" data-testid="sp-yida-init-connection-test" :disabled="!mayTestConnection" @click="testConnection">测试连接（仅换令牌，不写表单）</button>
        <p v-if="shownOutcome" data-testid="sp-yida-init-connection-result">{{ outcomeCopy[shownOutcome] }}</p>
        <p v-if="testedPairMismatch" data-testid="sp-yida-init-connection-mismatch">已测试的凭据与当前输入不一致，请重新测试</p>
        <label v-if="testedPairMismatch"><input :checked="overrideTested" type="checkbox" data-testid="sp-yida-init-connection-override" @change="setOverride">不重新测试，仍按当前输入初始化（owner 明确决定）</label>
      </section>
      <label><input :checked="acknowledged" type="checkbox" data-testid="sp-yida-init-ack" @change="setAcknowledgement">我已人工审核目标与执行身份，确认永久单槽仅归服务器指定 owner；此操作不发送。</label>
      <button type="button" data-testid="sp-yida-init-submit" :disabled="!mayInitialize" @click="initialize">仅初始化本地材料、草稿和人工目标</button>
    </fieldset>
    <section v-if="state?.status === 'initialized' && state.draft" data-testid="sp-yida-init-initialized">
      <p>本地配置已初始化；canSend=false，tokenIssued=false，externalWriteAttempted=false。没有 grant 或发送许可。</p>
      <p>本地草稿：{{ state.draft.operationId }}；目标：{{ state.draft.targetRef }}；{{ state.draft.rowCount }} 行（仍未核验远端）。</p>
      <label>受权草稿行<select v-model="selectedRowKey" data-testid="sp-yida-init-row"><option value="">请选择</option><option v-for="row in state.draft.rows" :key="row.rowKey" :value="row.rowKey">第 {{ row.index + 1 }} 行 · {{ row.rowKey }}</option></select></label>
      <p v-if="selectedRowKey" data-testid="sp-yida-init-selected">已选择本地 rowKey：{{ selectedRowKey }}；选择不请求、不预演、不批准、不发送。</p>
    </section>
    <p v-if="errorCode" role="alert" data-testid="sp-yida-init-error">{{ errorCode }}</p>
    <p v-if="errorHint" data-testid="sp-yida-init-error-hint">{{ errorHint }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { createYidaInitializationClient, YidaInitializationClientError, type YidaConnectionTestOutcome, type YidaInitializationMaterial, type YidaInitializationState } from '../../../services/integration/yidaInitialization'
import type { YidaOwnerDraftInput } from '../../../services/integration/yidaOwner'

const props = defineProps<{ draftInput: YidaOwnerDraftInput | null }>()
const emit = defineEmits<{ 'locked-change': [locked: boolean]; 'send-enabled-change': [enabled: boolean] }>()
const materialFields = ['appKey', 'appSecret', 'systemToken', 'userId'] as const
const material = reactive<Record<keyof YidaInitializationMaterial, string>>({ appKey: '', appSecret: '', systemToken: '', userId: '' })
const reviewRef = ref(''), organizationId = ref(''), acknowledged = ref(false)
const state = shallowRef<YidaInitializationState | null>(null)
const commandId = ref<string | null>(null), selectedRowKey = ref('')
const busy = ref(false), uncertain = ref(false), invalidated = ref(false), errorCode = ref('')
// 测试连接 (display only behind the server bit). The pair sent for the shown outcome and the pair that
// got 'ok' are NON-reactive copies, never exposed to the template or devtools state; only a version
// counter is reactive. No hashing: the page may be served over plain HTTP where crypto.subtle is unavailable.
const outcomeCopy: Readonly<Record<YidaConnectionTestOutcome, string>> = Object.freeze({
  ok: 'ok：钉钉为这组 appKey/appSecret 发了令牌（令牌已在服务器丢弃）。只证明 appKey/appSecret 是有效应用对；systemToken、userId、appType、formUuid 未验证，发送所需的宜搭表单接口也要到首次真实发送才验证。',
  upstream_rejected: '钉钉有应答但没有发令牌：最常见是 appKey/appSecret 不匹配，也可能是限流、网络中间设备的拦截页或接口变更，系统无法区分。',
  unreachable: '连不上钉钉：DNS、TLS、建立连接或重定向失败；出网被防火墙静默丢弃也显示为这一类。与凭据无关。本功能与发送都不走代理，设置 HTTP(S)_PROXY 不会改变结果。',
  timeout: '已连上但 12 秒内钉钉没有应答：可能是钉钉或中间网络慢；与凭据无关。',
})
// Refusal hints, shown beside the closed code. "未向钉钉发出请求" only where the server refuses before
// any exchange (DISABLED/DENIED/CONFLICT/THROTTLED/INPUT); CANCELLED/UNAVAILABLE may come after one.
const refusalHints: Readonly<Record<string, string>> = Object.freeze({
  YIDA_CONNECTION_TEST_DISABLED: '服务器的测试连接开关现在是关的（可能刚重启）；请手动 GET 刷新状态。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_DENIED: '服务器拒绝：当前登录不是部署指定的 owner、租户不符或已无管理员权限；本页材料已清空。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_CONFLICT: '另一次测试正在进行，或初始化命令已变、本地槽已初始化；请手动 GET 刷新后再试。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_THROTTLED: '两次测试至少间隔约 5 秒，请稍候再点。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_INPUT: '服务器拒绝了输入：appKey/appSecret 不能为空白，且各不超过 4096 字符。未向钉钉发出请求。',
  YIDA_CONNECTION_TEST_INACTIVE: '服务器上的测试连接组件没有启用：插件未加载，或安装包缺少探针组件（lib/yida-connection-probe.cjs）；请服务器操作员检查。',
  YIDA_CONNECTION_TEST_CANCELLED: '服务器中途取消了本次测试（例如插件重载或服务停止）；无法确定钉钉是否已收到请求，令牌不会被保留。可稍后重试。',
  YIDA_CONNECTION_TEST_UNAVAILABLE: '服务器未能完成本次测试（例如锚点缺失、数据库过慢或探针答复异常）；无法确定钉钉是否已收到请求，令牌不会被保留。请服务器操作员查看。',
  YIDA_INITIALIZATION_CANCELLED: '页面 15 秒内没有收到服务器答复，已停止等待；无法确定钉钉是否已收到请求，令牌不会被保留。可稍后重试。',
  YIDA_INITIALIZATION_UNAVAILABLE: '没有收到服务器的有效答复（网络或服务器故障）；无法确定钉钉是否已收到请求，令牌不会被保留。可稍后重试。',
})
const connectionOutcome = ref<YidaConnectionTestOutcome | ''>(''), overrideTested = ref(false), testedVersion = ref(0)
let testedPair: { appKey: string; appSecret: string } | null = null
let outcomePair: { appKey: string; appSecret: string } | null = null
function forgetTestedPair(): void { testedPair = null; outcomePair = null; testedVersion.value += 1; overrideTested.value = false; connectionOutcome.value = '' }
const testedPairMismatch = computed(() => testedVersion.value >= 0 && testedPair !== null
  && (testedPair.appKey !== material.appKey || testedPair.appSecret !== material.appSecret))
// An outcome describes the exact pair that was sent: it is shown only while the inputs equal that pair.
const shownOutcome = computed(() => testedVersion.value >= 0 && outcomePair !== null
  && outcomePair.appKey === material.appKey && outcomePair.appSecret === material.appSecret ? connectionOutcome.value : '')
// The two YIDA_INITIALIZATION_* hints above describe the probe request only, so they need its own code.
const probeErrorCode = ref('')
const errorHint = computed(() => errorCode.value !== '' && (errorCode.value.startsWith('YIDA_CONNECTION_TEST_')
  || errorCode.value === probeErrorCode.value) ? refusalHints[errorCode.value] ?? '' : '')
// The owner override answers one mismatch only: once the inputs equal the tested pair again it is spent,
// so a later different edit needs a fresh tick.
watch(testedPairMismatch, mismatch => { if (!mismatch) overrideTested.value = false }, { flush: 'sync' })
let generation = 0
let client: ReturnType<typeof createYidaInitializationClient> | null = null
const locked = computed(() => busy.value || uncertain.value)
watch(locked, value => emit('locked-change', value), { immediate: true, flush: 'sync' })
// Only an owner-authorized reply carries the server's send switch; any cleared state reads OFF.
watch(() => state.value?.sendEnabled === true, value => emit('send-enabled-change', value), { immediate: true, flush: 'sync' })
const mayInitialize = computed(() => !busy.value && !invalidated.value && !uncertain.value && state.value?.status === 'ready'
  && !!props.draftInput && acknowledged.value && materialFields.every(field => material[field].trim().length > 0)
  && reviewRef.value.length > 0 && organizationId.value.length > 0
  && (!testedPairMismatch.value || overrideTested.value))
const mayTestConnection = computed(() => !busy.value && !invalidated.value && !uncertain.value && state.value?.status === 'ready'
  && state.value.connectionTestEnabled === true && !!commandId.value
  && material.appKey.trim().length > 0 && material.appSecret.trim().length > 0)
function clearPrivate(): void {
  for (const field of materialFields) material[field] = ''
  reviewRef.value = ''; organizationId.value = ''; acknowledged.value = false
  forgetTestedPair()
}
function setOverride(event: Event): void { if (editAllowed()) overrideTested.value = (event.target as HTMLInputElement).checked }
function invalidateSession(code?: string): void {
  generation += 1; client?.dispose(); client = null
  clearPrivate(); state.value = null; commandId.value = null; selectedRowKey.value = ''
  // A server DENIED keeps its own code: not owner/admin, or a token without a tenant, is not a session change.
  busy.value = false; uncertain.value = false; invalidated.value = true; probeErrorCode.value = ''
  errorCode.value = code ?? 'YIDA_INITIALIZATION_SESSION_CHANGED'
}
function sessionClient(): ReturnType<typeof createYidaInitializationClient> {
  if (invalidated.value) throw new YidaInitializationClientError('YIDA_INITIALIZATION_SESSION_CHANGED')
  if (!client) client = createYidaInitializationClient({ onInvalidated: invalidateSession })
  client.assertCurrentSession()
  return client
}
// Capture a real session while the explicitly opened component is alive, so a
// principal notification also clears typed secrets before the first GET. No IO.
try { sessionClient() } catch (error) { invalidated.value = true; errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE' }
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
function setReview(field: 'review' | 'organization', event: Event): void {
  if (!editAllowed()) return
  const value = (event.target as HTMLInputElement).value
  if (field === 'review') reviewRef.value = value
  else organizationId.value = value
}
function setAcknowledgement(event: Event): void { if (editAllowed()) acknowledged.value = (event.target as HTMLInputElement).checked }
function dropInputResult(): void {
  generation += 1; client?.dispose(); client = null; clearPrivate(); state.value = null; selectedRowKey.value = ''; busy.value = false
  // Never infer absence after an edit, and never allocate a replacement command.
  // A prior uncertain command stays frozen until another explicit GET.
}
watch(() => props.draftInput, dropInputResult, { deep: true, flush: 'sync' })
onBeforeUnmount(() => { generation += 1; client?.dispose(); client = null; clearPrivate(); state.value = null; commandId.value = null })
async function refresh(): Promise<void> {
  if (busy.value || invalidated.value) return
  const active = generation
  clearPrivate()
  busy.value = true; state.value = null; selectedRowKey.value = ''; errorCode.value = ''; probeErrorCode.value = ''; uncertain.value = true
  try {
    const result = await sessionClient().observe()
    if (active !== generation) return
    if (commandId.value !== null && result.commandId !== commandId.value) throw new YidaInitializationClientError('YIDA_INITIALIZATION_RESPONSE_INVALID')
    commandId.value = result.commandId; state.value = result; uncertain.value = false
    if (result.status === 'initialized') clearPrivate()
  } catch (error) {
    if (active === generation) errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'
  } finally { if (active === generation) busy.value = false }
}
async function testConnection(): Promise<void> {
  if (!mayTestConnection.value || !commandId.value) return
  const active = generation
  // The exact bytes sent; inputs keep them (a probe never clears secrets or sets uncertain).
  const sent = { appKey: material.appKey, appSecret: material.appSecret }
  busy.value = true; errorCode.value = ''; probeErrorCode.value = ''; forgetTestedPair()
  try {
    const tested = await sessionClient().testConnection({ commandId: commandId.value, mode: 'candidate', material: { ...sent } })
    if (active !== generation) return
    connectionOutcome.value = tested.outcome; outcomePair = { ...sent }
    if (tested.outcome === 'ok') testedPair = { ...sent }
    testedVersion.value += 1
  } catch (error) {
    if (active === generation) {
      errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'
      probeErrorCode.value = errorCode.value
    }
  } finally { if (active === generation) busy.value = false }
}
async function initialize(): Promise<void> {
  if (!mayInitialize.value || !props.draftInput || !commandId.value) return
  const active = generation
  busy.value = true; uncertain.value = true; errorCode.value = ''; probeErrorCode.value = ''
  try {
    const pending = sessionClient().initialize({ commandId: commandId.value, material: { ...material },
      draft: JSON.parse(JSON.stringify(props.draftInput)) as YidaOwnerDraftInput,
      attestation: { kind: 'owner-reviewed-target', reviewRef: reviewRef.value, organizationId: organizationId.value, executionIdentity: material.userId } })
    // The request owns its detached raw strings. Controls no longer retain them.
    clearPrivate()
    const result = await pending
    if (active !== generation) return
    state.value = result; uncertain.value = false
  } catch (error) {
    if (active === generation) errorCode.value = error instanceof YidaInitializationClientError ? error.code : 'YIDA_INITIALIZATION_UNAVAILABLE'
  } finally { if (active === generation) { clearPrivate(); busy.value = false } }
}
</script>

<style scoped>
.sp-yida-initialization, .sp-yida-initialization__inputs { display: grid; gap: var(--ms-space-3); min-width: 0; }
.sp-yida-initialization { padding: var(--ms-space-3); border: 1px solid var(--ms-border-light); border-radius: 6px; }
.sp-yida-initialization p, .sp-yida-initialization h4 { margin: 0; overflow-wrap: anywhere; }
.sp-yida-initialization label { display: grid; gap: var(--ms-space-2); }
.sp-yida-initialization input, .sp-yida-initialization select, .sp-yida-initialization button { font: inherit; padding: 6px; }
.sp-yida-initialization button { justify-self: start; }
</style>

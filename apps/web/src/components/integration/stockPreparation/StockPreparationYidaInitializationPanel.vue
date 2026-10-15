<template>
  <section class="sp-yida-initialization" data-testid="stock-prep-yida-initialization-panel">
    <h4>宜搭本地初始化（不发送）</h4>
    <p>发送开关关闭时也可独立配置；服务器仍核部署指定 owner、租户及实时权限。本页不交换令牌，不查询宜搭，不授权发送。</p>
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
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { createYidaInitializationClient, YidaInitializationClientError, type YidaInitializationMaterial, type YidaInitializationState } from '../../../services/integration/yidaInitialization'
import type { YidaOwnerDraftInput } from '../../../services/integration/yidaOwner'

const props = defineProps<{ draftInput: YidaOwnerDraftInput | null }>()
const emit = defineEmits<{ 'locked-change': [locked: boolean] }>()
const materialFields = ['appKey', 'appSecret', 'systemToken', 'userId'] as const
const material = reactive<Record<keyof YidaInitializationMaterial, string>>({ appKey: '', appSecret: '', systemToken: '', userId: '' })
const reviewRef = ref(''), organizationId = ref(''), acknowledged = ref(false)
const state = shallowRef<YidaInitializationState | null>(null)
const commandId = ref<string | null>(null), selectedRowKey = ref('')
const busy = ref(false), uncertain = ref(false), invalidated = ref(false), errorCode = ref('')
let generation = 0
let client: ReturnType<typeof createYidaInitializationClient> | null = null
const locked = computed(() => busy.value || uncertain.value)
watch(locked, value => emit('locked-change', value), { immediate: true, flush: 'sync' })
const mayInitialize = computed(() => !busy.value && !invalidated.value && !uncertain.value && state.value?.status === 'ready'
  && !!props.draftInput && acknowledged.value && materialFields.every(field => material[field].trim().length > 0)
  && reviewRef.value.length > 0 && organizationId.value.length > 0)
function clearPrivate(): void {
  for (const field of materialFields) material[field] = ''
  reviewRef.value = ''; organizationId.value = ''; acknowledged.value = false
}
function invalidateSession(): void {
  generation += 1; client?.dispose(); client = null
  clearPrivate(); state.value = null; commandId.value = null; selectedRowKey.value = ''
  busy.value = false; uncertain.value = false; invalidated.value = true; errorCode.value = 'YIDA_INITIALIZATION_SESSION_CHANGED'
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
  busy.value = true; state.value = null; selectedRowKey.value = ''; errorCode.value = ''; uncertain.value = true
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
async function initialize(): Promise<void> {
  if (!mayInitialize.value || !props.draftInput || !commandId.value) return
  const active = generation
  busy.value = true; uncertain.value = true; errorCode.value = ''
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

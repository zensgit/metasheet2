<template>
  <details class="k3-bl2-run" :data-testid="`k3-bl2-run-${row.id}`">
    <summary>按物料 ID 查唯一 BOM · 已审批 v{{ row.version }}</summary>
    <p>仅接受 K3 内部数字物料 ID（FItemID），不是物料编号或 PLM 图号。本操作不是递归 BOM 展开。</p>
    <p>绑定已保存的审批版本；将访问真实 K3，请仅在已获准的只读窗口操作。不写 K3 或内部缓存，不自动重试。</p>
    <label>K3 内部物料 ID <input v-model="key" type="text" inputmode="numeric" autocomplete="off" data-testid="k3-bl2-key" /></label>
    <button type="button" data-testid="k3-bl2-read" :disabled="!canRun || busy || !normalizedKey" @click="run">读取唯一 BOM 编号</button>
    <p v-if="key && !normalizedKey" data-testid="k3-bl2-key-invalid">请输入 1–20 位 ASCII 数字，不接受物料编号。</p>
    <p v-if="busy" role="status" data-testid="k3-bl2-busy">请求处理中。清空或切换界面不代表服务端读取已取消。</p>
    <p v-if="error" role="alert" data-testid="k3-bl2-error">{{ error }}</p>
    <div v-if="result" data-testid="k3-bl2-result"><p>本次唯一解析的 BOM 编号：</p><output data-testid="k3-bl2-value">{{ result.value }}</output></div>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onAuthPrincipalChange, onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import type { ReadSourceConfigRow } from '../../services/integration/readSourceConfigs'
import type { IntegrationScope, WorkbenchExternalSystem } from '../../services/integration/workbench'
import { K3Bl2ReadError, normalizeK3Bl2Key, readK3Bl2Bom } from '../../services/integration/k3Bl2Runs'

const props = withDefaults(defineProps<{
  row: ReadSourceConfigRow
  scope: IntegrationScope
  system?: WorkbenchExternalSystem
  hasIntegrationAdmin?: boolean
  available?: boolean
  generation?: number
}>(), { system: undefined, hasIntegrationAdmin: false, available: false, generation: 0 })

const key = ref('')
const busy = ref(false)
const result = ref<{ value: string | number } | null>(null)
const error = ref('')
let active = true
let revision = 0
const normalizedKey = computed(() => normalizeK3Bl2Key(key.value))
const canRun = computed(() => props.available && props.row.k3Bl2Eligible === true
  && props.row.status === 'approved' && props.row.version > 0
  && props.system?.id === props.row.systemId && props.system?.status === 'active'
  && props.system?.kind === 'erp:k3-wise-webapi')
function binding(): string {
  return JSON.stringify([
    props.row.id, props.row.systemId, props.row.version, props.row.contentKey, props.row.status,
    props.row.k3Bl2Eligible, props.scope.tenantId, props.scope.workspaceId,
    props.system?.id, props.system?.kind, props.system?.status,
    props.hasIntegrationAdmin, props.available, props.generation,
  ])
}
function invalidateResult(): void {
  revision += 1
  result.value = null
  error.value = ''
  // Invalidation never releases an actual outstanding request's busy slot.
}
function invalidate(): void {
  key.value = ''
  invalidateResult()
}
watch(key, invalidateResult, { flush: 'sync' })
watch(binding, invalidate, { flush: 'sync' })
const unsubscribePrincipal = onAuthPrincipalChange(invalidate)
const unsubscribeSession = onAuthSessionSwitch(invalidate)
function sessionSignature(): string {
  // Equality stamps only, not an authorization decision.
  try { return JSON.stringify([readAuthSessionSignature(), localStorage.getItem('user_permissions'), localStorage.getItem('user_roles')]) }
  catch { return 'invalid' }
}
let displayedSession = sessionSignature()
function checkSession(): void {
  const session = sessionSignature()
  if (session !== displayedSession) {
    displayedSession = session
    invalidate()
  }
}
window.addEventListener('storage', checkSession)
window.addEventListener('focus', checkSession)
onBeforeUnmount(() => {
  active = false
  invalidate()
  unsubscribePrincipal()
  unsubscribeSession()
  window.removeEventListener('storage', checkSession)
  window.removeEventListener('focus', checkSession)
})

function errorLabel(thrown: unknown): string {
  const code = thrown instanceof K3Bl2ReadError ? thrown.code : 'K3_BL2_READ_FAILED'
  if (code === 'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND') return `未找到匹配 BOM（${code}）。未自动重试。`
  if (code === 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS') return `存在多个候选或达到读取上限，不能自动选取 BOM（${code}）。`
  if (code === 'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID') return `物料 ID 必须为 1–20 位 ASCII 数字（${code}）。`
  return `唯一 BOM 读取未确认（${code}）。未展示候选数据；未自动重试。`
}

async function run(): Promise<void> {
  checkSession()
  const inputKey = normalizedKey.value
  if (!active || busy.value || !canRun.value || !inputKey) return
  const identity = binding()
  const session = sessionSignature()
  const ticket = revision
  const current = () => active && revision === ticket && binding() === identity && sessionSignature() === session
    && normalizedKey.value === inputKey && canRun.value
  // Reserve before confirmation too: a synchronous confirmation callback cannot re-enter.
  busy.value = true
  result.value = null
  error.value = ''
  try {
    if (!window.confirm('本次将按 K3 内部物料 ID 访问所选真实 K3，查找唯一 BOM 编号；不会写 K3 或内部缓存。请确认本次已获准只读访问。继续？') || !current()) return
    const response = await readK3Bl2Bom(props.row.id, inputKey, props.scope.workspaceId)
    if (current()) result.value = response
  } catch (thrown) {
    if (current()) error.value = errorLabel(thrown)
  } finally {
    checkSession()
    busy.value = false
  }
}
</script>

<style scoped>
.k3-bl2-run { padding: var(--ms-space-3); border: 1px solid var(--ms-border-color); border-radius: var(--ms-radius-md); }
.k3-bl2-run summary { cursor: pointer; font-weight: 600; }
.k3-bl2-run p { margin: var(--ms-space-2) 0; }
.k3-bl2-run output { white-space: pre-wrap; overflow-wrap: anywhere; }
.k3-bl2-run [role='alert'] { color: var(--ms-color-danger); }
</style>

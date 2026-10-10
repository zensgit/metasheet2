<template>
  <details class="k3-b4-run" :data-testid="`k3-b4-run-${row.id}`">
    <summary>运行已审批 K3 B4 v{{ row.version }}</summary>
    <p>操作绑定右侧已保存版本。将读取所选真实 K3；请在已获准的只读窗口内手动执行。</p>
    <p>租户由认证会话决定；旧会话若仅依赖租户提示头，请重新登录或显式切换组织后刷新读取源。</p>
    <p>单页只读预览最多显示 10 行，不落内部缓存；单页，不代表全量。</p>
    <div class="k3-b4-run__actions">
      <button type="button" data-testid="k3-b4-preview" :disabled="!canRun || busy" @click="run('preview')">单页只读预览</button>
      <button v-if="hasIntegrationAdmin === true" type="button" data-testid="k3-b4-sync" :disabled="!canRun || busy" @click="run('sync')">读取并尝试同步内部物料缓存（管理员）</button>
    </div>
    <p v-if="hasIntegrationAdmin === true">同步会真实读取 K3；服务器部署配置决定是否写入租户内部物料缓存及运行记录，不会写 K3。</p>
    <p v-if="busy" role="status" data-testid="k3-b4-busy">请求处理中。切换或清空界面不代表服务端操作已取消。</p>
    <p v-if="error" role="alert" data-testid="k3-b4-error">{{ error }}</p>
    <div v-if="preview" data-testid="k3-b4-preview-result">
      <p>本次单页 {{ preview.count }} 行；单页，不代表全量。未写入内部缓存。</p>
      <p v-if="preview.count === 0">本页为空，不能据此判断全部物料为空。</p>
      <p v-if="preview.capReached">已达单页 10 行上限，不能据此判断读取完整。</p>
      <table v-if="preview.rows.length" data-testid="k3-b4-preview-table">
        <thead><tr><th v-for="field in K3_B4_PREVIEW_FIELDS" :key="field">{{ field }}</th></tr></thead>
        <tbody><tr v-for="(record, index) in preview.rows" :key="index"><td v-for="field in K3_B4_PREVIEW_FIELDS" :key="field">{{ record[field] ?? '—' }}</td></tr></tbody>
      </table>
    </div>
    <div v-if="sync" data-testid="k3-b4-sync-result">
      <p v-if="sync.state === 'off'">只读验证成功；部署未开启内部同步，本次未写缓存或运行记录。</p>
      <p v-else-if="sync.state === 'on_zero'">部署已开启内部同步，但本次物料缓存未落库；运行记录可能已写入，详见计数。</p>
      <p v-else>本次已写入内部物料缓存。</p>
      <p>读取 {{ sync.pages }} 页 / {{ sync.sourceRows }} 行；物料新增 {{ sync.created }}、更新 {{ sync.patched }}、跳过 {{ sync.skipped }}；运行记录新增 {{ sync.runsCreated }}、更新 {{ sync.runsPatched }}。未写 K3。</p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onAuthPrincipalChange, onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import type { ReadSourceConfigRow } from '../../services/integration/readSourceConfigs'
import type { IntegrationScope, WorkbenchExternalSystem } from '../../services/integration/workbench'
import { K3_B4_PREVIEW_FIELDS, k3B4PreviewErrorCode, readK3B4Page, syncK3B4Materials, type K3B4Preview, type K3B4SyncSummary } from '../../services/integration/k3B4Runs'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../../services/integration/errorCodeLabels'

const props = withDefaults(defineProps<{
  row: ReadSourceConfigRow
  scope: IntegrationScope
  system?: WorkbenchExternalSystem
  hasIntegrationAdmin?: boolean
  available?: boolean
  generation?: number
}>(), { hasIntegrationAdmin: false, available: false, generation: 0, system: undefined })

const busy = ref(false)
const preview = ref<K3B4Preview | null>(null)
const sync = ref<K3B4SyncSummary | null>(null)
const error = ref('')
let active = true
let revision = 0
const canRun = computed(() => props.available && props.row.k3B4Eligible === true
  && props.row.status === 'approved' && props.row.version > 0
  && props.system?.id === props.row.systemId && props.system?.status === 'active'
  && props.system?.kind === 'erp:k3-wise-webapi')

function binding(): string {
  return JSON.stringify([
    props.row.id, props.row.systemId, props.row.version, props.row.contentKey, props.row.status,
    props.row.k3B4Eligible, props.scope.tenantId, props.scope.workspaceId,
    props.system?.id, props.system?.kind, props.system?.status,
    props.hasIntegrationAdmin, props.available, props.generation,
  ])
}
function invalidate(): void {
  revision += 1
  preview.value = null
  sync.value = null
  error.value = ''
  // The outstanding operation still owns busy until it actually settles.
}
watch(binding, invalidate, { flush: 'sync' })
const unsubscribePrincipal = onAuthPrincipalChange(invalidate)
const unsubscribeSession = onAuthSessionSwitch(invalidate)
function runSessionSignature(): string {
  // Access refreshes may revoke read permission without changing token or the admin hint.
  // These storage values are equality stamps only, never an authorization grant.
  try {
    return JSON.stringify([readAuthSessionSignature(), localStorage.getItem('user_permissions'), localStorage.getItem('user_roles')])
  } catch { return 'invalid' }
}
let displayedSession = runSessionSignature()
function checkSession(): void {
  const session = runSessionSignature()
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

async function run(kind: 'preview' | 'sync'): Promise<void> {
  checkSession()
  if (!active || busy.value || !canRun.value || (kind === 'sync' && props.hasIntegrationAdmin !== true)) return
  const identity = binding()
  const session = runSessionSignature()
  const ticket = revision
  const current = () => active && revision === ticket && binding() === identity && runSessionSignature() === session
  const confirmation = kind === 'preview'
    ? '本次将读取所选真实 K3 的一个页面（最多 10 行），不写内部缓存。请确认本次已获准真实读取；单页不代表全量。继续？'
    : '本次将真实读取所选 K3，并按服务器部署配置尝试写入租户内部物料缓存和运行记录；不会写 K3。异常时可能部分更新。请确认本次已获准读取及内部同步。继续？'
  if (!window.confirm(confirmation) || !current() || !canRun.value
    || (kind === 'sync' && props.hasIntegrationAdmin !== true)) return
  const id = props.row.id
  const workspaceId = props.scope.workspaceId
  busy.value = true
  preview.value = null
  sync.value = null
  error.value = ''
  try {
    if (kind === 'preview') {
      const result = await readK3B4Page(id, workspaceId)
      if (current()) preview.value = result
    } else {
      const runId = `k3-b4-${crypto.randomUUID()}`
      const result = await syncK3B4Materials(id, runId, workspaceId)
      if (current()) sync.value = result
    }
  } catch (failure) {
    if (current()) {
      const code = kind === 'preview' ? k3B4PreviewErrorCode(failure) : null
      const hint = code ? integrationErrorCodeHint(code, 'zh-CN') : null
      error.value = kind === 'preview'
        ? code
          ? `单页读取失败：${integrationErrorCodeDisplayLabel(code, 'zh-CN')}（${code}）。${hint ? `${hint}。` : ''}未展示业务行；未自动重试。`
          : '单页读取失败（K3_B4_READ_FAILED）。未展示业务行；未自动重试。'
        : '同步结果未确认（K3_B4_SYNC_RESULT_UNKNOWN），内部缓存或运行记录可能已部分更新。请先核查运行记录；未自动重试。'
    }
  } finally {
    checkSession()
    busy.value = false
  }
}
</script>

<style scoped>
.k3-b4-run { padding: 12px; border: 1px solid #d7dee8; border-radius: 6px; }
.k3-b4-run summary { cursor: pointer; font-weight: 600; }
.k3-b4-run p { margin: 8px 0; }
.k3-b4-run__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.k3-b4-run table { width: 100%; border-collapse: collapse; }
.k3-b4-run th, .k3-b4-run td { padding: 6px; border: 1px solid #d7dee8; text-align: left; overflow-wrap: anywhere; }
.k3-b4-run [role='alert'] { color: #b42318; }
</style>

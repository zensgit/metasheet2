<template>
  <section class="bom-bindings" data-testid="plm-bom-write-bindings" aria-labelledby="plm-bom-write-bindings-title">
    <header>
      <div>
        <h3 id="plm-bom-write-bindings-title">个人 BOM 写入授权</h3>
        <p>此授权仅用于个人 BOM 写入（bom_write），不能当作审批授权，也不会改用共享账号。</p>
      </div>
      <button type="button" :disabled="busy" data-testid="plm-bom-write-bindings-refresh" @click="load">刷新授权</button>
    </header>
    <p v-if="status" role="status" data-testid="plm-bom-write-binding-status" :class="{ error: failed }">{{ status }}</p>
    <p v-if="managementUrl">
      <a :href="managementUrl" target="_blank" rel="noopener noreferrer" data-testid="plm-bom-write-management-link">在 Yuantus 创建个人 BOM 写入授权</a>
    </p>
    <article v-for="item in rows" :key="item.id" data-testid="plm-bom-write-binding-row">
      <strong>{{ item.bound ? '已绑定' : '未绑定' }}</strong>
      <dl>
        <div><dt>已验证账号</dt><dd>{{ item.subjectId }}</dd></div>
        <div><dt>授权编号</dt><dd>{{ item.grantId }}</dd></div>
        <div><dt>代次</dt><dd>{{ item.generation }}</dd></div>
        <div><dt>到期</dt><dd>{{ item.expiresAt }}</dd></div>
      </dl>
      <p v-if="item.remoteRevokeState" data-testid="plm-bom-write-revoke-state">远程吊销状态：{{ item.remoteRevokeState }}</p>
      <p v-if="item.previousGrantRevokeState" data-testid="plm-bom-write-previous-revoke-state">先前授权吊销状态：{{ item.previousGrantRevokeState }}</p>
      <button type="button" :disabled="busy || !item.bound" data-testid="plm-bom-write-unbind" @click="unbind(item.id)">解除绑定</button>
    </article>
    <p v-if="loaded && !rows.length">此数据源尚未绑定个人 BOM 写入授权。</p>
    <p data-testid="plm-bom-write-unbind-note">解除绑定不会取消已经生效的 BOM 写入。</p>
    <p data-testid="plm-bom-write-revoke-note">重试吊销只处理已退役的授权，不会取消已经生效的写入。</p>
    <button type="button" :disabled="busy" data-testid="plm-bom-write-revoke-retry" @click="retryRevocations">重试已退役授权的吊销</button>
    <form autocomplete="off" @submit.prevent="bind">
      <label for="plm-bom-write-connection-id">连接登记标识</label>
      <input
        id="plm-bom-write-connection-id"
        v-model="connectionId"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        :spellcheck="false"
        :disabled="busy"
        data-testid="plm-bom-write-connection-id"
        required
      >
      <p>填写个人授权页上的连接登记标识。这是连接登记名，不是已验证账号、来源地址或租户。</p>
      <label for="plm-bom-write-grant">Yuantus 个人 BOM 写入授权</label>
      <input
        id="plm-bom-write-grant"
        v-model="grant"
        type="password"
        autocomplete="new-password"
        autocapitalize="off"
        :spellcheck="false"
        :disabled="busy"
        data-testid="plm-bom-write-grant"
        required
      >
      <p>仅提交给当前数据源验证。提交后输入会立即清空，授权不会留在本机。</p>
      <button type="submit" data-testid="plm-bom-write-bind" :disabled="busy || !connectionId.trim() || !grant.trim()">验证并绑定</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import {
  bindPlmBomWriteGrant,
  getPlmBomWriteManagementUrl,
  listPlmBomWriteBindings,
  PlmBomWriteBindingError,
  retryPlmBomWriteRetiredRevocations,
  unbindPlmBomWriteBinding,
  type PlmBomWriteBinding,
} from '../../services/plm/plmBomWriteBindings'

const props = defineProps<{ dataSourceId: string }>()

const rows = ref<PlmBomWriteBinding[]>([])
const managementUrl = ref('')
const connectionId = ref('')
const grant = ref('')
const busy = ref(false)
const loaded = ref(false)
const status = ref('')
const failed = ref(false)
let controller: AbortController | null = null
let generation = 0
let sourceGeneration = 0
let session = readAuthSessionSignature()

function resetForSession(): void {
  const next = readAuthSessionSignature()
  if (next === session) return
  session = next
  generation += 1
  controller?.abort()
  rows.value = []
  managementUrl.value = ''
  connectionId.value = ''
  grant.value = ''
  busy.value = false
  loaded.value = false
  status.value = '登录账号已变更，请重新打开个人 BOM 写入授权。'
  failed.value = false
}
const unsubscribe = onAuthSessionSwitch(resetForSession)

function resetForSource(): void {
  sourceGeneration += 1
  generation += 1
  controller?.abort()
  controller = null
  rows.value = []
  managementUrl.value = ''
  connectionId.value = ''
  grant.value = ''
  busy.value = false
  loaded.value = false
  status.value = ''
  failed.value = false
}

async function run(action?: (source: string, signal: AbortSignal) => Promise<string>): Promise<void> {
  const previous = session
  resetForSession()
  if (action && previous !== session) return
  if (busy.value) return
  const ownGeneration = ++generation
  const ownSourceGeneration = sourceGeneration
  const ownSource = props.dataSourceId
  const ownSession = session
  const current = () => ownGeneration === generation
    && ownSourceGeneration === sourceGeneration
    && ownSource === props.dataSourceId
    && ownSession === readAuthSessionSignature()
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  busy.value = true
  status.value = ''
  failed.value = false
  try {
    const message = action ? await action(ownSource, signal) : ''
    if (!current()) return
    const fresh = await listPlmBomWriteBindings(signal)
    if (!current()) return
    const url = await managementUrlFor(ownSource, signal)
    if (!current()) return
    rows.value = fresh.filter((row) => row.dataSourceId === ownSource)
    managementUrl.value = url
    loaded.value = true
    status.value = message
  } catch (error) {
    if (!current()) return
    rows.value = []
    managementUrl.value = ''
    loaded.value = false
    status.value = error instanceof PlmBomWriteBindingError ? error.message : '操作未完成，请稍后重试。'
    failed.value = true
  } finally {
    if (current()) busy.value = false
    resetForSession()
  }
}

// managementUrl() calls requirePlmPersonalBomWrite(). List, unbind, and revoke retry do not.
// A disabled or unavailable create URL must not hide metadata that already loaded.
// Session failure still fails closed so the previous rows are not left on screen.
async function managementUrlFor(source: string, signal: AbortSignal): Promise<string> {
  if (!source.trim()) return ''
  try {
    return await getPlmBomWriteManagementUrl(source, signal)
  } catch (error) {
    if (error instanceof PlmBomWriteBindingError && error.code !== 'PLM_BOM_WRITE_UNAUTHORIZED') return ''
    throw error
  }
}

function load(): void {
  void run()
}
function bind(): void {
  if (busy.value || !connectionId.value.trim() || !grant.value.trim()) return
  const connection = connectionId.value
  const secret = grant.value
  connectionId.value = ''
  grant.value = ''
  void run(async (source, signal) => {
    await bindPlmBomWriteGrant(source, connection, secret, signal)
    return '个人 BOM 写入授权已验证并绑定。'
  })
}
function unbind(id: string): void {
  connectionId.value = ''
  grant.value = ''
  void run(async (_source, signal) => {
    await unbindPlmBomWriteBinding(id, signal)
    return '绑定已解除。解除绑定不会取消已经生效的 BOM 写入。'
  })
}
function retryRevocations(): void {
  connectionId.value = ''
  grant.value = ''
  void run(async (_source, signal) => {
    await retryPlmBomWriteRetiredRevocations(signal)
    return '已请求重试退役授权的吊销。重试吊销不会取消已经生效的写入。'
  })
}

watch(() => props.dataSourceId, () => {
  resetForSource()
  load()
})
onMounted(() => {
  window.addEventListener('storage', resetForSession)
  load()
})
onBeforeUnmount(() => {
  generation += 1
  controller?.abort()
  connectionId.value = ''
  grant.value = ''
  rows.value = []
  managementUrl.value = ''
  unsubscribe()
  window.removeEventListener('storage', resetForSession)
})
</script>

<style scoped>
.bom-bindings { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
header { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
h3 { margin: 0; font-size: 16px; }
p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
dl { display: grid; gap: 4px; margin: 4px 0; }
dd { margin: 0; }
button { width: fit-content; }
.error { font-weight: 600; }
form { display: grid; gap: 6px; max-width: 420px; }
</style>

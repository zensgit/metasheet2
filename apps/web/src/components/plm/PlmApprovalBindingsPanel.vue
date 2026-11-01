<template>
  <section class="plm-bindings" aria-labelledby="plm-bindings-title">
    <header>
      <div>
        <h2 id="plm-bindings-title">Yuantus 审批授权</h2>
        <p>先登录 Yuantus 获取个人审批授权，再绑定到当前 MetaSheet 账号。</p>
      </div>
      <button type="button" :disabled="busy" @click="load">刷新连接</button>
    </header>
    <p v-if="status" role="status" :class="{ error: failed }">{{ status }}</p>
    <p v-if="busy" role="status">正在处理…</p>
    <template v-if="snapshot">
      <p>连接：<strong>{{ snapshot.connection.label }}</strong>（{{ snapshot.connection.id }}）</p>
      <p v-if="managementHref(snapshot)"><a :href="managementHref(snapshot)" target="_blank" rel="noopener noreferrer">在 Yuantus 创建授权</a>，然后回到此页完成绑定。</p>
      <article v-for="item in snapshot.bindings" :key="item.id">
        <strong>{{ item.bound ? '已绑定' : '已解绑' }}</strong>
        <p v-if="!item.canUse">此保存的连接当前不可用，只能解除保存的绑定。</p>
        <dl>
          <div><dt>保存的连接</dt><dd>{{ item.connectionId }}</dd></div>
          <div><dt>已验证账号</dt><dd>{{ item.subjectId }}</dd></div>
          <div><dt>租户 / 组织</dt><dd>{{ item.tenantId }} / {{ item.orgId }}</dd></div>
          <div><dt>授权到期</dt><dd>{{ new Date(item.expiresAt).toLocaleString() }}</dd></div>
        </dl>
        <p v-if="item.unresolvedCount">
          还有 {{ item.unresolvedCount }} 项操作尚未确认结果。解绑不会取消已提交的审批。
          请使用同一 Yuantus 账号、租户和组织重新绑定有效授权，再查询未结操作结果。
        </p>
        <div class="actions">
          <button type="button" :disabled="busy || !item.bound || !item.canUse" @click="sync(item.id)">同步我的审批待办</button>
          <button v-if="item.unresolvedCount" type="button" :disabled="busy || !item.bound || !item.canUse" @click="reconcile(item.id)">查询未结操作结果</button>
          <button type="button" :disabled="busy || !item.bound" @click="unbind(item.id)">解除 Yuantus 绑定</button>
        </div>
      </article>
      <p v-if="!snapshot.bindings.length">尚未绑定个人审批授权。</p>
      <form v-if="managementHref(snapshot)" autocomplete="off" @submit.prevent="bind">
        <label for="plm-personal-grant">Yuantus 个人审批授权</label>
        <input id="plm-personal-grant" v-model="grant" type="password" autocomplete="new-password" autocapitalize="off" :spellcheck="false" :disabled="busy" required>
        <p>仅提交给当前连接进行验证；提交后输入会立即清空。</p>
        <button type="submit" :disabled="busy || !grant.trim() || !managementHref(snapshot)">验证并绑定个人授权</button>
      </form>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import {
  bindPlmApprovalGrant, getPlmApprovalBindings, PlmApprovalBindingError,
  reconcilePlmApprovalCommands, syncPlmApprovalTasks, unbindPlmApprovalGrant,
  type PlmApprovalBindings,
} from '../../services/plm/plmApprovalBindings'

const snapshot = ref<PlmApprovalBindings | null>(null)
const grant = ref('')
const busy = ref(false)
const status = ref('')
const failed = ref(false)
let controller: AbortController | null = null
let generation = 0
let session = readAuthSessionSignature()

function resetForSession() {
  if (session === readAuthSessionSignature()) return
  session = readAuthSessionSignature()
  generation++
  controller?.abort()
  snapshot.value = null
  grant.value = ''
  busy.value = false
  status.value = '登录账号已变更，请刷新连接。'
  failed.value = false
}
const unsubscribe = onAuthSessionSwitch(resetForSession)

// Each mutation is followed by a fresh metadata read. Never reuse a result across account switches.
async function run(action?: (signal: AbortSignal) => Promise<string>) {
  const previousSession = session
  resetForSession()
  if (action && previousSession !== session) return
  if (busy.value) return
  const ownGeneration = ++generation
  const ownSession = session
  const current = () => ownGeneration === generation && ownSession === readAuthSessionSignature()
  controller = new AbortController()
  const signal = controller.signal
  busy.value = true
  status.value = ''
  failed.value = false
  // Drop any unsent grant before awaiting so a refreshed connection cannot submit the previous draft.
  grant.value = ''
  try {
    const message = action ? await action(signal) : ''
    if (!current()) return
    const fresh = await getPlmApprovalBindings(signal)
    if (!current()) return
    snapshot.value = fresh
    status.value = message
  } catch (error) {
    if (!current()) return
    snapshot.value = null
    status.value = error instanceof PlmApprovalBindingError ? error.message : '操作未完成，请刷新连接状态后重试。'
    failed.value = true
  } finally {
    if (current()) busy.value = false
    resetForSession()
  }
}
function load() { void run() }
function managementHref(current: PlmApprovalBindings | null) {
  return current?.connection.grantManagementUrl ?? ''
}
function bind() {
  const current = snapshot.value
  if (busy.value || !current || !current.connection.grantManagementUrl || !grant.value.trim()) return
  const connection = current.connection.id
  const secret = grant.value
  grant.value = ''
  void run(async (signal) => {
    await bindPlmApprovalGrant(connection, secret, signal)
    return '个人授权已验证并绑定。可同步待办或查询未结操作结果。'
  })
}
function rowCanUse(id: string) {
  return !!snapshot.value?.bindings.some((item) => item.id === id && item.canUse)
}
function unbind(id: string) {
  grant.value = ''
  void run(async (signal) => {
    await unbindPlmApprovalGrant(id, signal)
    return '绑定已解除，后续审批不会再使用此授权。未结操作记录继续保留。'
  })
}
function sync(id: string) {
  if (!rowCanUse(id)) return
  void run(async (signal) => {
    const result = await syncPlmApprovalTasks(id, signal)
    return `已同步 ${result.taskCount} 个待办，移除 ${result.retiredCount} 个已失效待办。`
  })
}
function reconcile(id: string) {
  if (!rowCanUse(id)) return
  void run(async (signal) => {
    const result = await reconcilePlmApprovalCommands(id, signal)
    return `已确认 ${result.settled} 项，仍待确认 ${result.pending} 项；${result.admissionRequired} 项须回到当前审批页面重新确认。本次仅查询结果，未发起新的审批。`
  })
}
onMounted(() => {
  window.addEventListener('storage', resetForSession)
  load()
})
onBeforeUnmount(() => {
  generation++
  controller?.abort()
  grant.value = ''
  snapshot.value = null
  unsubscribe()
  window.removeEventListener('storage', resetForSession)
})
</script>

<style scoped>
.plm-bindings { border-top: 1px solid #e2e8f0; margin-top: 20px; padding-top: 20px; color: #334155; }
header, .actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 18px; }
p { line-height: 1.6; overflow-wrap: anywhere; }
article { padding: 16px; margin: 12px 0; background: #f8fafc; border-radius: 8px; }
dl { display: grid; gap: 10px; }
dl div { display: flex; flex-wrap: wrap; gap: 12px; }
dt { color: #64748b; }
dd { margin: 0; overflow-wrap: anywhere; }
form { display: grid; gap: 10px; margin-top: 20px; max-width: 580px; }
form p { margin: 0; color: #64748b; font-size: 13px; }
input { padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; min-width: 0; }
button { padding: 9px 14px; border: 1px solid #cbd5e1; border-radius: 6px; background: white; color: #1e40af; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.actions { justify-content: flex-start; }
.error { color: #b91c1c; }
</style>

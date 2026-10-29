<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useAuth } from '../composables/useAuth'
import { onAuthPrincipalChange, readAuthSessionSignature, TOKEN_KEYS } from '../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../utils/explicitSessionOrg'
import { readUserApprovalRelations } from '../services/userApprovalRelations'
import type { UserApprovalRelations } from '../services/userApprovalRelations'

const props = defineProps<{ userId: string }>()
const auth = useAuth()
const result = ref<UserApprovalRelations | null>(null)
const loading = ref(false)
const error = ref('')
const allowed = ref(auth.hasAdminAccess())
let revision = 0
let alive = true
function clear() { revision++; result.value = null; loading.value = false; error.value = '' }
function invalidate() { clear(); allowed.value = false; error.value = '会话或组织已变化，请重新打开用户。' }
async function load() {
  clear()
  const userId = props.userId
  if (!userId || !alive) return
  if (!allowed.value || !auth.hasAdminAccess()) { error.value = '当前会话无权查看审批关系。'; return }
  const currentRevision = revision
  let signature: ReturnType<typeof readAuthSessionSignature>
  try { signature = readAuthSessionSignature() } catch { invalidate(); return }
  const sameSession = () => {
    try { return signature === readAuthSessionSignature() && auth.hasAdminAccess() } catch { return false }
  }
  const current = () => alive && revision === currentRevision && props.userId === userId && sameSession()
  loading.value = true
  try {
    const value = await readUserApprovalRelations(userId)
    if (current()) result.value = value
  } catch (cause) {
    if (current()) {
      error.value = cause instanceof Error && cause.message === 'SOURCE_UNRESOLVED'
        ? '审批来源需要管理员核对：存在冲突或配置失效，请检查来源策略。'
        : cause instanceof Error && cause.message === 'FORBIDDEN'
        ? '当前会话无权查看审批关系。' : '审批关系暂不可用，请重试；不能据此判断为未配置。'
      if (cause instanceof Error && cause.message === 'FORBIDDEN') allowed.value = false
    }
  } finally {
    if (alive && revision === currentRevision) {
      if (!sameSession()) invalidate()
      else loading.value = false
    }
  }
}
function storage(event: StorageEvent) {
  if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || TOKEN_KEYS.some(key => key === event.key)) invalidate()
}
const unsubscribe = onAuthPrincipalChange(invalidate)
window.addEventListener('storage', storage)
watch(() => props.userId, () => { void load() }, { immediate: true })
onBeforeUnmount(() => { alive = false; clear(); unsubscribe(); window.removeEventListener('storage', storage) })
</script>

<template>
  <section aria-label="组织审批关系" data-testid="user-approval-relations">
    <h3>审批关系（当前组织解析）</h3>
    <p>岗位是资料文字，不会自动指定审批人。本区只读复用现有组织关系，不新增逐员工上级。</p>
    <p v-if="loading" role="status">正在读取审批关系…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <template v-else-if="result">
      <p>关系来源：{{ result.source.provider === 'local' ? '本地组织' : result.source.provider === 'dingtalk' ? '钉钉目录' : result.source.provider ? '其他目录' : '尚未解析' }}</p>
      <p v-if="result.source.mode === 'legacy-default'">未设置显式审批来源策略，当前按既有默认规则解析；资料更新或同步可能改变来源。</p>
      <p>主部门：{{ result.primaryDepartment || '尚未配置' }}</p>
      <p>直属上级（部门级主管）：{{ result.manager ? result.manager.name || '名称暂不可用' : '尚未配置' }}</p>
      <p>部门主管：{{ result.departmentHead ? result.departmentHead.name || '名称暂不可用' : '尚未配置' }}</p>
      <p v-if="!result.manager || !result.departmentHead">部分关系尚未配置，对应审批节点可能无法找到审批人。</p>
    </template>
    <p>这是当前关系参考，不是某张流程的最终审批人预览；既有申请保留创建时的审批人快照。</p>
    <a v-if="allowed" href="/admin/organization">维护组织审批关系</a>
    <button v-if="allowed && !loading" type="button" @click="load">刷新审批关系</button>
  </section>
</template>

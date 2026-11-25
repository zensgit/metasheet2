<template>
  <details class="authorization-audit" @toggle="onToggle">
    <summary>权限和账户变更审计</summary>
    <p>查看账户、角色和权限变更，包含新的授权操作记录。</p>
    <div class="authorization-audit__filters">
      <input v-model.trim="query" type="search" aria-label="搜索操作人或对象" placeholder="搜索操作人或对象">
      <select v-model="resourceType" aria-label="资源类型" @change="onResourceTypeChange">
        <option value="">默认账户与权限资源</option>
        <option value="permission">直接权限</option>
        <option value="legacy-permission">旧权限</option>
        <option value="permission-template">权限模板</option>
        <option value="user-role">用户角色</option>
        <option value="user-namespace-admission">命名空间准入</option>
        <option value="user">用户</option>
        <option value="user-security-action">安全动作验证</option>
        <option value="admin_login_grant_command">管理员登录许可命令</option>
      </select>
      <select v-model="action" aria-label="动作">
        <option value="">全部动作</option>
        <option v-for="item in actionOptions" :key="item" :value="item">{{ item }}</option>
      </select>
      <input v-model="from" type="date" aria-label="开始日期">
      <input v-model="to" type="date" aria-label="结束日期">
      <button type="button" :disabled="loading" @click="load(1)">查询权限审计</button>
      <button type="button" :disabled="loading" @click="exportCsv">导出权限审计 CSV</button>
    </div>
    <p>安全动作验证和管理员登录许可命令需在资源类型中单独选择。结果为空不代表没有发生。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="exportError" role="alert">{{ exportError }}</p>
    <div class="authorization-audit__table">
      <table v-if="items.length">
        <thead><tr><th>时间</th><th>操作人</th><th>资源</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody><tr v-for="item in items" :key="`${item.source}:${item.source_id}`">
          <td>{{ item.created_at }}</td><td>{{ item.actor_id || '—' }}</td><td>{{ item.resource_type }}</td><td>{{ item.action }}</td><td>{{ item.resource_id || '—' }}</td><td><details><summary>查看详情</summary><pre>{{ JSON.stringify(item.action_details, null, 2) }}</pre></details></td>
        </tr></tbody>
      </table>
      <p v-else-if="loading && !error">正在加载权限审计…</p>
      <p v-else-if="loaded && !error">暂无权限审计记录。</p>
    </div>
    <div><button type="button" :disabled="loading || page <= 1" @click="load(page - 1)">上一页</button> 第 {{ page }} / {{ totalPages }} 页（{{ total }} 条） <button type="button" :disabled="loading || page >= totalPages" @click="load(page + 1)">下一页</button></div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { apiFetch } from '../utils/api'

type Item = { created_at: string; actor_id: string | null; resource_type: string; action: string; resource_id: string | null; action_details: unknown; source: string; source_id: string }
const query = ref(''), resourceType = ref(''), action = ref(''), from = ref(''), to = ref('')
const items = ref<Item[]>([]), page = ref(1), total = ref(0), loading = ref(false), error = ref(''), loaded = ref(false), exportError = ref('')
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
const ORIGINAL_ACTIONS: readonly string[] = ['grant', 'revoke', 'update']
const RESOURCE_ACTIONS: Record<string, readonly string[]> = {
  'user-security-action': ['security_action_verify'],
  admin_login_grant_command: ['admin_login_grant_enable'],
}
function actionsFor(resource: string): readonly string[] {
  return RESOURCE_ACTIONS[resource] ?? ORIGINAL_ACTIONS
}
const actionOptions = computed(() => actionsFor(resourceType.value))
function onResourceTypeChange(event: Event): void {
  const next = (event.target as HTMLSelectElement).value
  resourceType.value = next
  if (action.value && !actionsFor(next).includes(action.value)) action.value = ''
}
let opened = false
function params(extra: Record<string, string> = {}): URLSearchParams {
  const result = new URLSearchParams()
  for (const [key, value] of Object.entries({ q: query.value, resourceType: resourceType.value, action: action.value, from: from.value, to: to.value, ...extra })) if (value) result.set(key, value)
  return result
}
async function load(nextPage: number): Promise<void> {
  loading.value = true; error.value = ''
  try {
    const response = await apiFetch(`/api/admin/audit-activity?${params({ page: String(nextPage), pageSize: '20' })}`)
    const payload = await response.json()
    if (!response.ok || payload.ok !== true) throw new Error(payload.error?.message || '加载权限审计失败')
    items.value = Array.isArray(payload.data?.items) ? payload.data.items : []
    total.value = Number(payload.data?.total || 0); page.value = Number(payload.data?.page || nextPage)
    loaded.value = true
  } catch (reason) {
    items.value = []
    loaded.value = false
    error.value = reason instanceof Error ? reason.message : '加载权限审计失败'
  }
  finally { loading.value = false }
}
function onToggle(event: Event): void {
  if ((event.target as HTMLDetailsElement).open && !opened) { opened = true; void load(1) }
}
async function exportCsv(): Promise<void> {
  loading.value = true; exportError.value = ''
  try {
    const response = await apiFetch(`/api/admin/audit-activity/export.csv?${params({ limit: '5000' })}`)
    if (!response.ok) throw new Error('导出权限审计失败')
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a'); link.href = url; link.download = 'admin-authorization-audit.csv'; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url)
  } catch (reason) { exportError.value = reason instanceof Error ? reason.message : '导出权限审计失败' }
  finally { loading.value = false }
}
</script>

<style scoped>
.authorization-audit { background: white; border: 1px solid #e5e7eb; border-radius: 16px; padding: 16px; }
.authorization-audit > summary { cursor: pointer; font-size: 1.1rem; font-weight: 600; }
.authorization-audit__filters { display: flex; flex-wrap: wrap; gap: 8px; }
.authorization-audit__table { overflow-x: auto; }
table { width: 100%; text-align: left; border-collapse: collapse; }
th, td { padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

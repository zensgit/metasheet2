<script setup lang="ts">
import type { LocalCandidate } from '../../services/localOrganizationClient'
defineProps<{
  candidates: LocalCandidate[]; selectedId: string; query: string
  page: number; total: number; pageSize: number
  loading: boolean; disabled: boolean; writing: boolean; error: string
}>()
const emit = defineEmits<{
  updateQuery: [value: string]; select: [id: string]; search: []
  page: [page: number]; project: []
}>()
function label(candidate: LocalCandidate): string {
  const name = candidate.name?.trim()
  const username = candidate.username?.trim()
  if (name && username) return name + '（' + username + '）'
  return name || username || '未命名平台成员（不可选择）'
}
</script>

<template>
  <section aria-labelledby="projection-heading">
    <h2 id="projection-heading">表示已有平台成员</h2>
    <p>仅为本组织已有活跃用户建立目录表示，不创建账号、不加入组织、不重新激活，也不授予权限。</p>
    <form @submit.prevent="!writing && emit('search')">
      <label>查找已有平台成员<input
        :value="query" maxlength="200" :disabled="writing"
        @input="emit('updateQuery', ($event.target as HTMLInputElement).value)" /></label>
      <button type="submit" :disabled="writing">搜索平台成员</button>
    </form>
    <p v-if="loading" role="status">正在加载候选成员…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!candidates.length">本页没有可表示的活跃平台成员，请调整搜索或页码。</p>
    <label>选择已有平台成员<select
        :value="selectedId" :disabled="disabled || loading"
      @change="emit('select', ($event.target as HTMLSelectElement).value)">
      <option value="">请选择成员</option>
      <option v-for="c in candidates" :key="c.id" :value="c.id" :disabled="!c.name?.trim() && !c.username?.trim()">{{ label(c) }}</option>
    </select></label>
    <button type="button" :disabled="disabled || loading || !selectedId" @click="emit('project')">建立目录表示</button>
    <nav aria-label="平台成员分页">
      <button type="button" :disabled="writing || page <= 1" @click="emit('page', page - 1)">上一页平台成员</button>
      <span>第 {{ page }} 页，共 {{ total }} 人</span>
      <button type="button" :disabled="writing || loading || page * pageSize >= total" @click="emit('page', page + 1)">下一页平台成员</button>
    </nav>
  </section>
</template>

<style scoped>
section { min-width: 0; }
label { display: grid; gap: .3rem; margin-block: .7rem; }
input, select { box-sizing: border-box; min-width: 0; width: 100%; max-width: 100%; }
button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; margin: .25rem; padding: .45rem .65rem; }
nav { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
</style>

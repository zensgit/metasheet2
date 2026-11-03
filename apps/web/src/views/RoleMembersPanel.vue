<template>
  <section class="role-members">
    <div class="role-members__head">
      <h3>角色成员</h3>
      <button class="role-members__refresh" type="button" @click="reload()">刷新</button>
    </div>

    <p v-if="loading" class="role-members__status">正在加载成员...</p>
    <p v-else-if="failed" class="role-members__status">成员名单暂时不可用</p>
    <p v-else-if="total === 0" class="role-members__status">暂无成员</p>
    <p v-else-if="items.length === 0" class="role-members__status">这一页没有成员</p>
    <ul v-else class="role-members__list">
      <li v-for="member in items" :key="member.id" class="role-members__item">{{ member.displayName }}</li>
    </ul>

    <p v-if="total !== null && !loading && !failed" class="role-members__total">共 {{ total }} 人</p>

    <div class="role-members__pager">
      <button class="role-members__prev" type="button" :disabled="page <= 1" @click="goPrev()">上一页</button>
      <span>第 {{ page }} 页</span>
      <button class="role-members__next" type="button" :disabled="!canGoNext" @click="goNext()">下一页</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { fetchRoleMembers, ROLE_MEMBER_PAGE_SIZE } from './roleMembers'
import type { RoleMember } from './roleMembers'

const props = defineProps<{ roleId: string }>()

const generation = ref(0)
const items = ref<RoleMember[]>([])
const total = ref<number | null>(null)
const failed = ref(false)
const loading = ref(false)
const page = ref(1)

const canGoNext = computed(() => total.value === null || page.value * ROLE_MEMBER_PAGE_SIZE < total.value)

async function load(roleId: string, nextPage: number): Promise<void> {
  const token = generation.value + 1
  generation.value = token
  page.value = nextPage
  items.value = []
  total.value = null
  failed.value = false
  loading.value = true
  try {
    const result = await fetchRoleMembers(roleId, nextPage)
    if (token !== generation.value) return
    items.value = result.items
    total.value = result.total
    page.value = result.page
  } catch {
    if (token !== generation.value) return
    items.value = []
    total.value = null
    failed.value = true
  } finally {
    if (token === generation.value) loading.value = false
  }
}

function reload(): void {
  void load(props.roleId, page.value)
}

function goPrev(): void {
  if (page.value <= 1) return
  void load(props.roleId, page.value - 1)
}

function goNext(): void {
  if (!canGoNext.value) return
  void load(props.roleId, page.value + 1)
}

watch(() => props.roleId, (roleId) => {
  if (!roleId) return
  void load(roleId, 1)
}, { immediate: true })
</script>

<style scoped>
.role-members {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}

.role-members__head,
.role-members__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.role-members__list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.role-members__status,
.role-members__total {
  margin: 0;
  color: #64748b;
}

.role-members__refresh,
.role-members__prev,
.role-members__next {
  border: none;
  border-radius: 10px;
  background: #e2e8f0;
  color: #0f172a;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}

.role-members__refresh:disabled,
.role-members__prev:disabled,
.role-members__next:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>

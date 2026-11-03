<template>
  <div class="sp-members-appoint" :data-testid="`stock-prep-members-appoint-form-${roleId}`">
    <!-- Find a person through the EXISTING delegation user list (scoped by the server for a delegated
         admin) and appoint them. The parent never renders this form for the main administrator. -->
    <input
      v-model="query"
      type="text"
      :placeholder="bi('按姓名、账号或邮箱找人', 'Find by name, login or email')"
      data-testid="stock-prep-members-search-input"
    >
    <button type="button" :disabled="busy" data-testid="stock-prep-members-search" @click="search">
      {{ bi('查找', 'Find') }}
    </button>
    <button
      v-for="user in results"
      :key="user.id"
      type="button"
      :disabled="busy"
      data-testid="stock-prep-members-appoint"
      :data-user-id="user.id"
      @click="emit('appoint', roleId, user.id)"
    >
      {{ bi(`任命 ${user.name || user.username || user.id}`, `Appoint ${user.name || user.username || user.id}`) }}
    </button>
    <span v-if="searched && results.length === 0" class="sp-members-appoint__hint" data-testid="stock-prep-members-search-empty">
      {{ bi('没有找到可任命的人（只能任命您可管理范围内的人）。', 'No one found (you can only appoint people inside your delegated scope).') }}
    </span>
  </div>
</template>

<script setup lang="ts">
// 备料「成员与权限」(S5b, R-39) — the appoint form of one appointable role.
import { ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import {
  searchStockPrepDelegationUsers,
  type StockPrepDelegationUser,
} from '../../../services/integration/stockPreparation/members'

withDefaults(defineProps<{
  roleId: string
  busy?: boolean
}>(), { busy: false })

const emit = defineEmits<{ (e: 'appoint', roleId: string, userId: string): void }>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const query = ref('')
const results = ref<StockPrepDelegationUser[]>([])
const searched = ref(false)

async function search(): Promise<void> {
  try {
    results.value = await searchStockPrepDelegationUsers(query.value)
  } catch {
    results.value = []
  }
  searched.value = true
}
</script>

<style scoped>
.sp-members-appoint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sp-members-appoint__hint {
  color: #475569;
  font-size: 13px;
}
</style>

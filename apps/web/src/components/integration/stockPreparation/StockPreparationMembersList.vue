<template>
  <ul class="sp-members-list" :data-testid="`stock-prep-members-list-${role.id}`">
    <!-- One role's members, as the server scoped them (a delegated admin sees the members inside their
         department / member-group scope, plus a COUNT of the rest). Revoke and 「开通插件使用」 render
         only for an appointable role — never for the main administrator (ADR §11.7). -->
    <li
      v-for="member in role.members"
      :key="member.userId"
      data-testid="stock-prep-members-member"
      :data-admitted="member.admitted ? 'true' : 'false'"
    >
      <span>{{ member.name || member.username || member.userId }}</span>
      <span v-if="!member.admitted" class="sp-members-list__warn">{{ bi('（未开通插件使用）', ' (plugin access off)') }}</span>
      <button
        v-if="!readOnly && role.appointable && !member.admitted"
        type="button"
        data-testid="stock-prep-members-admit"
        :disabled="busy"
        @click="emit('admit', member.userId)"
      >
        {{ bi('开通插件使用', 'Turn on plugin access') }}
      </button>
      <button
        v-if="!readOnly && role.appointable"
        type="button"
        data-testid="stock-prep-members-revoke"
        :disabled="busy"
        @click="emit('revoke', role.id, member.userId)"
      >
        {{ bi('撤销', 'Revoke') }}
      </button>
    </li>
    <li v-if="role.members.length === 0" data-testid="stock-prep-members-none">{{ bi('还没有成员。', 'No members yet.') }}</li>
    <li v-if="role.outOfScopeMemberCount > 0" data-testid="stock-prep-members-out-of-scope">
      {{ bi(`另有 ${role.outOfScopeMemberCount} 人不在您可管理的范围内。`, `${role.outOfScopeMemberCount} more outside your delegated scope.`) }}
    </li>
  </ul>
</template>

<script setup lang="ts">
// 备料「成员与权限」(S5b, R-39) — one role's member list. Presentational: it decides nothing about
// permission beyond the server's `appointable` flag (already clamped so the main administrator is never
// appointable), and it emits; StockPreparationMembersView.vue calls the delegation routes.
import { useLocale } from '../../../composables/useLocale'
import type { StockPrepMembersRole } from '../../../services/integration/stockPreparation/members'

withDefaults(defineProps<{
  role: StockPrepMembersRole
  busy?: boolean
  readOnly?: boolean
}>(), { busy: false, readOnly: false })

const emit = defineEmits<{
  (e: 'revoke', roleId: string, userId: string): void
  (e: 'admit', userId: string): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}
</script>

<style scoped>
.sp-members-list {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
  font-size: 13px;
}

.sp-members-list__warn {
  color: #92400e;
}
</style>

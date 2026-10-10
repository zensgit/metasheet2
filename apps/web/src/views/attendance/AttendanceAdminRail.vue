<template>
  <aside class="attendance__admin-nav-panel">
    <div class="attendance__admin-nav-header">
      <strong>{{ tr('Jump to', '跳转区块') }}</strong>
    </div>
    <button
      v-if="isCompactAdminNav"
      class="attendance__admin-nav-toggle"
      type="button"
      :aria-expanded="adminCompactNavOpen ? 'true' : 'false'"
      @click="emit('update:compactNavOpen', !adminCompactNavOpen)"
    >
      <span>{{ adminCompactNavOpen ? tr('Hide navigation', '收起导航') : tr('Show navigation', '展开导航') }}</span>
      <small>{{ activeAdminSectionContextLabel }}</small>
    </button>
    <template v-if="!isCompactAdminNav || adminCompactNavOpen">
      <nav class="attendance__admin-nav" :aria-label="tr('Attendance admin sections', '考勤管理区块')">
        <section
          v-for="group in visibleAdminSectionNavGroups"
          :key="group.id"
          class="attendance__admin-nav-group"
          :data-admin-anchor-group="group.id"
        >
          <button
            class="attendance__admin-nav-group-header"
            type="button"
            :aria-expanded="group.expanded ? 'true' : 'false'"
            @click="emit('toggleGroup', group.id)"
          >
            <span class="attendance__admin-nav-group-title">{{ group.label }}</span>
            <span class="attendance__admin-nav-group-meta">
              <span class="attendance__admin-nav-group-caret" aria-hidden="true">{{ group.expanded ? '▾' : '▸' }}</span>
            </span>
          </button>
          <div v-if="group.expanded" class="attendance__admin-nav-group-items">
            <button
              v-for="item in group.items"
              :key="item.id"
              class="attendance__admin-nav-link"
              :class="{ 'attendance__admin-nav-link--active': adminActiveSectionId === item.id }"
              :aria-current="adminActiveSectionId === item.id ? 'true' : undefined"
              :data-admin-anchor="item.id"
              type="button"
              @click="emit('selectSection', item.id)"
            >
              {{ item.label }}
            </button>
          </div>
        </section>
        <p v-if="visibleAdminSectionNavGroups.length === 0" class="attendance__admin-nav-empty">
          {{ tr('No sections match the current filter.', '当前筛选没有匹配区块。') }}
        </p>
      </nav>
    </template>
  </aside>
</template>

<script setup lang="ts">
import type {
  AdminSectionNavDisplayItem,
  AdminSectionNavGroup,
  TranslateFn,
} from './useAttendanceAdminRail'

withDefaults(defineProps<{
  tr: TranslateFn
  adminSectionNavCountLabel?: string
  adminNavStorageScope?: string
  adminNavDefaultStorageScope?: string
  adminNavScopeFeedback?: string
  activeAdminSectionContextLabel?: string
  isCompactAdminNav?: boolean
  adminCompactNavOpen?: boolean
  adminSectionFilter?: string
  adminSectionFilterActive?: boolean
  allAdminSectionGroupsExpanded?: boolean
  allAdminSectionGroupsCollapsed?: boolean
  visibleRecentAdminSectionNavItems?: AdminSectionNavDisplayItem[]
  visibleAdminSectionNavGroups?: AdminSectionNavGroup[]
  adminActiveSectionId?: string
}>(), {
  adminSectionNavCountLabel: '',
  adminNavStorageScope: '',
  adminNavDefaultStorageScope: '',
  adminNavScopeFeedback: '',
  activeAdminSectionContextLabel: '',
  isCompactAdminNav: false,
  adminCompactNavOpen: false,
  adminSectionFilter: '',
  adminSectionFilterActive: false,
  allAdminSectionGroupsExpanded: false,
  allAdminSectionGroupsCollapsed: false,
  visibleRecentAdminSectionNavItems: () => [],
  visibleAdminSectionNavGroups: () => [],
  adminActiveSectionId: '',
})

const emit = defineEmits<{
  (event: 'update:compactNavOpen', value: boolean): void
  (event: 'update:sectionFilter', value: string): void
  (event: 'expandAll'): void
  (event: 'collapseAll'): void
  (event: 'copyCurrentLink'): void
  (event: 'clearRecents'): void
  (event: 'toggleGroup', id: string): void
  (event: 'selectSection', id: string): void
}>()
</script>

<style scoped>
.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

.attendance__field input {
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  min-width: 180px;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__btn--inline {
  padding: 5px 10px;
  font-size: 12px;
}

.attendance__admin-nav-panel {
  position: sticky;
  top: 88px;
  align-self: flex-start;
  min-width: 220px;
  max-width: 280px;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.attendance__admin-nav-header {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}

.attendance__admin-nav-toggle {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ms-space-1);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  text-align: left;
  cursor: pointer;
}

.attendance__admin-nav-toggle small {
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance__admin-nav {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(100vh - 160px);
  overflow: auto;
}

.attendance__admin-nav-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__admin-nav-group-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: none;
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  text-align: left;
  cursor: pointer;
}

.attendance__admin-nav-group-title {
  font-size: 13px;
  font-weight: var(--ms-font-weight-title);
}

.attendance__admin-nav-group-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance__admin-nav-group-caret {
  font-size: 12px;
}

.attendance__admin-nav-group-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__admin-nav-empty {
  margin: 0;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.5;
}

.attendance__admin-nav-link {
  width: 100%;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid transparent;
  border-radius: var(--ms-radius-md);
  background: transparent;
  color: var(--ms-text-2);
  text-align: left;
  cursor: pointer;
}

.attendance__admin-nav-link:hover {
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
}

.attendance__admin-nav-link--active {
  border-color: var(--el-color-primary-light-7);
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  font-weight: var(--ms-font-weight-title);
}

@media (max-width: 960px) {
  .attendance__admin-nav-panel {
    position: static;
    max-width: none;
    width: 100%;
  }

  .attendance__admin-nav {
    max-height: none;
  }
}

@media (max-width: 720px) {
  .attendance__admin-nav-group {
    gap: 8px;
  }

  .attendance__admin-nav-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .attendance__admin-nav-actions .attendance__btn {
    width: 100%;
  }

  .attendance__admin-nav-link {
    padding: 10px 12px;
  }
}
</style>

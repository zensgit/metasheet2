<template>
  <aside class="attendance__admin-nav-panel">
    <div class="attendance__admin-nav-header">
      <strong>{{ tr('Sections', '区块') }}</strong>
      <div class="attendance__admin-nav-header-meta">
        <span>{{ adminSectionNavCountLabel }}</span>
        <span
          v-if="adminNavStorageScope !== adminNavDefaultStorageScope"
          class="attendance__admin-nav-scope-badge"
          :title="tr('Navigation memory scoped to this org.', '当前导航记忆已关联到此组织。')"
        >
          {{ adminNavStorageScope }}
        </span>
      </div>
    </div>
    <div v-if="adminNavScopeFeedback" class="attendance__admin-nav-scope-note">
      {{ adminNavScopeFeedback }}
    </div>
    <div class="attendance__admin-nav-current" :title="activeAdminSectionContextLabel">
      <span>{{ tr('Current', '当前') }}</span>
      <strong>{{ activeAdminSectionContextLabel }}</strong>
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
      <label class="attendance__field attendance__field--compact" for="attendance-admin-nav-filter">
        <span>{{ tr('Quick find', '快速查找') }}</span>
        <input
          id="attendance-admin-nav-filter"
          :value="adminSectionFilter"
          type="text"
          :placeholder="tr('Search sections', '搜索区块')"
          @input="emit('update:sectionFilter', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <div class="attendance__admin-nav-actions">
        <button
          class="attendance__btn attendance__btn--inline"
          type="button"
          :disabled="adminSectionFilterActive || allAdminSectionGroupsExpanded"
          @click="emit('expandAll')"
        >
          {{ tr('Expand all', '展开全部') }}
        </button>
        <button
          class="attendance__btn attendance__btn--inline"
          type="button"
          :disabled="adminSectionFilterActive || allAdminSectionGroupsCollapsed"
          @click="emit('collapseAll')"
        >
          {{ tr('Collapse all', '收起全部') }}
        </button>
        <button
          class="attendance__btn attendance__btn--inline"
          type="button"
          @click="emit('copyCurrentLink')"
        >
          {{ tr('Copy current link', '复制当前链接') }}
        </button>
      </div>
      <section v-if="visibleRecentAdminSectionNavItems.length > 0" class="attendance__admin-nav-recents">
        <div class="attendance__admin-nav-recents-header">
          <strong>{{ tr('Recent', '最近访问') }}</strong>
          <div class="attendance__admin-nav-recents-meta">
            <span>{{ `${visibleRecentAdminSectionNavItems.length}` }}</span>
            <button
              class="attendance__btn attendance__btn--inline"
              type="button"
              data-admin-recents-clear="true"
              @click="emit('clearRecents')"
            >
              {{ tr('Clear', '清空') }}
            </button>
          </div>
        </div>
        <div class="attendance__admin-nav-recents-items">
          <button
            v-for="item in visibleRecentAdminSectionNavItems"
            :key="`recent-${item.id}`"
            class="attendance__admin-nav-link attendance__admin-nav-link--recent"
            :class="{ 'attendance__admin-nav-link--active': adminActiveSectionId === item.id }"
            :aria-current="adminActiveSectionId === item.id ? 'true' : undefined"
            :data-admin-anchor-recent="item.id"
            type="button"
            @click="emit('selectSection', item.id)"
          >
            {{ item.contextLabel }}
          </button>
        </div>
      </section>
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
              <span class="attendance__admin-nav-group-count">{{ group.countLabel }}</span>
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

defineProps<{
  tr: TranslateFn
  adminSectionNavCountLabel: string
  adminNavStorageScope: string
  adminNavDefaultStorageScope: string
  adminNavScopeFeedback: string
  activeAdminSectionContextLabel: string
  isCompactAdminNav: boolean
  adminCompactNavOpen: boolean
  adminSectionFilter: string
  adminSectionFilterActive: boolean
  allAdminSectionGroupsExpanded: boolean
  allAdminSectionGroupsCollapsed: boolean
  visibleRecentAdminSectionNavItems: AdminSectionNavDisplayItem[]
  visibleAdminSectionNavGroups: AdminSectionNavGroup[]
  adminActiveSectionId: string
}>()

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
  gap: 12px;
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
}

.attendance__admin-nav-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #6b7280;
}

.attendance__admin-nav-header-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.attendance__admin-nav-scope-badge {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e0e7ff;
  color: #3730a3;
  font-size: 11px;
  font-weight: 600;
}

.attendance__admin-nav-scope-note {
  margin-top: -4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #eef6ff;
  color: #1d4ed8;
  font-size: 12px;
  line-height: 1.4;
}

.attendance__admin-nav-current {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid #dbeafe;
  border-radius: 10px;
  background: #f8fbff;
  color: #6b7280;
  font-size: 12px;
}

.attendance__admin-nav-current strong {
  color: #1f2937;
  font-size: 13px;
  line-height: 1.4;
}

.attendance__field--compact {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__field--compact span {
  font-size: 12px;
}

.attendance__admin-nav-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__admin-nav-recents {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #f8fbff;
}

.attendance__admin-nav-recents-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #1e3a8a;
  font-size: 12px;
}

.attendance__admin-nav-recents-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.attendance__admin-nav-recents-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__admin-nav-link--recent {
  background: #ffffff;
}

.attendance__admin-nav-toggle {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #bfdbfe;
  border-radius: 12px;
  background: #eff6ff;
  color: #1d4ed8;
  text-align: left;
  cursor: pointer;
}

.attendance__admin-nav-toggle small {
  color: #6b7280;
  font-size: 11px;
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
  gap: 12px;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: #eef2ff;
  color: #374151;
  text-align: left;
  cursor: pointer;
}

.attendance__admin-nav-group-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.attendance__admin-nav-group-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #6b7280;
  font-size: 11px;
}

.attendance__admin-nav-group-count {
  min-width: 28px;
  text-align: right;
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
  padding: 8px 10px;
  border: 1px solid #dbeafe;
  border-radius: 10px;
  background: #f8fbff;
  color: #1f2937;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}

.attendance__admin-nav-link:hover {
  border-color: #93c5fd;
  background: #eff6ff;
  color: #1d4ed8;
}

.attendance__admin-nav-link--active {
  border-color: #2563eb;
  background: #dbeafe;
  color: #1d4ed8;
  box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.15);
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

  .attendance__admin-nav-actions .attendance__btn {
    width: auto;
  }

  .attendance__admin-nav-link {
    padding: 10px 12px;
  }
}
</style>

<template>
  <aside class="integration-workbench-rail" :aria-label="tr('数据工厂分区导航', 'Data Factory section navigation')">
    <div class="integration-workbench-rail__header">
      <strong>{{ tr('跳转区块', 'Jump to section') }}</strong>
    </div>
    <nav class="integration-workbench-rail__nav">
      <button
        v-for="group in groups"
        :key="group.id"
        type="button"
        class="integration-workbench-rail__item"
        :class="{ 'integration-workbench-rail__item--active': activeGroupId === group.id }"
        :aria-current="activeGroupId === group.id ? 'true' : undefined"
        :data-testid="`integration-rail-${group.id}`"
        @click="emit('select', group)"
      >
        {{ group.label }}
      </button>
    </nav>
  </aside>
</template>

<script setup lang="ts">
// IU-2a (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2):
// sticky left rail for the Data Factory workbench. Structural mirror of
// src/views/attendance/AttendanceAdminRail.vue, simplified to this slice's scope — six FIXED
// groups (no filter/expand/compact-toggle machinery, since IU-2a is chrome + anchor navigation
// only; per-section component extraction + active-section switching is IU-2b). Presentational
// only: the parent view owns section refs, the IntersectionObserver, and the scroll behavior;
// this component just renders the group buttons and reports clicks via `select`.
export interface IntegrationWorkbenchRailGroup {
  /** Stable group id (e.g. "connection", "read-source") — also the active-highlight key. */
  id: string
  /** Bilingual display label (already resolved by the parent via its `tr`/`bi` helper). */
  label: string
  /** DOM id of the first section belonging to this group — the scroll target. */
  targetId: string
}

withDefaults(
  defineProps<{
    groups: IntegrationWorkbenchRailGroup[]
    activeGroupId?: string
    /** Bilingual copy helper — same shape as the view's local `bi(zh, en)` function. */
    tr: (zh: string, en: string) => string
  }>(),
  {
    groups: () => [],
    activeGroupId: '',
  },
)

const emit = defineEmits<{
  (event: 'select', group: IntegrationWorkbenchRailGroup): void
}>()
</script>

<style scoped>
.integration-workbench-rail {
  position: sticky;
  top: var(--ms-space-5);
  align-self: flex-start;
  min-width: 180px;
  max-width: 220px;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
}

.integration-workbench-rail__header {
  font-size: 12px;
  color: var(--ms-text-3);
}

.integration-workbench-rail__nav {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.integration-workbench-rail__item {
  width: 100%;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  text-align: left;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}

.integration-workbench-rail__item:hover {
  border-color: var(--ms-color-primary);
  color: var(--ms-color-primary);
}

.integration-workbench-rail__item--active {
  border-color: var(--ms-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  font-weight: 700;
}

@media (max-width: 960px) {
  .integration-workbench-rail {
    position: static;
    max-width: none;
    width: 100%;
  }

  .integration-workbench-rail__nav {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .integration-workbench-rail__item {
    width: auto;
  }
}
</style>

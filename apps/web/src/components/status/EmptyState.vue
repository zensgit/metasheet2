<template>
  <div class="ms-empty-state">
    <div v-if="icon" class="ms-empty-state__icon">
      <el-icon :size="32"><component :is="icon" /></el-icon>
    </div>
    <p class="ms-empty-state__title">{{ title }}</p>
    <p v-if="hint" class="ms-empty-state__hint">{{ hint }}</p>
    <div v-if="$slots.action" class="ms-empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'

// UF-8 (design-lock §3.6 "空态用共享空态组件") — the ONE shared empty-state renderer for
// text-only/ad hoc "no data yet" divs across the automation/approval/workflow-hub surfaces.
// Icon-optional (some call sites have nothing meaningful to show); title is the only required
// prop so a bare swap-in (`<div class="...">{{ text }}</div>` → `<EmptyState :title="text" />`)
// is always available, with hint/action available for richer call sites. Framework-free styling
// (tokens only, no hardcoded hex — UF-6 guard covers this file) so it drops into both EP-managed
// pages and hand-rolled markup alike, same design as StatusTag.
defineProps<{
  title: string
  hint?: string
  icon?: Component
}>()
</script>

<style scoped>
.ms-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--ms-space-2);
  padding: var(--ms-space-6) var(--ms-space-4);
  color: var(--ms-text-2);
  text-align: center;
}

.ms-empty-state__icon {
  color: var(--ms-text-3);
}

.ms-empty-state__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ms-text-1);
}

.ms-empty-state__hint {
  margin: 0;
  font-size: 13px;
  color: var(--ms-text-3);
}

.ms-empty-state__action {
  margin-top: var(--ms-space-1);
}
</style>

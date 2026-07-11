<template>
  <div v-if="state === 'loading'" class="ms-async-state" data-async-state="loading">
    <el-skeleton
      v-for="(rows, index) in skeletonRows"
      :key="index"
      class="ms-async-state__section"
      :rows="rows"
      animated
    />
  </div>
  <EmptyState v-else :title="title" :hint="hint" data-async-state="empty">
    <template v-if="$slots.action" #action>
      <slot name="action" />
    </template>
  </EmptyState>
</template>

<script setup lang="ts">
import { ElSkeleton } from 'element-plus'
import EmptyState from './EmptyState.vue'

// B3-13 (approval FE polish) — the shared async-surface state block: ONE component for the two
// non-content states a detail-style page can be in, so call sites stop hand-rolling ad hoc
// skeleton divs and blank not-found areas.
//   - state="loading": first-paint skeleton — one el-skeleton section per `skeletonRows` entry
//     (the number is that section's paragraph row count), mirroring the UF-8 first-paint pattern.
//   - state="empty":   composes the shipped UF-8 EmptyState (title/hint + an #action CTA slot),
//     NOT a parallel empty-state implementation — EmptyState stays the single renderer.
// ElSkeleton is imported explicitly (not left to global registration) so the component renders
// the real skeleton even inside test shells that only stub-register EP components.
withDefaults(defineProps<{
  state: 'loading' | 'empty'
  /** Empty-state title (used when state === 'empty'). */
  title?: string
  hint?: string
  /** Loading-state sections: one el-skeleton per entry, value = that section's row count. */
  skeletonRows?: number[]
}>(), {
  title: '暂无数据',
  hint: undefined,
  skeletonRows: () => [3],
})
</script>

<style scoped>
.ms-async-state {
  padding: var(--ms-space-4) 0;
}

.ms-async-state__section + .ms-async-state__section {
  margin-top: var(--ms-space-4);
}
</style>

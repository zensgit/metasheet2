<template>
  <div class="mt-panel" :class="[`mt-panel--${padding}`, { 'mt-panel--shadow': shadow }]">
    <slot />
  </div>
</template>

<script setup lang="ts">
// MtPanel — P2-1b shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// A simple token-styled container card for grouping content (border/radius/bg, optional shadow).
// Presentation-only: no business logic, no data fetching. Consumes ONLY UF-1 `--ms-*` tokens
// (design-lock §8 / §3.1) — never introduce a new hardcoded hex here.
export type MtPanelPadding = 'none' | 'sm' | 'md'

withDefaults(defineProps<{
  padding?: MtPanelPadding
  shadow?: boolean
}>(), {
  padding: 'md',
  shadow: false,
})
</script>

<style scoped>
.mt-panel {
  box-sizing: border-box;
  background: var(--ms-bg-card);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
}

.mt-panel--shadow {
  box-shadow: var(--ms-shadow-card);
}

.mt-panel--none {
  padding: 0;
}

.mt-panel--sm {
  padding: var(--ms-space-2);
}

.mt-panel--md {
  padding: var(--ms-space-4);
}
</style>

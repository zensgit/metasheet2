<template>
  <div class="ms-page-shell" :class="`ms-page-shell--${width}`">
    <div class="ms-page-shell__container">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
// PageShell — the single page-container convention for the UI foundation design-lock
// (docs/development/ui-foundation-design-lock-20260706.md §3.3 / §6 UF-2). Every adopted view
// gets its outer padding + centered max-width container from here instead of a hand-rolled
// `max-width/margin:auto/padding` wrapper class. Presentation only — no behavior.
withDefaults(
  defineProps<{
    /** Container width tier (design-lock §4): narrow=800px / default=1200px / wide=100%. */
    width?: 'narrow' | 'default' | 'wide'
  }>(),
  { width: 'default' },
)
</script>

<style scoped>
.ms-page-shell {
  padding: var(--ms-space-5);
}

.ms-page-shell__container {
  width: 100%;
  margin: 0 auto;
}

.ms-page-shell--narrow .ms-page-shell__container {
  max-width: var(--ms-page-narrow);
}

.ms-page-shell--default .ms-page-shell__container {
  max-width: var(--ms-page-default);
}

.ms-page-shell--wide .ms-page-shell__container {
  max-width: 100%;
}

@media (max-width: 768px) {
  .ms-page-shell {
    padding: var(--ms-space-4);
  }
}
</style>

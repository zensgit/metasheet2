<template>
  <MtPopover v-model:open="isOpen" :placement="placement">
    <template #trigger="slotProps">
      <slot name="trigger" v-bind="slotProps" />
    </template>
    <div class="mt-menu" role="menu">
      <slot />
    </div>
  </MtPopover>
</template>

<script setup lang="ts">
// MtMenu — P2-1b shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// A trigger + dropdown list of <MtMenuItem> children, built on <MtPopover> so it inherits its
// Teleport-safety, click-outside, and Escape-to-close for free (rather than re-implementing the
// existing `ContextMenu.vue` idiom a second time). Presentation-only: no business logic, no data
// fetching. Consumes ONLY UF-1 `--ms-*` tokens (design-lock §8 / §3.1).
//
// Composition is slot-based, not a data-driven `items` array: put <MtMenuItem>/dividers as
// children, same as any other menu-of-rows component. Selecting an item (its `select` emit)
// closes the menu automatically via the MT_MENU_CLOSE_KEY provide/inject contract in
// `menuContext.ts` — MtMenu never inspects its slotted vnodes to do this.
import { provide, ref } from 'vue'
import MtPopover, { type MtPopoverPlacement } from './MtPopover.vue'
import { MT_MENU_CLOSE_KEY } from './menuContext'

withDefaults(defineProps<{
  placement?: MtPopoverPlacement
}>(), {
  placement: 'bottom-start',
})

const isOpen = ref(false)

provide(MT_MENU_CLOSE_KEY, () => {
  isOpen.value = false
})

defineExpose({ isOpen })
</script>

<style scoped>
.mt-menu {
  display: flex;
  flex-direction: column;
  min-width: 160px;
}
</style>

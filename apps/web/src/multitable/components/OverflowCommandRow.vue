<script setup lang="ts">
import { computed } from 'vue'
import OverflowPinControl from './OverflowPinControl.vue'
import { useInjectedToolbarPins, type ToolbarPinsApi } from '../composables/useToolbarPins'

const props = defineProps<{
  commandId: string
  pinApi?: ToolbarPinsApi | null
}>()

const injected = useInjectedToolbarPins()
const api = computed(() => props.pinApi ?? injected)
const pinned = computed(() => api.value?.isPinned(props.commandId) ?? false)
</script>

<template>
  <div
    class="meta-toolbar__more-row"
    :data-command-row="commandId"
    v-show="!pinned"
  >
    <slot />
    <OverflowPinControl :command-id="commandId" :api="api" />
  </div>
</template>

<style scoped>
.meta-toolbar__more-row {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
}
.meta-toolbar__more-row > :first-child { flex: 1 1 auto; min-width: 0; }
</style>

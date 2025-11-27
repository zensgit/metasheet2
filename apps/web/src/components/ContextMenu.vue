<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      ref="menuRef"
      class="context-menu"
      :style="menuStyle"
      @click.stop
    >
      <div class="context-menu-items">
        <template v-for="(item, index) in items" :key="index">
          <div v-if="item.separator || item.divider" class="context-menu-separator" />
          <div
            v-else
            class="context-menu-item"
            :class="{ disabled: item.disabled }"
            @click="handleItemClick(item)"
          >
            <span v-if="item.icon" class="context-menu-icon">{{ item.icon }}</span>
            <span class="context-menu-label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="context-menu-shortcut">{{ item.shortcut }}</span>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'

export interface MenuItem {
  id?: string
  label?: string
  icon?: string
  shortcut?: string
  action?: () => void
  handler?: () => void
  disabled?: boolean
  separator?: boolean
  divider?: boolean
}

interface Props {
  modelValue: boolean
  x: number
  y: number
  items: MenuItem[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'select': [item: MenuItem]
}>()

const menuRef = ref<HTMLDivElement | null>(null)

const menuStyle = computed(() => {
  let left = props.x
  let top = props.y

  // Adjust position if menu would overflow viewport
  if (menuRef.value) {
    const rect = menuRef.value.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    if (left + rect.width > viewportWidth) {
      left = viewportWidth - rect.width - 10
    }
    if (top + rect.height > viewportHeight) {
      top = viewportHeight - rect.height - 10
    }
  }

  return {
    left: `${left}px`,
    top: `${top}px`
  }
})

function handleItemClick(item: MenuItem) {
  if (item.disabled) return

  // Support both action and handler for backwards compatibility
  if (item.action) {
    item.action()
  } else if (item.handler) {
    item.handler()
  }

  emit('select', item)
  emit('update:modelValue', false)
}

function handleClickOutside(event: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
    emit('update:modelValue', false)
  }
}

function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('update:modelValue', false)
  }
}

watch(() => props.modelValue, async (visible) => {
  if (visible) {
    await nextTick()
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
  } else {
    document.removeEventListener('click', handleClickOutside)
    document.removeEventListener('keydown', handleEscape)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleEscape)
})
</script>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  max-width: 300px;
  background: var(--context-menu-bg, #ffffff);
  border: 1px solid var(--context-menu-border, #e0e0e0);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 4px 0;
  font-size: 13px;
  user-select: none;
}

.context-menu-items {
  display: flex;
  flex-direction: column;
}

.context-menu-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s;
  gap: 8px;
}

.context-menu-item:hover:not(.disabled) {
  background-color: var(--context-menu-hover, #f5f5f5);
}

.context-menu-item.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.context-menu-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.context-menu-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-menu-shortcut {
  font-size: 11px;
  color: var(--context-menu-shortcut, #999);
  margin-left: auto;
}

.context-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background-color: var(--context-menu-border, #e0e0e0);
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .context-menu {
    --context-menu-bg: #2d2d2d;
    --context-menu-border: #404040;
    --context-menu-hover: #3d3d3d;
    --context-menu-shortcut: #888;
    color: #e0e0e0;
  }
}
</style>

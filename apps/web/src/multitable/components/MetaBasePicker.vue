<template>
  <div class="meta-base-picker">
    <div class="meta-base-picker__current" @click="open = !open">
      <span class="meta-base-picker__icon" :style="activeBase ? { background: activeBase.color ?? '#409eff' } : {}">
        {{ activeBase?.icon ?? '📋' }}
      </span>
      <span class="meta-base-picker__name">{{ activeBase?.name ?? 'Select Base' }}</span>
      <span class="meta-base-picker__arrow">{{ open ? '▲' : '▼' }}</span>
    </div>

    <div v-if="open" class="meta-base-picker__dropdown">
      <div class="meta-base-picker__search">
        <input
          v-model="search"
          class="meta-base-picker__search-input"
          placeholder="Search bases..."
          @keydown.escape="open = false"
        />
      </div>
      <div class="meta-base-picker__list">
        <div
          v-for="base in filteredBases"
          :key="base.id"
          class="meta-base-picker__item"
          :class="{ 'meta-base-picker__item--active': base.id === activeBaseId }"
          @click="onSelect(base.id)"
        >
          <span class="meta-base-picker__item-icon" :style="{ background: base.color ?? '#409eff' }">{{ base.icon ?? '📋' }}</span>
          <span class="meta-base-picker__item-name">{{ base.name }}</span>
        </div>
        <div v-if="!filteredBases.length" class="meta-base-picker__empty">No bases found</div>
      </div>
      <div v-if="canCreate" class="meta-base-picker__create">
        <input
          v-model="newBaseName"
          class="meta-base-picker__create-input"
          placeholder="New base name..."
          @keydown.enter="onCreate"
        />
        <button class="meta-base-picker__create-btn" :disabled="!newBaseName.trim()" @click="onCreate">+</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaBase } from '../types'

const props = defineProps<{
  bases: MetaBase[]
  activeBaseId: string
  canCreate?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', baseId: string): void
  (e: 'create', name: string): void
}>()

const open = ref(false)
const search = ref('')
const newBaseName = ref('')

const activeBase = computed(() => props.bases.find((b) => b.id === props.activeBaseId) ?? null)

const filteredBases = computed(() => {
  const q = search.value.toLowerCase().trim()
  if (!q) return props.bases
  return props.bases.filter((b) => b.name.toLowerCase().includes(q))
})

function onSelect(baseId: string) {
  emit('select', baseId)
  open.value = false
  search.value = ''
}

function onCreate() {
  const name = newBaseName.value.trim()
  if (!name) return
  emit('create', name)
  newBaseName.value = ''
}
</script>

<style scoped>
.meta-base-picker { position: relative; }
.meta-base-picker__current { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; border-radius: 6px; }
.meta-base-picker__current:hover { background: #f5f7fa; }
.meta-base-picker__icon { width: 24px; height: 24px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #fff; }
.meta-base-picker__name { font-size: 14px; font-weight: 600; color: #333; }
.meta-base-picker__arrow { font-size: 10px; color: #999; }
.meta-base-picker__dropdown { position: absolute; top: 100%; left: 0; min-width: 260px; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); z-index: 50; overflow: hidden; }
.meta-base-picker__search { padding: 8px; border-bottom: 1px solid #eee; }
.meta-base-picker__search-input { width: 100%; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-base-picker__list { max-height: 200px; overflow-y: auto; }
.meta-base-picker__item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.meta-base-picker__item:hover { background: #f5f7fa; }
.meta-base-picker__item--active { background: #ecf5ff; }
.meta-base-picker__item-icon { width: 20px; height: 20px; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff; flex-shrink: 0; }
.meta-base-picker__item-name { font-size: 13px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-base-picker__empty { padding: 16px; text-align: center; color: #999; font-size: 12px; }
.meta-base-picker__create { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #eee; }
.meta-base-picker__create-input { flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.meta-base-picker__create-btn { width: 28px; height: 28px; border: none; background: #409eff; color: #fff; border-radius: 4px; cursor: pointer; font-size: 16px; }
.meta-base-picker__create-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

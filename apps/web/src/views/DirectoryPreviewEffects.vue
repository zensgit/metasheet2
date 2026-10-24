<template>
  <section data-testid="directory-preview-effects" aria-label="同步影响预览">
    <p>按当前数据估算，实际结果以同步执行为准；角色与命名空间的关联数量不等同于最终有效权限。</p>
    <div class="directory-preview-effects">
      <span v-for="field in directoryPreviewEffectFields" :key="field.key" :data-preview-effect="field.key">
        {{ field.label }} {{ formatDirectoryPreviewEffect(effects[field.key]) }}
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { directoryPreviewEffectFields, formatDirectoryPreviewEffect, type DirectoryPreviewEffectCounts } from './directoryPreviewEffects'
defineProps<{ effects: Partial<DirectoryPreviewEffectCounts> }>()
</script>

<style scoped>
.directory-preview-effects {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}
</style>

<template>
  <section data-testid="tasks-home">
    <h1>{{ title }}</h1>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'

const { isZh } = useLocale()
const title = computed(() => (isZh.value ? '任务' : 'Tasks'))
</script>

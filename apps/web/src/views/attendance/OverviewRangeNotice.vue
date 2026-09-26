<script setup lang="ts">
defineProps<{
  kind: 'records' | 'requests' | 'anomalies'
  note: string
  loadMoreLabel: string
  loading?: boolean
}>()

defineEmits<{
  loadMore: []
}>()
</script>

<template>
  <p
    v-if="note"
    class="attendance__field-hint"
    data-overview-range-notice
    :data-overview-range-kind="kind"
  >
    {{ note }}
    <button
      type="button"
      class="attendance__btn attendance__btn--inline"
      data-overview-range-load-more
      :disabled="loading"
      @click="$emit('loadMore')"
    >
      {{ loadMoreLabel }}
    </button>
  </p>
</template>

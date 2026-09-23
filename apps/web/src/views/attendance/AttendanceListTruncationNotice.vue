<script setup lang="ts">
import { computed } from 'vue'
import {
  ATTENDANCE_ADMIN_LIST_MAX_PAGES,
  attendanceAdminListTruncationKind,
} from './attendanceAdminListPage'

const props = withDefaults(defineProps<{
  tr: (en: string, zh: string) => string
  listKey: string
  loaded: number
  total: number
  page: number
  lastPageCount: number
  loading?: boolean
  maxPages?: number
}>(), {
  loading: false,
  maxPages: ATTENDANCE_ADMIN_LIST_MAX_PAGES,
})

const emit = defineEmits<{
  loadMore: []
}>()

const kind = computed(() => attendanceAdminListTruncationKind({
  loaded: props.loaded,
  total: props.total,
  page: props.page,
  lastPageCount: props.lastPageCount,
  maxPages: props.maxPages,
}))
</script>

<template>
  <div
    v-if="kind !== 'complete'"
    class="attendance__field-hint"
    :data-attendance-list-truncated="listKey"
  >
    {{ tr(`Showing ${loaded} of ${total}.`, `已显示 ${loaded}/${total}。`) }}
    <button
      v-if="kind === 'more'"
      type="button"
      class="attendance__btn"
      :disabled="loading"
      :data-attendance-list-load-more="listKey"
      @click="emit('loadMore')"
    >
      {{ loading ? tr('Loading...', '加载中...') : tr('Load more', '加载更多') }}
    </button>
    <span v-else-if="kind === 'capped'" :data-attendance-list-cap="listKey">
      {{ tr('Stopped at the load cap.', '已达到连续加载上限。') }}
    </span>
    <span v-else :data-attendance-list-stalled="listKey">
      {{ tr('No further rows were returned.', '没有返回更多行。') }}
    </span>
  </div>
</template>

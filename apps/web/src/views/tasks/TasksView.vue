<template>
  <section class="tasks-view" aria-labelledby="tasks-view-title">
    <template v-if="contextState?.state === 'ready'">
      <header class="tasks-view__header">
        <h1 id="tasks-view-title">任务</h1>
      </header>
      <p class="tasks-view__placeholder" data-testid="tasks-view-placeholder">
        任务列表将随后端接口一并提供
      </p>
    </template>

    <template v-else-if="contextState?.state === 'org_missing'">
      <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
        请先选择一个组织后再查看任务
      </p>
    </template>

    <template v-else-if="contextState?.state === 'unavailable'">
      <p class="tasks-view__message" data-testid="tasks-view-unavailable" role="status">
        任务功能未启用或当前服务不支持
      </p>
    </template>

    <template v-else-if="contextState?.state === 'forbidden'">
      <p class="tasks-view__message" data-testid="tasks-view-forbidden" role="status">
        您没有权限查看任务
      </p>
    </template>

    <template v-else-if="contextState?.state === 'error'">
      <p class="tasks-view__message" data-testid="tasks-view-error" role="status">
        加载任务时出现错误，请稍后重试
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { loadTasksContext, type TasksContextResult } from '../../tasks/tasksContext'

const contextState = ref<TasksContextResult | null>(null)

onMounted(async () => {
  contextState.value = await loadTasksContext()
})
</script>

<style scoped>
.tasks-view {
  padding: 24px;
}

.tasks-view__header h1 {
  margin: 0 0 8px;
}

.tasks-view__placeholder,
.tasks-view__message {
  color: var(--el-text-color-secondary, #666);
}
</style>

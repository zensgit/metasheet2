<template>
  <form class="list-create-task" data-testid="list-create-form" @submit.prevent="submit">
    <label for="list-create-title">{{ t.createTitlePlaceholder }}</label>
    <input
      id="list-create-title"
      v-model="title"
      data-testid="list-create-title"
      type="text"
      :readonly="retryTaskId !== null"
      :disabled="pending"
      :aria-describedby="retryTaskId !== null || createFailure ? 'list-create-message' : undefined"
      @input="createFailure = null"
    />
    <button type="submit" data-testid="list-create-submit" :disabled="pending || !title.trim()">
      {{ retryTaskId === null ? t.listCreateAndAdd : t.listRetryAdd }}
    </button>
    <p v-if="retryTaskId !== null || createFailure" id="list-create-message" data-testid="list-create-message" role="alert">
      {{ retryTaskId !== null ? t.listCreatedAddFailed : createFailureText }}
    </p>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { codeMessage, TASKS_EN, TASKS_ZH } from '../../tasks/labels'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'
import { addTaskToList, createTask, type CreateTaskResult } from '../../tasks/tasksApi'

const props = defineProps<{
  pending: boolean
  runWrite: (action: (listId: string, isCurrent: () => boolean) => Promise<boolean>) => Promise<void>
}>()
const emit = defineEmits<{
  'org-missing': []
  'add-failed': [kind: 'org_missing' | 'forbidden' | 'not_found']
}>()
const { isZh } = useLocale()
const t = computed(() => isZh.value ? TASKS_ZH : TASKS_EN)
const title = ref('')
const retryTaskId = ref<string | null>(null)
const createFailure = ref<Exclude<CreateTaskResult, { kind: 'ok' }> | null>(null)
const createFailureText = computed(() => {
  const failure = createFailure.value
  if (failure?.kind === 'invalid_title') return t.value.createInvalidTitle
  if (failure?.kind === 'validation') return codeMessage(failure.code, t.value)
  return t.value.createFailed
})

function reset(): void {
  title.value = ''
  retryTaskId.value = null
  createFailure.value = null
}

async function submit(): Promise<void> {
  const trimmedTitle = title.value.trim()
  if (!trimmedTitle) return
  await props.runWrite(async (listId, isCurrent) => {
    createFailure.value = null
    let taskId = retryTaskId.value
    if (taskId === null) {
      const created = await createTask({ title: trimmedTitle })
      if (created.kind === 'ok') notifyTasksChanged()
      if (!isCurrent()) return false
      if (created.kind !== 'ok') {
        if (created.kind === 'org_missing') emit('org-missing')
        else createFailure.value = created
        return false
      }
      taskId = created.id
    }
    const added = await addTaskToList(listId, taskId)
    if (!isCurrent()) return false
    if (added.kind !== 'ok') {
      retryTaskId.value = taskId
      if (added.kind === 'org_missing' || added.kind === 'forbidden' || added.kind === 'not_found') {
        emit('add-failed', added.kind)
      }
      return false
    }
    reset()
    return true
  })
}

defineExpose({ reset })
</script>

<style scoped>
.list-create-task {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-block: 12px;
}

.list-create-task input {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.list-create-task p {
  flex-basis: 100%;
  margin: 0;
  color: var(--el-color-danger);
}
</style>

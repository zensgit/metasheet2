<!--
  D6 R1 session-org switcher. Canonical-Org-line UI hosted on the self-service
  attendance surface. It remints the session claim only — it does not write the
  history-filter / punch `orgId` box (F2: attendance routes keep today's getOrgId).
-->
<template>
  <section
    v-if="loading || orgs.length > 0 || errorMessage"
    class="attendance-session-org"
    data-testid="attendance-session-org-switcher"
  >
    <label class="attendance-session-org__field" for="attendance-session-org">
      <span>{{ tr('Organization', '组织') }}</span>
      <select
        id="attendance-session-org"
        name="sessionOrgId"
        :value="modelValue"
        :disabled="disabled || loading || switching || orgs.length === 0"
        @change="onChange"
      >
        <option v-if="!modelValue" value="">
          {{ tr('Select organization', '选择组织') }}
        </option>
        <option v-for="org in orgs" :key="org" :value="org">
          {{ org }}
        </option>
      </select>
    </label>
    <small v-if="hintText" class="attendance-session-org__hint">{{ hintText }}</small>
    <small
      v-if="errorMessage"
      class="attendance-session-org__hint attendance-session-org__hint--error"
    >
      {{ errorMessage }}
    </small>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  tr: (en: string, zh: string) => string
  orgs: string[]
  modelValue: string
  loading?: boolean
  switching?: boolean
  disabled?: boolean
  errorMessage?: string
  hasUsableClaim?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const hintText = computed(() => {
  if (props.loading) return props.tr('Loading organizations…', '正在加载组织…')
  if (props.orgs.length === 0) return props.tr('No organization memberships.', '没有组织成员资格。')
  if (props.orgs.length > 1 && !props.hasUsableClaim && !props.modelValue) {
    return props.tr(
      'Choose an organization. The session will not invent one.',
      '请选择组织。会话不会自动指定。',
    )
  }
  return props.tr(
    'Session organization. Punch history still uses the Org ID filter.',
    '会话组织。打卡记录仍使用组织 ID 筛选框。',
  )
})

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value?.trim() ?? ''
  if (!value) return
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<script lang="ts">
export default {
  name: 'AttendanceSessionOrgSwitcher',
}
</script>

<style scoped>
.attendance-session-org {
  display: grid;
  gap: 4px;
  min-width: 220px;
}

.attendance-session-org__field {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: #3d4f5f;
}

.attendance-session-org__field select {
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid #d7dde7;
  border-radius: 8px;
  background: #fff;
  color: #12263a;
}

.attendance-session-org__hint {
  color: #66788a;
  font-size: 12px;
}

.attendance-session-org__hint--error {
  color: #b42318;
}
</style>

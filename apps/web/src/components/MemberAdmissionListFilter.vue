<template>
  <div v-if="namespaces.length > 0" class="member-admission-filter" data-testid="member-admission-filter">
    <label class="member-admission-filter__field">
      <span>插件命名空间</span>
      <select
        class="member-admission-filter__select"
        data-testid="member-admission-namespace"
        aria-label="按插件命名空间筛选"
        :value="namespace"
        @change="onNamespaceChange"
      >
        <option value="">全部</option>
        <option v-for="item in namespaces" :key="item" :value="item">{{ item }}</option>
      </select>
    </label>
    <label class="member-admission-filter__field">
      <span>开通状态</span>
      <select
        class="member-admission-filter__select"
        data-testid="member-admission-status"
        aria-label="开通状态"
        :value="status"
        :disabled="!namespace"
        @change="onStatusChange"
      >
        <option value="">全部</option>
        <option value="enabled">已开通</option>
        <option value="disabled">未开通</option>
      </select>
    </label>
    <p class="member-admission-filter__hint" data-testid="member-admission-filter-note">
      筛选的是开通记录。业务是否可用还受角色和权限控制。
    </p>
  </div>
</template>

<script setup lang="ts">
export type MemberAdmissionFilterStatus = '' | 'enabled' | 'disabled'

const props = defineProps<{
  namespaces: readonly string[]
  namespace: string
  status: MemberAdmissionFilterStatus
}>()

const emit = defineEmits<{
  'update:namespace': [namespace: string]
  'update:status': [status: MemberAdmissionFilterStatus]
}>()

function isStatus(value: string): value is MemberAdmissionFilterStatus {
  return value === '' || value === 'enabled' || value === 'disabled'
}

function onNamespaceChange(event: Event): void {
  const next = (event.target as HTMLSelectElement).value
  emit('update:namespace', next)
  if (!next && props.status !== '') emit('update:status', '')
}

function onStatusChange(event: Event): void {
  if (!props.namespace) return
  const next = (event.target as HTMLSelectElement).value
  if (!isStatus(next)) return
  emit('update:status', next)
}
</script>

<style scoped>
.member-admission-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.member-admission-filter__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: #334155;
  font-size: 13px;
}

.member-admission-filter__select {
  min-width: 180px;
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 12px;
  font: inherit;
  background: #fff;
}

.member-admission-filter__select:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.member-admission-filter__hint {
  margin: 0;
  color: #6b7280;
  font-size: 13px;
}
</style>

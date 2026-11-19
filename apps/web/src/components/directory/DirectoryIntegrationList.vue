<template>
<aside class="directory-admin__panel directory-admin__panel--list">
        <div class="directory-admin__section-head">
          <div>
            <h2>集成列表</h2>
            <p class="directory-admin__hint">当前仅支持钉钉目录拉取与手动同步。</p>
          </div>
        </div>

        <div v-if="integrationsLoadError" role="alert" data-testid="directory-list-error">
          <p>目录集成加载失败，无法确认当前集成。请重试；若仍失败，请联系管理员检查服务端配置。</p>
          <button type="button" class="directory-admin__button" :disabled="loading" @click="void loadIntegrations()">重试加载集成</button>
        </div>
        <div v-else-if="!integrationsLoaded" class="directory-admin__empty">正在加载目录集成…</div>
        <div v-else-if="integrations.length === 0" class="directory-admin__empty">暂无目录集成</div>
        <component
          :is="group.status === 'paused' ? 'details' : 'div'"
          v-for="group in integrationGroups"
          :key="group.status"
          class="directory-admin__integration-group"
        >
          <summary v-if="group.status === 'paused'">已暂停（{{ group.items.length }}）</summary>
          <p v-else-if="group.status === 'unknown'" class="directory-admin__hint">状态未知</p>
          <div class="directory-admin__integration-items">
        <button
          v-for="integration in group.items"
          :key="integration.id"
          class="directory-admin__item"
          :class="{ 'directory-admin__item--active': selectedIntegrationId === integration.id }"
          type="button"
          @click="void selectIntegration(integration.id)"
        >
          <strong>钉钉 · {{ integration.config.corpName || '企业名称未提供' }}</strong>
          <span>用途：{{ integration.name }}</span>
          <span>应用：{{ integration.config.appName || '应用名称未提供' }}</span>
          <small
            class="directory-admin__chip"
            :class="{
              'directory-admin__chip--success': integration.status === 'active',
              'directory-admin__chip--warning': integration.status !== 'active',
            }"
            data-testid="directory-integration-status"
          >{{ integration.status === 'active' ? '活跃' : integration.status === 'paused' ? '已暂停' : '状态未知' }}</small>
          <small data-testid="directory-identity-status" :class="{ 'directory-admin__chip directory-admin__chip--warning': integration.config.identityStatus === 'mismatch' }" :role="integration.config.identityStatus === 'mismatch' ? 'alert' : undefined">
            身份：{{ integration.config.identityStatus === 'mismatch' ? '企业与应用归属不一致' : integration.config.identityStatus === 'verified' ? '管理员已核验' : '未核验' }}
          </small>
          <small v-if="integration.config.identityVerification">应用所属企业：{{ integration.config.identityVerification.appCorpName }}</small>
          <small>自动同步：{{ integration.syncEnabled ? '开启' : '关闭' }}</small>
          <small>Corp ID：{{ integration.corpId }}</small>
          <small>本地组织：{{ integration.orgId || '未提供' }}</small>
          <small>{{ readAdmissionModeLabel(integration) }}</small>
          <small>{{ readMemberGroupSyncLabel(integration) }}</small>
          <small>
            账号 {{ integration.stats.accountCount }} / 部门 {{ integration.stats.departmentCount }} / 待确认 {{ integration.stats.pendingLinkCount }}
          </small>
          <small>
            最近同步：{{ formatDateTime(integration.lastSyncAt) }} · {{ integration.stats.lastRunStatus || '未运行' }}
          </small>
          <small>最近成功同步：{{ formatDateTime(integration.lastSuccessAt) }}</small>
        </button>
          </div>
        </component>
      </aside>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  formatDateTime,
  integrations,
  integrationsLoadError,
  integrationsLoaded,
  loadIntegrations,
  loading,
  readAdmissionModeLabel,
  readMemberGroupSyncLabel,
  selectIntegration,
  selectedIntegrationId,
} = inject(directoryManagementKey)!

const integrationGroups = computed(() => {
  if (!integrationsLoaded.value || integrationsLoadError.value) return []

  const sorted = [...integrations.value].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN') || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  )

  return [
    { status: 'active', items: sorted.filter(integration => integration.status === 'active') },
    { status: 'unknown', items: sorted.filter(integration => !['active', 'paused'].includes(integration.status)) },
    { status: 'paused', items: sorted.filter(integration => integration.status === 'paused') },
  ].filter(group => group.items.length > 0)
})
</script>

<style scoped src="./directory-admin.css"></style>

<style scoped>
.directory-admin__integration-items {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__integration-group > summary {
  cursor: pointer;
  margin-bottom: 12px;
}
</style>

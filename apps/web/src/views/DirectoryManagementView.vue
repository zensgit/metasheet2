<template>
  <section class="directory-admin">
    <header class="directory-admin__header">
      <div>
        <h1>目录同步</h1>
        <p>管理钉钉组织目录集成，执行连通性测试，并手动触发同步。</p>
      </div>

      <div class="directory-admin__actions">
        <router-link class="directory-admin__link" to="/admin/users">用户管理</router-link>
        <router-link class="directory-admin__link" to="/admin/roles">角色管理</router-link>
        <router-link class="directory-admin__link" to="/admin/audit">管理审计</router-link>
        <router-link class="directory-admin__link" to="/help/attendance/dingtalk-microapp">钉钉微应用配置帮助</router-link>
        <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loading" @click="void loadIntegrations()">
          {{ loading ? '刷新中...' : '刷新列表' }}
        </button>
        <button class="directory-admin__button" type="button" @click="resetDraft()">新建集成</button>
      </div>
    </header>

    <p v-if="status" class="directory-admin__status" :class="{ 'directory-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <DirectoryOperationResults />

    <div class="directory-admin__layout">
      <DirectoryIntegrationList />

      <section class="directory-admin__panel directory-admin__panel--detail">
        <nav class="directory-admin__tabs" role="tablist" aria-label="目录集成详情">
          <button
            v-for="(tab, index) in directoryTabs"
            :id="`directory-tab-${tab.id}`"
            :key="tab.id"
            class="directory-admin__button directory-admin__button--secondary"
            :class="{ 'directory-admin__button--active': activeDirectoryTab === tab.id }"
            type="button"
            role="tab"
            :aria-selected="activeDirectoryTab === tab.id"
            :aria-controls="`directory-panel-${tab.id}`"
            :tabindex="activeDirectoryTab === tab.id ? 0 : -1"
            @click="setDirectoryTab(tab.id)"
            @keydown="handleTabKeydown($event, index)"
          >{{ tab.label }}</button>
        </nav>

        <div id="directory-panel-settings" v-show="activeDirectoryTab === 'settings'" class="directory-admin__settings" role="tabpanel" aria-labelledby="directory-tab-settings">
          <DirectoryIntegrationForm />
          <section v-if="testResult" class="directory-admin__section">
            <h3>连通性测试</h3>
            <div v-if="testResult.summary" class="directory-admin__diagnostic-summary">
              <strong>{{ testResult.summary.title }}</strong>
              <p class="directory-admin__hint">{{ testResult.summary.nextAction }}</p>
            </div>
            <div class="directory-admin__chips">
              <span class="directory-admin__chip">部门样本 {{ testResult.departmentSampleCount }}</span>
              <span class="directory-admin__chip">用户样本 {{ testResult.userSampleCount }}</span>
              <span class="directory-admin__chip">Root {{ testResult.rootDepartmentId }}</span>
              <span class="directory-admin__chip">根部门子部门 {{ testResult.diagnostics.rootDepartmentChildCount }}</span>
              <span class="directory-admin__chip">根部门直属成员 {{ testResult.diagnostics.rootDepartmentDirectUserCount }}</span>
              <span class="directory-admin__chip">含受限成员 {{ testResult.diagnostics.rootDepartmentDirectUserCountWithAccessLimit }}</span>
            </div>
            <p class="directory-admin__hint">
              部门：{{ testResult.sampledDepartments.map((item) => item.name).join('，') || '无' }}
            </p>
            <p class="directory-admin__hint">
              用户：{{ testResult.sampledUsers.map((item) => item.name).join('，') || '无' }}
            </p>
            <p class="directory-admin__hint">
              根部门直属用户：{{ formatSampleUsers(testResult.diagnostics.sampledRootDepartmentUsers, testResult.diagnostics.rootDepartmentDirectUserHasMore) }}
            </p>
            <p class="directory-admin__hint">
              根部门直属用户（含受限）：{{ formatSampleUsers(testResult.diagnostics.sampledRootDepartmentUsersWithAccessLimit, testResult.diagnostics.rootDepartmentDirectUserHasMoreWithAccessLimit) }}
            </p>
            <p
              v-for="warning in testResult.warnings"
              :key="warning"
              class="directory-admin__status directory-admin__status--error"
            >
              {{ warning }}
            </p>
          </section>
        </div>

        <section id="directory-panel-overview" v-show="activeDirectoryTab === 'overview'" class="directory-admin__section" role="tabpanel" aria-labelledby="directory-tab-overview">
          <h3>当前概览</h3>
          <p v-if="!selectedIntegration" class="directory-admin__hint">请选择一个集成，或点击“新建集成”填写连接配置。</p>
          <div v-if="selectedIntegration" class="directory-admin__overview-grid" data-testid="directory-overview-cards">
            <article class="directory-admin__overview-card"><span>部门</span><strong>{{ selectedIntegration.stats.departmentCount }}</strong><small>启用的目录部门</small></article>
            <article class="directory-admin__overview-card"><span>账号</span><strong>{{ selectedIntegration.stats.accountCount }}</strong><small>启用的目录账号</small></article>
            <article class="directory-admin__overview-card"><span>已关联</span><strong>{{ selectedIntegration.stats.linkedCount }}</strong><small>集成关联统计（含停用账号）</small></article>
            <article class="directory-admin__overview-card"><span>待确认</span><strong>{{ selectedIntegration.stats.pendingLinkCount }}</strong><small>集成关联统计（含停用账号）</small></article>
            <article class="directory-admin__overview-card" data-overview="unmatched"><span>未匹配（当前成员页）</span><strong>{{ loadingAccounts ? '加载中...' : accountsLoadFailed ? '加载失败' : accountSnapshotIntegrationId !== selectedIntegration.id ? '尚未加载' : accounts.filter((account) => account.linkStatus === 'unmatched').length }}</strong><small>不是全量统计，受成员搜索与分页影响</small></article>
            <article class="directory-admin__overview-card"><span>最近成功同步</span><strong>{{ formatDateTime(selectedIntegration.lastSuccessAt) }}</strong></article>
            <article class="directory-admin__overview-card" data-overview="schedule">
              <span>自动同步状态</span>
              <strong>{{ loadingSchedule ? '加载中...' : scheduleLoadFailed ? '加载失败' : scheduleSnapshot ? readObservationStatusLabel(scheduleSnapshot.observationStatus) : '暂无观测' }}</strong>
              <small v-if="!loadingSchedule && !scheduleLoadFailed && scheduleSnapshot">{{ scheduleSnapshot.syncEnabled ? '自动同步已启用' : '仅手动同步' }} · 下次执行 {{ formatDateTime(scheduleSnapshot.nextExpectedRunAt) }}</small>
            </article>
            <article class="directory-admin__overview-card" data-overview="alerts">
              <span>最近告警</span>
              <strong>{{ loadingAlerts ? '加载中...' : alertsLoadFailed ? '加载失败' : alertSnapshotIntegrationId !== selectedIntegration.id ? '尚未加载' : alertCounts.all }}</strong>
              <template v-if="!loadingAlerts && !alertsLoadFailed && alertSnapshotIntegrationId === selectedIntegration.id">
                <small>当前已加载 {{ alertCounts.all }} 条，待确认 {{ alertCounts.pending }} 条；不是历史总数</small>
                <span v-if="alerts[0]">{{ readAlertLevelLabel(alerts[0].level) }} · {{ alerts[0].code }} · {{ formatDateTime(alerts[0].createdAt) }}</span>
              </template>
            </article>
          </div>
          <div v-if="selectedIntegration" class="directory-admin__chips">
            <span class="directory-admin__chip">{{ readAdmissionModeLabel(selectedIntegration) }}</span>
            <span class="directory-admin__chip">{{ readMemberGroupSyncLabel(selectedIntegration) }}</span>
          </div>
          <p v-if="selectedIntegration?.lastError" class="directory-admin__status directory-admin__status--error">
            最近错误：{{ selectedIntegration.lastError }}
          </p>
        </section>

        <div id="directory-panel-organization" v-show="activeDirectoryTab === 'organization'" role="tabpanel" aria-labelledby="directory-tab-organization">
          <DirectoryOrgMirrorSection />
        </div>

        <div id="directory-panel-review" v-show="activeDirectoryTab === 'review'" role="tabpanel" aria-labelledby="directory-tab-review">
          <DirectoryReviewQueueSection />
        </div>

        <div id="directory-panel-accounts" ref="accountsSectionRef" v-show="activeDirectoryTab === 'accounts'" role="tabpanel" aria-labelledby="directory-tab-accounts">
          <DirectoryAccountsSection />
        </div>

        <div id="directory-panel-sync" class="directory-admin__sync" v-show="activeDirectoryTab === 'sync'" role="tabpanel" aria-labelledby="directory-tab-sync">
          <div class="directory-admin__actions" data-testid="directory-sync-actions">
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || previewBusy || pollingRunId !== '' || !selectedIntegration" @click="void previewSync()">
              {{ previewBusy ? '预览中...' : '预览同步' }}
            </button>
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || pollingRunId !== '' || !selectedIntegration" @click="void syncIntegration()">
              手动同步
            </button>
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || asyncSyncBusy || pollingRunId !== '' || !selectedIntegration" @click="void startAsyncSync()">
              {{ asyncSyncBusy ? '启动中...' : pollingRunId ? '后台同步中...' : '后台同步' }}
            </button>
          </div>
          <p v-if="pollingRunId" class="directory-admin__hint">
            后台同步进行中（运行 {{ pollingRunId }}），每 5 秒自动刷新运行记录。后台模式不返回一次性临时凭据。
          </p>
          <DirectorySyncPreviewSection />
          <DirectorySyncObservationSection />
          <DirectoryRunsSection />
          <DirectoryDeprovisionEvidencePanel
            v-if="selectedIntegration"
            :integration-id="selectedIntegration.id"
          />
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { provide } from 'vue'
import DirectoryAccountsSection from '../components/directory/DirectoryAccountsSection.vue'
import DirectoryDeprovisionEvidencePanel from '../components/directory/DirectoryDeprovisionEvidencePanel.vue'
import DirectoryIntegrationForm from '../components/directory/DirectoryIntegrationForm.vue'
import DirectoryIntegrationList from '../components/directory/DirectoryIntegrationList.vue'
import DirectoryOrgMirrorSection from '../components/directory/DirectoryOrgMirrorSection.vue'
import DirectoryOperationResults from '../components/directory/DirectoryOperationResults.vue'
import DirectoryReviewQueueSection from '../components/directory/DirectoryReviewQueueSection.vue'
import DirectoryRunsSection from '../components/directory/DirectoryRunsSection.vue'
import DirectorySyncObservationSection from '../components/directory/DirectorySyncObservationSection.vue'
import DirectorySyncPreviewSection from '../components/directory/DirectorySyncPreviewSection.vue'
import { directoryManagementKey, useDirectoryManagement } from '../components/directory/useDirectoryManagement'

const directoryManagement = useDirectoryManagement()
provide(directoryManagementKey, directoryManagement)

const {
  activeDirectoryTab,
  accountsSectionRef,
  accounts,
  accountSnapshotIntegrationId,
  accountsLoadFailed,
  alertCounts,
  alertSnapshotIntegrationId,
  alertsLoadFailed,
  alerts,
  asyncSyncBusy,
  busy,
  directoryTabs,
  formatDateTime,
  formatSampleUsers,
  loadIntegrations,
  loading,
  loadingAlerts,
  loadingAccounts,
  loadingSchedule,
  pollingRunId,
  previewBusy,
  previewSync,
  readAdmissionModeLabel,
  readAlertLevelLabel,
  readMemberGroupSyncLabel,
  readObservationStatusLabel,
  resetDraft,
  selectedIntegration,
  scheduleSnapshot,
  scheduleLoadFailed,
  setDirectoryTab,
  status,
  statusTone,
  startAsyncSync,
  syncIntegration,
  testResult,
} = directoryManagement

function handleTabKeydown(event: KeyboardEvent, index: number) {
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % directoryTabs.length
  else if (event.key === 'ArrowLeft') next = (index + directoryTabs.length - 1) % directoryTabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = directoryTabs.length - 1
  else return
  event.preventDefault()
  const tab = directoryTabs[next]
  setDirectoryTab(tab.id)
  const tablist = (event.currentTarget as HTMLElement).parentElement
  tablist?.querySelector<HTMLButtonElement>(`#directory-tab-${tab.id}`)?.focus()
}
</script>

<style scoped src="../components/directory/directory-admin.css"></style>

<template>
<section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>自动同步观测</h3>
              <p class="directory-admin__hint">展示 cron 配置、预计下次运行、最近自动触发和观测状态。</p>
            </div>
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="loadingSchedule"
              @click="void loadScheduleSnapshot(selectedIntegration.id)"
            >
              {{ loadingSchedule ? '刷新中...' : '刷新观测' }}
            </button>
          </div>
          <div v-if="loadingSchedule" class="directory-admin__empty">自动同步观测加载中...</div>
          <div v-else-if="!scheduleSnapshot" class="directory-admin__empty">暂无自动同步观测</div>
          <article v-else class="directory-admin__schedule-card">
            <div class="directory-admin__chips">
              <span class="directory-admin__chip" :class="readObservationStatusClass(scheduleSnapshot.observationStatus)">
                {{ readObservationStatusLabel(scheduleSnapshot.observationStatus) }}
              </span>
              <span class="directory-admin__chip" :class="{ 'directory-admin__chip--warning': !scheduleSnapshot.syncEnabled }">
                {{ scheduleSnapshot.syncEnabled ? '自动同步已启用' : '仅手动同步' }}
              </span>
              <span class="directory-admin__chip" :class="{ 'directory-admin__chip--warning': !scheduleSnapshot.cronValid }">
                {{ scheduleSnapshot.scheduleCron || '未配置 cron' }}
              </span>
              <span class="directory-admin__chip">下次执行 {{ formatDateTime(scheduleSnapshot.nextExpectedRunAt) }}</span>
              <span class="directory-admin__chip">触发源 {{ readTriggerSourceLabel(scheduleSnapshot.lastRun?.triggerSource) }}</span>
            </div>
            <p class="directory-admin__hint">{{ scheduleSnapshot.observationMessage }}</p>
            <p class="directory-admin__hint">
              最近自动运行：{{ formatDateTime(scheduleSnapshot.lastAutomaticRun?.startedAt ?? null) }} ·
              最近手动运行：{{ formatDateTime(scheduleSnapshot.lastManualRun?.startedAt ?? null) }} ·
              最近运行：{{ formatDateTime(scheduleSnapshot.lastRun?.startedAt ?? null) }}
            </p>
          </article>
        </section>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>最近告警</h3>
              <p class="directory-admin__hint">展示目录同步告警，并支持确认处理。</p>
            </div>
            <div class="directory-admin__actions">
              <button
                v-for="option in alertFilterOptions"
                :key="option.value"
                class="directory-admin__button directory-admin__button--secondary"
                :class="{ 'directory-admin__button--active': alertFilter === option.value }"
                type="button"
                :disabled="loadingAlerts"
                @click="void updateAlertFilter(option.value)"
              >
                {{ option.label }}{{ alertCounts[option.value] > 0 ? ` (${alertCounts[option.value]})` : '' }}
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="loadingAlerts"
                @click="void loadAlerts(selectedIntegration.id)"
              >
                {{ loadingAlerts ? '刷新中...' : '刷新告警' }}
              </button>
            </div>
          </div>
          <div v-if="loadingAlerts" class="directory-admin__empty">最近告警加载中...</div>
          <div v-else-if="filteredAlerts.length === 0" class="directory-admin__empty">暂无告警</div>
          <article v-for="alert in filteredAlerts" :key="alert.id" class="directory-admin__alert">
            <div class="directory-admin__alert-head">
              <div>
                <strong>{{ readAlertLevelLabel(alert.level) }}</strong>
                <p class="directory-admin__hint">{{ alert.code }} · {{ formatDateTime(alert.createdAt) }}</p>
              </div>
              <div class="directory-admin__chips">
                <span class="directory-admin__chip" :class="readAlertLevelClass(alert.level)">
                  {{ readAlertLevelLabel(alert.level) }}
                </span>
                <span class="directory-admin__chip" :class="{ 'directory-admin__chip--success': Boolean(alert.acknowledgedAt) }">
                  {{ alert.acknowledgedAt ? '已确认' : '待确认' }}
                </span>
              </div>
            </div>
            <p>{{ alert.message }}</p>
            <p v-if="alert.acknowledgedAt" class="directory-admin__hint">
              确认时间：{{ formatDateTime(alert.acknowledgedAt) }}{{ alert.acknowledgedBy ? ` · ${alert.acknowledgedBy}` : '' }}
            </p>
            <div class="directory-admin__actions">
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="acknowledgingAlertId === alert.id || Boolean(alert.acknowledgedAt)"
                @click="void acknowledgeAlert(alert)"
              >
                {{ acknowledgingAlertId === alert.id ? '确认中...' : alert.acknowledgedAt ? '已确认' : '确认告警' }}
              </button>
            </div>
          </article>
        </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  acknowledgeAlert,
  acknowledgingAlertId,
  alertCounts,
  alertFilter,
  alertFilterOptions,
  filteredAlerts,
  formatDateTime,
  loadAlerts,
  loadScheduleSnapshot,
  loadingAlerts,
  loadingSchedule,
  readAlertLevelClass,
  readAlertLevelLabel,
  readObservationStatusClass,
  readObservationStatusLabel,
  readTriggerSourceLabel,
  scheduleSnapshot,
  selectedIntegration,
  updateAlertFilter,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

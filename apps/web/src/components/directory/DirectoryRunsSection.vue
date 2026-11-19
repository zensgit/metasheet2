<template>
<section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>运行记录</h3>
              <p class="directory-admin__hint">展示最近同步执行结果与聚合统计。</p>
            </div>
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingRuns" @click="void loadRuns(selectedIntegration.id)">
              {{ loadingRuns ? '刷新中...' : '刷新记录' }}
            </button>
          </div>
          <div v-if="runs.length === 0" class="directory-admin__empty">暂无运行记录</div>
          <article v-for="run in runs" :key="run.id" class="directory-admin__run">
            <div class="directory-admin__run-head">
              <strong>{{ run.status }}</strong>
              <small>{{ formatDateTime(run.startedAt) }} → {{ formatDateTime(run.finishedAt) }}</small>
            </div>
            <p class="directory-admin__hint">
              账号 {{ readNumericStat(run.stats, 'accountsSynced') }} / 部门 {{ readNumericStat(run.stats, 'departmentsSynced') }} /
              待确认 {{ readNumericStat(run.stats, 'pendingCount') }} / 已链接 {{ readNumericStat(run.stats, 'linkedCount') }}
            </p>
            <!-- R5 per-run change summary (#4054): keys are additive jsonb — gate each line on key
                 presence so pre-R5 runs (keys absent) don't render a misleading all-zero summary. -->
            <p
              v-if="hasRunStat(run.stats, 'accountsCreatedCount') || hasRunStat(run.stats, 'accountsUpdatedCount') || hasRunStat(run.stats, 'departmentsCreatedCount')"
              class="directory-admin__hint"
            >
              本次变更：账号 新增 {{ readNumericStat(run.stats, 'accountsCreatedCount') }} · 更新 {{ readNumericStat(run.stats, 'accountsUpdatedCount') }} · 停用 {{ readNumericStat(run.stats, 'accountsDeactivatedCount') }}
              / 部门 新增 {{ readNumericStat(run.stats, 'departmentsCreatedCount') }} · 更新 {{ readNumericStat(run.stats, 'departmentsUpdatedCount') }} · 停用 {{ readNumericStat(run.stats, 'departmentsDeactivatedCount') }}
            </p>
            <p
              v-if="hasRunStat(run.stats, 'managerCoverage') || hasRunStat(run.stats, 'durationMs')"
              class="directory-admin__hint"
            >
              <template v-if="hasRunStat(run.stats, 'managerCoverage')">主管绑定覆盖 {{ formatManagerCoverage(run.stats) }}</template>
              <template v-if="hasRunStat(run.stats, 'managerCoverage') && hasRunStat(run.stats, 'durationMs')"> · </template>
              <template v-if="hasRunStat(run.stats, 'durationMs')">耗时 {{ formatRunDurationMs(readNumericStat(run.stats, 'durationMs')) }}</template>
            </p>
            <p v-if="readStringStat(run.stats, 'diagnosticTitle')" class="directory-admin__hint">
              诊断：{{ readStringStat(run.stats, 'diagnosticTitle') }}
              · 子部门 {{ readNumericStat(run.stats, 'rootDepartmentChildCount') }}
              · 根部门直属成员 {{ readNumericStat(run.stats, 'rootDepartmentDirectUserCount') }}
              · 含受限 {{ readNumericStat(run.stats, 'rootDepartmentDirectUserCountWithAccessLimit') }}
            </p>
            <p v-if="readStringStat(run.stats, 'diagnosticNextAction')" class="directory-admin__hint">
              建议：{{ readStringStat(run.stats, 'diagnosticNextAction') }}
            </p>
            <p
              v-for="warning in readStringArrayStat(run.stats, 'diagnosticWarnings')"
              :key="warning"
              class="directory-admin__status directory-admin__status--error"
            >
              {{ warning }}
            </p>
            <p v-if="run.errorMessage" class="directory-admin__status directory-admin__status--error">{{ run.errorMessage }}</p>
          </article>
        </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  formatDateTime,
  formatManagerCoverage,
  formatRunDurationMs,
  hasRunStat,
  loadRuns,
  loadingRuns,
  readNumericStat,
  readStringArrayStat,
  readStringStat,
  runs,
  selectedIntegration,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

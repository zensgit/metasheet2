<template>
<section v-if="selectedIntegration && (previewBusy || previewResult)" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>同步预览（dry-run）</h3>
              <p class="directory-admin__hint">只读预演：按同步的方式拉取钉钉通讯录并计算将发生的变更，不写入任何数据。</p>
            </div>
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="busy || previewBusy"
              @click="void previewSync()"
            >
              {{ previewBusy ? '预览中...' : '重新预览' }}
            </button>
          </div>
          <div v-if="previewBusy" class="directory-admin__empty">同步预览生成中（将完整拉取一次钉钉通讯录）...</div>
          <article v-else-if="previewResult" class="directory-admin__schedule-card">
            <div class="directory-admin__chips">
              <span class="directory-admin__chip">部门 {{ previewResult.departmentsSeen }}</span>
              <span class="directory-admin__chip">账号 {{ previewResult.accountsSeen }}</span>
              <span class="directory-admin__chip">将新增账号 {{ previewResult.wouldCreateAccounts }}</span>
              <span class="directory-admin__chip" :class="{ 'directory-admin__chip--warning': previewResult.wouldDeactivateAccounts > 0 }">
                将停用 {{ previewResult.wouldDeactivateAccounts }}
              </span>
              <span class="directory-admin__chip" :class="{ 'directory-admin__chip--danger': previewResult.wouldDeactivateLinkedAccounts > 0 }">
                其中已绑定 {{ previewResult.wouldDeactivateLinkedAccounts }}
              </span>
            </div>
            <p class="directory-admin__hint">
              自动准入：{{ previewResult.autoAdmissionMode === 'auto_for_scoped_departments'
                ? `符合条件 ${previewResult.autoAdmissionCandidateCount} 人 · 缺少邮箱跳过 ${previewResult.autoAdmissionSkippedMissingEmailCount} 人 · 命中排除部门 ${previewResult.autoAdmissionExcludedCount} 人`
                : '已关闭' }}
            </p>
            <p class="directory-admin__hint">
              将新增账号：{{ formatPreviewSample(previewResult.sampledNewAccounts, previewResult.wouldCreateAccounts) }}
            </p>
            <p class="directory-admin__hint">
              将停用账号：{{ formatPreviewDeactivationSample(previewResult.sampledDeactivations, previewResult.wouldDeactivateAccounts) }}
            </p>
          </article>
        </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  busy,
  formatPreviewDeactivationSample,
  formatPreviewSample,
  previewBusy,
  previewResult,
  previewSync,
  selectedIntegration,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

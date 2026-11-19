<template>
<section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>组织架构镜像</h3>
              <p class="directory-admin__hint">
                按需读取已同步的钉钉部门树；这里只展示本地目录镜像，不反写钉钉。
              </p>
            </div>
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="loadingDepartments"
              @click="void loadDepartments(selectedIntegration.id, { force: true })"
            >
              {{ loadingDepartments ? '加载中...' : departmentsLoaded ? '刷新组织架构' : '加载组织架构' }}
            </button>
          </div>
          <div v-if="departmentsLoaded" class="directory-admin__chips">
            <span class="directory-admin__chip">部门 {{ departmentRows.length }}</span>
            <span v-if="departmentFilterActive" class="directory-admin__chip">匹配 {{ visibleDepartmentRows.length }}</span>
            <span v-if="hasScopedDepartmentConfig" class="directory-admin__chip">
              已配置 {{ configuredDepartmentCount }}
            </span>
            <span
              v-if="departmentConfigReferenceIssues.length > 0"
              class="directory-admin__chip directory-admin__chip--warning"
            >
              异常引用 {{ departmentConfigReferenceIssues.length }}
            </span>
            <span class="directory-admin__chip">成员 {{ departmentAccountCount }}</span>
            <span class="directory-admin__chip">已绑定 {{ departmentLinkedAccountCount }}</span>
            <span v-if="departmentUnlinkedAccountCount > 0" class="directory-admin__chip directory-admin__chip--warning">
              未绑定 {{ departmentUnlinkedAccountCount }}
            </span>
            <span v-if="inactiveDepartmentCount > 0" class="directory-admin__chip directory-admin__chip--warning">
              停用部门 {{ inactiveDepartmentCount }}
            </span>
          </div>
          <div
            v-if="departmentsLoaded && departmentRows.length > 0"
            class="directory-admin__mirror-observation"
            :class="{ 'directory-admin__mirror-observation--warning': departmentMirrorObservationHasWarnings }"
          >
            <div class="directory-admin__alert-head">
              <div>
                <strong>组织镜像同步观测</strong>
                <p class="directory-admin__hint">
                  {{ departmentMirrorObservationMessage }}
                </p>
              </div>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="void copyDepartmentMirrorObservationReport()"
              >
                复制同步观测报告
              </button>
            </div>
            <div class="directory-admin__chips">
              <span
                class="directory-admin__chip"
                :class="departmentMirrorObservationHasWarnings ? 'directory-admin__chip--warning' : 'directory-admin__chip--success'"
              >
                最新批次 {{ formatDateTime(departmentMirrorLatestSeenAt) }}
              </span>
              <span class="directory-admin__chip">批次部门 {{ departmentMirrorCurrentBatchCount }}</span>
              <span
                v-if="departmentMirrorStaleSeenCount > 0"
                class="directory-admin__chip directory-admin__chip--warning"
              >
                未在最新批次出现 {{ departmentMirrorStaleSeenCount }}
              </span>
              <span class="directory-admin__chip">最近更新 {{ formatDateTime(departmentMirrorLatestUpdatedAt) }}</span>
              <span class="directory-admin__chip">集成上次成功 {{ formatDateTime(selectedIntegration.lastSuccessAt) }}</span>
            </div>
            <div class="directory-admin__department-actions">
              <button
                v-if="departmentMirrorStaleSeenCount > 0"
                class="directory-admin__link-button"
                type="button"
                @click="focusDepartmentScopeFilter('staleBatch')"
              >
                查看非最新批次
              </button>
              <button
                v-if="inactiveDepartmentCount > 0"
                class="directory-admin__link-button"
                type="button"
                @click="focusDepartmentScopeFilter('inactive')"
              >
                查看停用部门
              </button>
              <button
                v-if="departmentUnlinkedAccountCount > 0"
                class="directory-admin__link-button"
                type="button"
                @click="focusDepartmentScopeFilter('unlinked')"
              >
                查看未绑定部门
              </button>
            </div>
          </div>
          <div
            v-if="departmentsLoaded && departmentRows.length > 0"
            class="directory-admin__department-scope-filters"
          >
            <button
              v-for="option in departmentScopeFilterOptions"
              :key="option.value"
              class="directory-admin__button directory-admin__button--secondary"
              :class="{ 'directory-admin__button--active': departmentScopeFilter === option.value }"
              type="button"
              @click="departmentScopeFilter = option.value"
            >
              {{ option.label }}{{ readDepartmentScopeFilterCount(option.value) }}
            </button>
            <button
              v-if="departmentUnlinkedAccountCount > 0"
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              @click="void copyDepartmentBindingGapReport()"
            >
              复制未绑定部门报告
            </button>
            <button
              v-if="inactiveDepartmentCount > 0"
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              @click="void copyInactiveDepartmentReport()"
            >
              复制停用部门报告
            </button>
          </div>
          <label
            v-if="departmentsLoaded && departmentRows.length > 0"
            class="directory-admin__field directory-admin__field--wide directory-admin__department-search"
          >
            <span>筛选部门</span>
            <input
              v-model.trim="departmentQuery"
              class="directory-admin__input"
              type="search"
              placeholder="输入部门名、部门 ID 或完整路径"
            />
          </label>
          <div
            v-if="departmentViewFilterActive"
            class="directory-admin__department-filter-reset"
          >
            <button
              class="directory-admin__link-button"
              type="button"
              @click="resetDepartmentViewFilters()"
            >
              清空部门筛选
            </button>
          </div>
          <div
            v-if="showVisibleDepartmentBulkActions"
            class="directory-admin__visible-department-actions"
          >
            <p class="directory-admin__hint">
              当前可见 {{ visibleDepartmentRows.length }} 个部门；批量增删仅更新当前草稿，保存前仍可继续检查和清理。
            </p>
            <label class="directory-admin__field directory-admin__field--wide">
              <span>当前可见部门预览</span>
              <textarea
                class="directory-admin__input directory-admin__textarea directory-admin__visible-department-preview"
                :rows="Math.min(visibleDepartmentRows.length, 6)"
                :value="visibleDepartmentNamePreview"
                readonly
              />
            </label>
            <div class="directory-admin__department-actions">
              <button
                class="directory-admin__link-button"
                type="button"
                @click="void copyVisibleDepartmentIds()"
              >
                复制当前可见部门 ID
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="void copyVisibleDepartmentReport()"
              >
                复制当前可见部门报告
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="addVisibleDepartmentsToTarget('admission')"
              >
                批量加入当前可见到准入白名单
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="removeVisibleDepartmentsFromTarget('admission')"
              >
                从准入白名单移除当前可见
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="addVisibleDepartmentsToTarget('exclude')"
              >
                批量加入当前可见到排除部门
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="removeVisibleDepartmentsFromTarget('exclude')"
              >
                从排除部门移除当前可见
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="addVisibleDepartmentsToTarget('memberGroup')"
              >
                批量加入当前可见到成员组同步
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="removeVisibleDepartmentsFromTarget('memberGroup')"
              >
                从成员组同步移除当前可见
              </button>
            </div>
          </div>
          <div class="directory-admin__manual-department">
            <div>
              <strong>选择部门加入配置</strong>
              <p class="directory-admin__hint">
                从已同步的部门中按名称或完整路径搜索并选择一个部门，再加入对应范围；这里仍只写入当前配置草稿。
              </p>
            </div>
            <DirectoryOptionPicker
              test-id="directory-manual-department-picker"
              :selected="pickedDepartmentId ? [pickedDepartmentId] : []"
              :options="departmentPickerOptions"
              :unknown-label="readUnknownDepartmentLabel"
              :multiple="false"
              :loaded="departmentPickerLoaded"
              :loading="loadingDepartments"
              :error="departmentPickerError"
              :empty-text="departmentPickerEmptyText"
              not-loaded-text="正在加载已同步的部门..."
              open-label="选择部门"
              search-placeholder="搜索名称或完整路径"
              empty-selection-text="未选择部门"
              @open="void loadDepartmentsForPicker()"
              @update:selected="writePickedDepartment"
            />
            <div class="directory-admin__department-actions">
              <button
                class="directory-admin__link-button"
                type="button"
                :disabled="pickedDepartmentId.length === 0"
                @click="addPickedDepartmentToTarget('admission')"
              >
                将所选部门加入准入白名单
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                :disabled="pickedDepartmentId.length === 0"
                @click="addPickedDepartmentToTarget('exclude')"
              >
                将所选部门加入排除部门
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                :disabled="pickedDepartmentId.length === 0"
                @click="addPickedDepartmentToTarget('memberGroup')"
              >
                将所选部门加入成员组同步
              </button>
            </div>
          </div>
          <div
            v-if="hasDepartmentDraftScopeChanges"
            class="directory-admin__draft-scope-changes"
          >
            <div class="directory-admin__alert-head">
              <div>
                <strong>部门范围草稿变更</strong>
                <p class="directory-admin__hint">
                  当前草稿与已保存配置不一致；保存前可复制报告给管理员复核。
                </p>
              </div>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="void copyDepartmentDraftScopeChangeReport()"
              >
                复制草稿变更报告
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                @click="restoreDepartmentScopeDraftsToSavedConfig()"
              >
                还原已保存范围
              </button>
            </div>
            <div class="directory-admin__chips">
              <span v-if="departmentDraftScopeAddedCount > 0" class="directory-admin__chip directory-admin__chip--success">
                新增 {{ departmentDraftScopeAddedCount }}
              </span>
              <span v-if="departmentDraftScopeRemovedCount > 0" class="directory-admin__chip directory-admin__chip--warning">
                移除 {{ departmentDraftScopeRemovedCount }}
              </span>
            </div>
            <ul>
              <li v-for="change in departmentDraftScopeChanges" :key="change.field">
                <strong>{{ change.fieldLabel }}</strong>
                <span v-if="change.added.length > 0" class="directory-admin__chip directory-admin__chip--success">
                  新增 {{ change.added.join('、') }}
                </span>
                <span v-if="change.removed.length > 0" class="directory-admin__chip directory-admin__chip--warning">
                  移除 {{ change.removed.join('、') }}
                </span>
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="restoreDepartmentScopeDraftToSavedConfig(change.field)"
                >
                  还原此范围
                </button>
              </li>
            </ul>
          </div>
          <div
            v-if="departmentsLoaded && hasScopedDepartmentConfig"
            class="directory-admin__reference-issues"
            :class="{ 'directory-admin__reference-issues--ok': departmentConfigReferenceIssues.length === 0 }"
          >
            <strong>配置引用检查</strong>
            <div class="directory-admin__reference-actions">
              <button
                class="directory-admin__link-button"
                type="button"
                @click="void copyDepartmentConfigReferenceReport()"
              >
                复制配置引用报告
              </button>
            </div>
            <p v-if="departmentConfigReferenceIssues.length === 0" class="directory-admin__hint">
              当前准入、排除和成员组同步配置中的部门 ID 均能匹配已同步的有效部门。
            </p>
            <div v-else>
              <div class="directory-admin__reference-actions">
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="void copyDepartmentReferenceIssueReport()"
                >
                  复制异常引用报告
                </button>
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="removeAllDepartmentReferenceIssues()"
                >
                  清理全部异常引用
                </button>
              </div>
              <ul>
                <li v-for="issue in departmentConfigReferenceIssues" :key="issue.key">
                  <span
                    class="directory-admin__chip"
                    :class="issue.kind === 'missing' ? 'directory-admin__chip--danger' : 'directory-admin__chip--warning'"
                  >
                    {{ issue.kind === 'missing' ? '未同步' : '已停用' }}
                  </span>
                  {{ readDepartmentReferenceIssueLabel(issue) }}
                  <button
                    class="directory-admin__link-button"
                    type="button"
                    @click="removeDepartmentFromTarget(issue.departmentId, issue.field)"
                  >
                    从{{ issue.fieldLabel }}移除
                  </button>
                </li>
              </ul>
            </div>
          </div>
          <p v-if="departmentLoadError" class="directory-admin__status directory-admin__status--error">
            {{ departmentLoadError }}
          </p>
          <div v-if="loadingDepartments" class="directory-admin__empty">组织架构加载中...</div>
          <div v-else-if="!departmentsLoaded" class="directory-admin__empty">
            点击“加载组织架构”查看当前钉钉部门树、成员数量和本地绑定覆盖情况。
          </div>
          <div v-else-if="departmentRows.length === 0" class="directory-admin__empty">
            暂无已同步部门；请先执行手动同步或检查根部门 ID。
          </div>
          <div v-else-if="visibleDepartmentRows.length === 0" class="directory-admin__empty">
            {{ departmentTreeEmptyMessage }}
          </div>
          <div v-else class="directory-admin__department-tree">
            <article
              v-for="department in visibleDepartmentRows"
              :key="department.id"
              class="directory-admin__department-node"
              :class="{ 'directory-admin__department-node--inactive': !department.isActive }"
              :style="readDepartmentIndentStyle(department)"
            >
              <div>
                <strong>{{ department.name }}</strong>
                <p class="directory-admin__hint">
                  {{ department.fullPath || department.name }} · 部门 ID {{ department.externalDepartmentId }}
                </p>
                <p class="directory-admin__hint">
                  上级：{{ describeDepartmentParent(department) }} · 最近同步：{{ formatDateTime(department.updatedAt) }}
                </p>
              </div>
              <div class="directory-admin__chips">
                <span class="directory-admin__chip">成员 {{ department.accountCount }}</span>
                <span class="directory-admin__chip">已绑定 {{ department.linkedAccountCount }}</span>
                <span
                  v-if="readDepartmentUnlinkedAccountCount(department) > 0"
                  class="directory-admin__chip directory-admin__chip--warning"
                >
                  未绑定 {{ readDepartmentUnlinkedAccountCount(department) }}
                </span>
                <span v-if="department.childCount > 0" class="directory-admin__chip">子部门 {{ department.childCount }}</span>
                <span v-if="!department.isActive" class="directory-admin__chip directory-admin__chip--warning">已停用</span>
                <span
                  v-if="!isDepartmentInLatestMirrorBatch(department)"
                  class="directory-admin__chip directory-admin__chip--warning"
                >
                  非最新批次
                </span>
                <span
                  v-if="departmentConfigScope.admission.has(department.externalDepartmentId)"
                  class="directory-admin__chip directory-admin__chip--success"
                >
                  准入白名单
                </span>
                <span
                  v-if="departmentConfigScope.exclude.has(department.externalDepartmentId)"
                  class="directory-admin__chip directory-admin__chip--warning"
                >
                  排除部门
                </span>
                <span
                  v-if="departmentConfigScope.memberGroup.has(department.externalDepartmentId)"
                  class="directory-admin__chip directory-admin__chip--success"
                >
                  成员组同步
                </span>
              </div>
              <div class="directory-admin__department-actions">
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="void copyDepartmentId(department)"
                >
                  复制部门 ID
                </button>
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="addDepartmentToTarget(department, 'admission')"
                >
                  加入准入白名单
                </button>
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="addDepartmentToTarget(department, 'exclude')"
                >
                  加入排除部门
                </button>
                <button
                  class="directory-admin__link-button"
                  type="button"
                  @click="addDepartmentToTarget(department, 'memberGroup')"
                >
                  加入成员组同步
                </button>
              </div>
            </article>
          </div>
        </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import DirectoryOptionPicker from './DirectoryOptionPicker.vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  addDepartmentToTarget,
  addPickedDepartmentToTarget,
  addVisibleDepartmentsToTarget,
  configuredDepartmentCount,
  copyDepartmentBindingGapReport,
  copyDepartmentConfigReferenceReport,
  copyDepartmentDraftScopeChangeReport,
  copyDepartmentId,
  copyDepartmentMirrorObservationReport,
  copyDepartmentReferenceIssueReport,
  copyInactiveDepartmentReport,
  copyVisibleDepartmentIds,
  copyVisibleDepartmentReport,
  departmentAccountCount,
  departmentConfigReferenceIssues,
  departmentConfigScope,
  departmentDraftScopeAddedCount,
  departmentDraftScopeChanges,
  departmentDraftScopeRemovedCount,
  departmentFilterActive,
  departmentLinkedAccountCount,
  departmentLoadError,
  departmentMirrorCurrentBatchCount,
  departmentMirrorLatestSeenAt,
  departmentMirrorLatestUpdatedAt,
  departmentMirrorObservationHasWarnings,
  departmentMirrorObservationMessage,
  departmentMirrorStaleSeenCount,
  departmentPickerEmptyText,
  departmentPickerError,
  departmentPickerLoaded,
  departmentPickerOptions,
  departmentQuery,
  departmentRows,
  departmentScopeFilter,
  departmentScopeFilterOptions,
  departmentTreeEmptyMessage,
  departmentUnlinkedAccountCount,
  departmentViewFilterActive,
  departmentsLoaded,
  describeDepartmentParent,
  focusDepartmentScopeFilter,
  formatDateTime,
  hasDepartmentDraftScopeChanges,
  hasScopedDepartmentConfig,
  inactiveDepartmentCount,
  isDepartmentInLatestMirrorBatch,
  loadDepartments,
  loadDepartmentsForPicker,
  loadingDepartments,
  pickedDepartmentId,
  readDepartmentIndentStyle,
  readDepartmentReferenceIssueLabel,
  readDepartmentScopeFilterCount,
  readDepartmentUnlinkedAccountCount,
  readUnknownDepartmentLabel,
  removeAllDepartmentReferenceIssues,
  removeDepartmentFromTarget,
  removeVisibleDepartmentsFromTarget,
  resetDepartmentViewFilters,
  restoreDepartmentScopeDraftToSavedConfig,
  restoreDepartmentScopeDraftsToSavedConfig,
  selectedIntegration,
  showVisibleDepartmentBulkActions,
  visibleDepartmentNamePreview,
  visibleDepartmentRows,
  writePickedDepartment,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

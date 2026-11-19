<template>
<section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>待处理队列</h3>
              <p class="directory-admin__hint">展示待绑定、目录停用待停权、缺少钉钉身份标识的成员。</p>
              <p class="directory-admin__hint">
                待绑定中：可推荐 {{ pendingBindingCounts.recommended }} · 需人工 {{ pendingBindingCounts.manual }}
              </p>
              <p v-if="pendingBindingCounts.manual > 0" class="directory-admin__hint">
                人工处理中：无精确匹配 {{ pendingBindingManualReasonCounts.no_exact_match }} ·
                冲突待复核 {{ pendingBindingManualReasonCounts.conflict }}
              </p>
              <p v-if="reviewTotal > 0" class="directory-admin__hint">
                当前已加载 {{ reviewItems.length }} / {{ reviewTotal }} 项，筛选统计基于已加载数据。
              </p>
            </div>
            <div class="directory-admin__actions">
              <button
                v-for="option in reviewFilterOptions"
                :key="option.value"
                class="directory-admin__button directory-admin__button--secondary"
                :class="{ 'directory-admin__button--active': reviewFilter === option.value }"
                type="button"
                :disabled="loadingReviewItems"
                @click="void updateReviewFilter(option.value)"
              >
                {{ option.label }}{{ reviewCounts[option.value] > 0 ? ` (${reviewCounts[option.value]})` : '' }}
              </button>
              <button
                v-for="option in pendingBindingViewOptions"
                :key="option.value"
                class="directory-admin__button directory-admin__button--secondary"
                :class="{ 'directory-admin__button--active': pendingBindingView === option.value }"
                type="button"
                :disabled="loadingReviewItems || reviewCounts.pending_binding === 0"
                @click="updatePendingBindingView(option.value)"
              >
                {{ option.label }}{{ pendingBindingCounts[option.value] > 0 ? ` (${pendingBindingCounts[option.value]})` : '' }}
              </button>
              <button
                v-for="option in pendingBindingManualReasonOptions"
                v-if="showPendingBindingManualReasonFilters"
                :key="option.value"
                class="directory-admin__button directory-admin__button--secondary"
                :class="{ 'directory-admin__button--active': pendingBindingManualReason === option.value }"
                type="button"
                :disabled="loadingReviewItems || pendingBindingCounts.manual === 0"
                @click="updatePendingBindingManualReason(option.value)"
              >
                {{ option.label }}{{ pendingBindingManualReasonCounts[option.value] > 0 ? ` (${pendingBindingManualReasonCounts[option.value]})` : '' }}
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="loadingReviewItems"
                @click="void loadReviewItems(selectedIntegration.id)"
              >
                {{ loadingReviewItems ? '刷新中...' : '刷新队列' }}
              </button>
            </div>
          </div>
          <article v-if="reviewBatchProgress" class="directory-admin__progress-card">
            <div class="directory-admin__alert-head">
              <div>
                <strong>处理进度</strong>
                <p class="directory-admin__hint">{{ reviewBatchProgress.message }}</p>
              </div>
              <div class="directory-admin__chips">
                <span class="directory-admin__chip">{{ readReviewBatchProgressKindLabel(reviewBatchProgress.kind) }}</span>
                <span class="directory-admin__chip" :class="readReviewBatchProgressPhaseClass(reviewBatchProgress.phase)">
                  {{ readReviewBatchProgressPhaseLabel(reviewBatchProgress.phase) }}
                </span>
                <span class="directory-admin__chip">进度 {{ reviewBatchProgress.applied }} / {{ reviewBatchProgress.total }}</span>
              </div>
            </div>
            <div v-if="!reviewBatchProcessing" class="directory-admin__actions">
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                @click="clearReviewBatchProgress()"
              >
                清除进度
              </button>
            </div>
          </article>
          <div class="directory-admin__actions" v-if="filteredReviewItems.length > 0">
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="selectableVisibleReviewIds.length === 0"
              @click="selectVisibleReviewItems()"
            >
              {{ `选择当前筛选 (${selectableVisibleReviewIds.length})` }}
            </button>
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="selectableVisibleRecommendedReviewIds.length === 0"
              @click="selectVisibleRecommendedReviewItems()"
            >
              {{ `选择可推荐 (${selectableVisibleRecommendedReviewIds.length})` }}
            </button>
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="Object.keys(selectedReviewIds).length === 0"
              @click="clearReviewSelection()"
            >
              清空选择
            </button>
            <button
              class="directory-admin__button"
              type="button"
              :disabled="reviewBatchProcessing || selectedRecommendedReviewBindEntries.length === 0"
              @click="void batchConfirmRecommendedReviewItems()"
            >
              {{ reviewBatchProcessing ? '处理中...' : `批量确认推荐 (${selectedRecommendedReviewBindEntries.length})` }}
            </button>
            <button
              class="directory-admin__button"
              type="button"
              :disabled="reviewBatchProcessing || selectedReviewBindEntries.length === 0"
              @click="void batchBindReviewItems()"
            >
              {{ reviewBatchProcessing ? '处理中...' : `批量绑定 (${selectedReviewBindEntries.length})` }}
            </button>
            <button
              class="directory-admin__button"
              type="button"
              :disabled="reviewBatchProcessing || selectedReviewAdmissionIds.length === 0"
              @click="void batchAdmitReviewItems()"
            >
              {{ reviewBatchProcessing ? '处理中...' : `批量创建并绑定 (${selectedReviewAdmissionIds.length})` }}
            </button>
            <label class="directory-admin__toggle directory-admin__toggle--compact">
              <input v-model="reviewDisableDingTalkGrant" type="checkbox" />
              <span>停权时同时关闭钉钉登录</span>
            </label>
            <button
              class="directory-admin__button"
              type="button"
              :disabled="reviewBatchProcessing || selectedReviewBatchIds.length === 0"
              @click="void batchUnbindReviewItems()"
            >
              {{ reviewBatchProcessing ? '处理中...' : `批量停权处理 (${selectedReviewBatchIds.length})` }}
            </button>
          </div>
          <div v-if="loadingReviewItems" class="directory-admin__empty">待处理队列加载中...</div>
          <div v-else-if="filteredReviewItems.length === 0" class="directory-admin__empty">
            {{ hasMoreReviewItems ? '当前筛选在已加载数据中暂无结果，可继续加载更多。' : '暂无待处理项' }}
          </div>
          <article v-for="item in filteredReviewItems" :key="`${item.kind}-${item.account.id}`" class="directory-admin__review-item">
            <div class="directory-admin__review-head">
              <div class="directory-admin__review-title">
                <label v-if="item.actionable.canBatchUnbind || item.kind === 'pending_binding'" class="directory-admin__review-select">
                  <input
                    type="checkbox"
                    :checked="Boolean(selectedReviewIds[item.account.id])"
                    @change="onReviewSelectionChange(item.account.id, $event)"
                  />
                </label>
                <div>
                  <strong>{{ item.account.name }}</strong>
                  <p class="directory-admin__hint">{{ item.reason }}</p>
                </div>
              </div>
              <div class="directory-admin__chips">
                <span class="directory-admin__chip" :class="readReviewKindClass(item.kind)">{{ readReviewKindLabel(item.kind) }}</span>
                <span class="directory-admin__chip" :class="{ 'directory-admin__badge--inactive': !item.account.isActive }">
                  {{ item.account.isActive ? '目录启用' : '目录停用' }}
                </span>
              </div>
            </div>
            <p class="directory-admin__hint">
              本地用户：{{ item.account.localUser ? describeLocalUserIdentifier(item.account.localUser) : '未绑定' }} ·
              外部用户：{{ item.account.externalUserId }} ·
              部门：{{ (item.account.departmentPaths || []).join('，') || '未分配部门' }}
            </p>
            <p v-if="item.kind === 'pending_binding' && item.recommendationStatus" class="directory-admin__hint">
              推荐判断：{{ item.recommendationStatus.message }}
            </p>
            <div class="directory-admin__chips">
              <span v-if="item.flags.missingUnionId" class="directory-admin__chip directory-admin__chip--warning">缺 unionId</span>
              <span v-if="item.flags.missingOpenId" class="directory-admin__chip directory-admin__chip--warning">缺 openId</span>
              <span class="directory-admin__chip">{{ item.account.linkStatus }}</span>
              <span v-if="item.account.matchStrategy" class="directory-admin__chip">策略 {{ item.account.matchStrategy }}</span>
            </div>
            <div v-if="item.kind === 'pending_binding'" class="directory-admin__form-grid directory-admin__form-grid--account">
              <label class="directory-admin__field">
                <span>绑定到本地用户 ID / 邮箱 / 用户名 / 手机号</span>
                <input
                  :value="readBindingDraft(item.account)"
                  class="directory-admin__input"
                  type="text"
                  placeholder="例如 user-123 或 alpha@example.com"
                  @input="onBindingDraftInput(item.account.id, $event)"
                  @focus="clearBindingSearch(item.account.id)"
                />
              </label>
              <label class="directory-admin__toggle directory-admin__toggle--compact">
                <input
                  :checked="readAccountGrantToggle(item.account)"
                  :disabled="!canEnableDingTalkGrant(item.account)"
                  type="checkbox"
                  @change="onGrantToggleChange(item.account, $event)"
                />
                <span>绑定后同时开通钉钉登录</span>
              </label>
              <p v-if="shouldWarnMissingOpenIdForGrant(item.account)" class="directory-admin__status directory-admin__status--error">
                暂时拿不到该成员的 openId（成员完成绑定或激活后用钉钉扫码登录一次才会补齐），当前无法同时开通钉钉登录。
              </p>
              <p v-if="shouldWarnMissingOpenIdForGrant(item.account)" class="directory-admin__hint">
                修复建议：先不勾选开通，完成绑定或激活 → 让成员用钉钉扫码登录一次 → 刷新当前成员后再开通（或到用户管理开通）。
              </p>
              <p v-if="shouldWarnMissingOpenIdForGrant(item.account) && item.account.localUser" class="directory-admin__hint">
                已绑定、升级前用钉钉登录过的成员：升级后请让成员再用钉钉扫码登录一次，点「刷新当前成员」后在本页开通（这类成员不要到用户管理开通）。
              </p>
              <div v-if="shouldWarnMissingOpenIdForGrant(item.account)" class="directory-admin__actions">
                <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="reviewProcessingAccountId === item.account.id" @click="void refreshSingleReviewItem(item.account.id)">
                  刷新当前成员
                </button>
                <router-link
                  v-if="item.account.localUser"
                  class="directory-admin__button directory-admin__button--secondary"
                  :to="buildUserManagementLocation(item.account.localUser.id, item.account)"
                >
                  前往用户管理
                </router-link>
              </div>
            </div>
            <div v-if="item.kind === 'pending_binding' && item.recommendations.length > 0" class="directory-admin__search-results">
              <button
                v-for="recommendation in item.recommendations"
                :key="`${item.account.id}-${recommendation.localUser.id}`"
                class="directory-admin__search-result"
                type="button"
                @click="applyRecommendedLocalUser(item.account.id, recommendation)"
              >
                <strong>{{ describeLocalUserLabel(recommendation.localUser) }}</strong>
                <span>{{ describeLocalUserIdentifier(recommendation.localUser) }}</span>
                <small>{{ readRecommendationReasonLabel(recommendation.reasons) }}</small>
              </button>
            </div>
            <div v-if="item.kind === 'pending_binding' && readBindingSearchResults(item.account.id).length > 0" class="directory-admin__search-results">
              <button
                v-for="user in readBindingSearchResults(item.account.id)"
                :key="user.id"
                class="directory-admin__search-result"
                type="button"
                @click="chooseLocalUser(item.account.id, user)"
              >
                <strong>{{ describeLocalUserLabel(user) }}</strong>
                <span>{{ describeLocalUserIdentifier(user) }}</span>
                <small>{{ user.id }} · {{ user.role }} · {{ user.is_active ? 'active' : 'inactive' }}</small>
              </button>
            </div>
            <p v-if="item.kind === 'pending_binding' && readBindingSearchError(item.account.id)" class="directory-admin__status directory-admin__status--error">
              {{ readBindingSearchError(item.account.id) }}
            </p>
            <p
              v-if="item.kind === 'pending_binding' && readMobileConflictHint(item.account.id)"
              class="directory-admin__status directory-admin__status--error"
            >
              {{ readMobileConflictHint(item.account.id) }}
            </p>
            <p
              v-if="shouldOfferMobileBackfill(item)"
              class="directory-admin__hint"
              :class="{ 'directory-admin__status directory-admin__status--error': hasSelectedBindingUserMobileConflict(item) }"
            >
              平台手机号：{{ readSelectedBindingUser(item)?.mobile || '未设置' }} ·
              目录手机号：{{ item.account.mobile }} ·
              {{ hasSelectedBindingUserMobileConflict(item) ? '存在差异，覆盖前需确认。' : '可直接回填到平台用户。' }}
            </p>
            <div
              v-if="item.kind === 'pending_binding' && isManualAdmissionExpanded(item.account.id)"
              class="directory-admin__review-admission"
            >
              <p class="directory-admin__hint">适用于目录成员尚未入驻平台时，直接创建本地用户并完成绑定。</p>
              <div class="directory-admin__form-grid">
                <label class="directory-admin__field">
                  <span>姓名</span>
                  <input
                    :value="readManualAdmissionDraft(item.account).name"
                    class="directory-admin__input"
                    type="text"
                    placeholder="例如 李青"
                    @input="onManualAdmissionDraftInput(item.account.id, 'name', $event)"
                  />
                </label>
                <label class="directory-admin__field">
                  <span>邮箱（可选）</span>
                  <input
                    :value="readManualAdmissionDraft(item.account).email"
                    class="directory-admin__input"
                    type="email"
                    placeholder="例如 alpha@example.com"
                    @input="onManualAdmissionDraftInput(item.account.id, 'email', $event)"
                  />
                </label>
                <label class="directory-admin__field">
                  <span>登录名（可选）</span>
                  <input
                    :value="readManualAdmissionDraft(item.account).username"
                    class="directory-admin__input"
                    type="text"
                    placeholder="例如 liqing"
                    @input="onManualAdmissionDraftInput(item.account.id, 'username', $event)"
                  />
                </label>
                <label class="directory-admin__field">
                  <span>手机号</span>
                  <input
                    :value="readManualAdmissionDraft(item.account).mobile"
                    class="directory-admin__input"
                    type="text"
                    placeholder="可选：目录手机号会自动带入"
                    @input="onManualAdmissionDraftInput(item.account.id, 'mobile', $event)"
                  />
                </label>
              </div>
              <p class="directory-admin__hint" data-directory-admission-rule="login-name">{{ DIRECTORY_ADMISSION_LOGIN_NAME_HINT }}</p>
              <p class="directory-admin__hint">姓名必填；邮箱、登录名、手机号至少填写一项。无邮箱用户会走临时密码 + 首登强制改密。</p>
            </div>
            <div class="directory-admin__actions">
              <button
                v-if="item.kind === 'pending_binding'"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="readBindingDraft(item.account).trim().length === 0 || readBindingSearchLoading(item.account.id)"
                @click="void searchLocalUsers(item.account.id)"
              >
                {{ readBindingSearchLoading(item.account.id) ? '搜索中...' : '搜索本地用户' }}
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                @click="focusReviewAccount(item)"
              >
                定位到成员
              </button>
              <button
                v-if="item.kind === 'pending_binding'"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id"
                @click="toggleManualAdmission(item.account)"
              >
                {{ isManualAdmissionExpanded(item.account.id) ? '收起手动创建' : '手动创建用户' }}
              </button>
              <router-link
                v-if="item.kind === 'pending_binding' && readSelectedBindingUser(item)"
                class="directory-admin__button directory-admin__button--secondary"
                :to="buildUserManagementLocation(readSelectedBindingUser(item)!.id, item.account)"
              >
                查看本地用户
              </router-link>
              <button
                v-if="item.kind === 'pending_binding' && isManualAdmissionExpanded(item.account.id)"
                class="directory-admin__button"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id || !canSubmitManualAdmission(item.account)"
                @click="void createAndBindReviewUser(item)"
              >
                {{ reviewProcessingAccountId === item.account.id ? '处理中...' : '创建用户并绑定' }}
              </button>
              <button
                v-if="item.kind === 'pending_binding'"
                class="directory-admin__button"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id || !item.actionable.canConfirmRecommendation"
                @click="void confirmRecommendedReviewBinding(item)"
              >
                {{ reviewProcessingAccountId === item.account.id ? '处理中...' : '确认推荐' }}
              </button>
              <button
                v-if="shouldOfferMobileBackfill(item)"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id"
                @click="void backfillUserMobileAndBindReviewItem(item)"
              >
                {{ reviewProcessingAccountId === item.account.id ? '处理中...' : readBackfillAndBindLabel(item) }}
              </button>
              <button
                v-if="item.kind === 'pending_binding' && isAwaitingMobileOverrideConfirmation(item.account.id)"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id"
                @click="clearMobileOverrideConfirmation(item.account.id)"
              >
                取消覆盖确认
              </button>
              <button
                v-if="item.kind === 'pending_binding' && readMobileConflictHint(item.account.id)"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id"
                @click="clearMobileConflictHint(item.account.id)"
              >
                关闭冲突提示
              </button>
              <button
                v-if="item.kind === 'pending_binding' && readMobileConflictHint(item.account.id)"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id"
                @click="void retryBackfillUserMobileAndBindReviewItem(item)"
              >
                按最新手机号重试
              </button>
              <button
                v-if="item.kind === 'pending_binding'"
                class="directory-admin__button"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id || readBindingDraft(item.account).trim().length === 0"
                @click="void handleReviewBind(item)"
              >
                {{ reviewProcessingAccountId === item.account.id ? '处理中...' : '快速绑定' }}
              </button>
              <button
                v-if="item.actionable.canBatchUnbind"
                class="directory-admin__button"
                type="button"
                :disabled="reviewProcessingAccountId === item.account.id"
                @click="void handleReviewUnbind(item)"
              >
                {{ reviewProcessingAccountId === item.account.id ? '处理中...' : '停权处理' }}
              </button>
            </div>
          </article>
          <div v-if="!loadingReviewItems && hasMoreReviewItems" class="directory-admin__actions">
            <button
              class="directory-admin__button directory-admin__button--secondary"
              type="button"
              :disabled="loadingMoreReviewItems"
              @click="void loadMoreReviewItems()"
            >
              {{ loadingMoreReviewItems ? '加载中...' : `加载更多 (${Math.min(reviewPageSize, reviewTotal - reviewItems.length)})` }}
            </button>
          </div>
        </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  DIRECTORY_ADMISSION_LOGIN_NAME_HINT,
  applyRecommendedLocalUser,
  backfillUserMobileAndBindReviewItem,
  batchAdmitReviewItems,
  batchBindReviewItems,
  batchConfirmRecommendedReviewItems,
  batchUnbindReviewItems,
  buildUserManagementLocation,
  canEnableDingTalkGrant,
  canSubmitManualAdmission,
  chooseLocalUser,
  clearBindingSearch,
  clearMobileConflictHint,
  clearMobileOverrideConfirmation,
  clearReviewBatchProgress,
  clearReviewSelection,
  confirmRecommendedReviewBinding,
  createAndBindReviewUser,
  describeLocalUserIdentifier,
  describeLocalUserLabel,
  filteredReviewItems,
  focusReviewAccount,
  handleReviewBind,
  handleReviewUnbind,
  hasMoreReviewItems,
  hasSelectedBindingUserMobileConflict,
  isAwaitingMobileOverrideConfirmation,
  isManualAdmissionExpanded,
  loadMoreReviewItems,
  loadReviewItems,
  loadingMoreReviewItems,
  loadingReviewItems,
  onBindingDraftInput,
  onGrantToggleChange,
  onManualAdmissionDraftInput,
  onReviewSelectionChange,
  pendingBindingCounts,
  pendingBindingManualReason,
  pendingBindingManualReasonCounts,
  pendingBindingManualReasonOptions,
  pendingBindingView,
  pendingBindingViewOptions,
  readAccountGrantToggle,
  readBackfillAndBindLabel,
  readBindingDraft,
  readBindingSearchError,
  readBindingSearchLoading,
  readBindingSearchResults,
  readManualAdmissionDraft,
  readMobileConflictHint,
  readRecommendationReasonLabel,
  readReviewBatchProgressKindLabel,
  readReviewBatchProgressPhaseClass,
  readReviewBatchProgressPhaseLabel,
  readReviewKindClass,
  readReviewKindLabel,
  readSelectedBindingUser,
  refreshSingleReviewItem,
  retryBackfillUserMobileAndBindReviewItem,
  reviewBatchProcessing,
  reviewBatchProgress,
  reviewCounts,
  reviewDisableDingTalkGrant,
  reviewFilter,
  reviewFilterOptions,
  reviewItems,
  reviewPageSize,
  reviewProcessingAccountId,
  reviewTotal,
  searchLocalUsers,
  selectVisibleRecommendedReviewItems,
  selectVisibleReviewItems,
  selectableVisibleRecommendedReviewIds,
  selectableVisibleReviewIds,
  selectedIntegration,
  selectedRecommendedReviewBindEntries,
  selectedReviewAdmissionIds,
  selectedReviewBatchIds,
  selectedReviewBindEntries,
  selectedReviewIds,
  shouldOfferMobileBackfill,
  shouldWarnMissingOpenIdForGrant,
  showPendingBindingManualReasonFilters,
  toggleManualAdmission,
  updatePendingBindingManualReason,
  updatePendingBindingView,
  updateReviewFilter,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

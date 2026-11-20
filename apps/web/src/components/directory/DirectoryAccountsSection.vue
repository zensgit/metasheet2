<template>
<section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>成员账号</h3>
              <p class="directory-admin__hint">展示同步后的钉钉成员、钉钉 ID 与本地绑定状态；支持按本地用户 ID 或邮箱手工绑定，并按页管理大规模组织。</p>
            </div>
            <div class="directory-admin__actions">
              <input
                v-model.trim="accountQuery"
                class="directory-admin__input directory-admin__input--search"
                type="text"
                placeholder="搜索姓名 / 邮箱 / 手机 / 钉钉 ID / 本地用户"
                @keyup.enter="void searchAccounts()"
              />
              <label class="directory-admin__field directory-admin__field--inline">
                <span>本页状态</span>
                <select v-model="accountStatusFilter" class="directory-admin__input directory-admin__input--compact" aria-label="本页成员状态">
                  <option value="all">全部</option>
                  <option value="linked">已关联</option>
                  <option value="pending">待确认</option>
                  <option value="unmatched">未匹配</option>
                  <option value="manual_unbound">管理员已解绑</option>
                </select>
              </label>
              <label class="directory-admin__field directory-admin__field--inline">
                <span>每页</span>
                <select class="directory-admin__input directory-admin__input--compact" :value="String(accountPageSize)" @change="void updateAccountPageSize($event)">
                  <option v-for="size in accountPageSizeOptions" :key="size" :value="String(size)">{{ size }}</option>
                </select>
              </label>
              <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingAccounts" @click="void searchAccounts()">
                {{ loadingAccounts ? '刷新中...' : accountQuery.trim().length > 0 ? '应用筛选' : '刷新成员' }}
              </button>
            </div>
          </div>
          <p class="directory-admin__hint" data-testid="directory-account-filter-scope">
            姓名搜索使用全量成员接口；状态只筛选当前页，显示 {{ visibleAccounts.length }} / {{ accounts.length }} 条，不改变分页总数或待处理批量选择。
          </p>
          <article v-if="routeNavigationFailureNotice" class="directory-admin__route-banner">
            <div class="directory-admin__alert-head">
              <div>
                <strong>定位未完成</strong>
                <p class="directory-admin__hint">{{ routeNavigationFailureNotice.message }}</p>
                <p v-if="routeNavigationFailureNotice.targetIntegrationId" class="directory-admin__hint">
                  目标集成：{{ routeNavigationFailureNotice.targetIntegrationId }}
                </p>
                <p v-if="routeNavigationFailureNotice.targetAccountId" class="directory-admin__hint">
                  目标成员：{{ routeNavigationFailureNotice.targetAccountId }}
                </p>
                <p v-if="routeNavigationFailureNotice.currentIntegrationName" class="directory-admin__hint">
                  当前仍停留在 {{ routeNavigationFailureNotice.currentIntegrationName }}
                </p>
              </div>
              <div class="directory-admin__chips">
                <span class="directory-admin__chip directory-admin__chip--danger">导航失败</span>
                <span class="directory-admin__chip">
                  {{ routeNavigationFailureNotice.kind === 'missing_integration' ? '集成不存在' : '成员不存在' }}
                </span>
              </div>
            </div>
            <div class="directory-admin__actions">
              <button
                class="directory-admin__button"
                type="button"
                :disabled="routeNavigationFailureAction.length > 0"
                @click="void retryRouteNavigationFailureNotice()"
              >
                {{ routeNavigationFailureAction === 'retry' ? '重试中...' : '重试定位' }}
              </button>
              <router-link
                v-if="routeNavigationFailureUserManagementLocation"
                class="directory-admin__button directory-admin__button--secondary"
                :to="routeNavigationFailureUserManagementLocation"
              >
                返回用户管理
              </router-link>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="routeNavigationFailureAction.length > 0"
                @click="clearFailedDirectoryNavigation()"
              >
                {{
                  routeNavigationFailureNotice.currentIntegrationName
                    ? `留在 ${routeNavigationFailureNotice.currentIntegrationName}`
                    : '清除失败定位'
                }}
              </button>
            </div>
          </article>

          <article v-if="focusedAccountId" class="directory-admin__focus-card">
            <div>
              <strong>{{ focusedVisibleAccount ? `当前定位成员：${focusedVisibleAccount.name}` : `当前定位成员：${focusedAccountId}` }}</strong>
              <p class="directory-admin__hint">
                {{
                  focusedVisibleAccount
                    ? '已在当前成员结果中高亮显示，可直接继续绑定、解绑或复核。'
                    : '当前定位成员不在本页结果中；如果你已切换筛选或分页，可清除定位后继续操作。'
                }}
              </p>
            </div>
            <div class="directory-admin__focus-actions">
              <router-link
                v-if="focusedVisibleAccount?.localUser?.id"
                class="directory-admin__button directory-admin__button--secondary"
                :to="buildUserManagementLocation(focusedVisibleAccount.localUser.id, focusedVisibleAccount)"
              >
                前往用户管理
              </router-link>
              <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearFocusedAccount()">
                清除定位
              </button>
            </div>
          </article>

          <div v-if="loadingAccounts" class="directory-admin__empty">成员加载中...</div>
          <div v-else-if="visibleAccounts.length === 0" class="directory-admin__empty">{{ accounts.length === 0 ? '暂无同步成员' : '当前页没有符合状态的成员，可切换状态或翻页查看' }}</div>
          <article
            v-for="account in visibleAccounts"
            :key="account.id"
            class="directory-admin__account"
            :class="{ 'directory-admin__account--focused': focusedAccountId === account.id }"
          >
            <div class="directory-admin__account-head">
              <div>
                <strong>{{ account.name }}</strong>
                <p class="directory-admin__hint">
                  {{ account.localUser ? `本地用户：${describeLocalUserIdentifier(account.localUser)}` : '未绑定本地用户' }}
                </p>
              </div>
              <div class="directory-admin__chips">
                <span v-if="focusedAccountId === account.id" class="directory-admin__chip directory-admin__chip--success">已定位</span>
                <span class="directory-admin__chip">{{ account.linkStatus }}</span>
                <span v-if="account.matchStrategy" class="directory-admin__chip">策略 {{ account.matchStrategy }}</span>
                <span class="directory-admin__chip" :class="{ 'directory-admin__badge--inactive': !account.isActive }">
                  {{ account.isActive ? '目录启用' : '目录停用' }}
                </span>
              </div>
            </div>

            <div class="directory-admin__account-grid">
              <p class="directory-admin__hint"><strong>用户 ID：</strong>{{ account.externalUserId }}</p>
              <p class="directory-admin__hint"><strong>Union ID：</strong>{{ account.unionId || '未返回' }}</p>
              <p class="directory-admin__hint"><strong>Open ID：</strong>{{ account.openId || '未返回' }}</p>
              <p class="directory-admin__hint"><strong>邮箱：</strong>{{ account.email || '无' }}</p>
              <p class="directory-admin__hint"><strong>手机：</strong>{{ account.mobile || '无' }}</p>
              <p class="directory-admin__hint"><strong>Corp：</strong>{{ account.corpId || '未记录' }}</p>
              <p class="directory-admin__hint"><strong>最近目录同步：</strong>{{ formatDateTime(account.updatedAt) }}</p>
            </div>

            <p class="directory-admin__hint">
              部门：{{ (account.departmentPaths || []).join('，') || '未分配部门' }}
            </p>
            <div class="directory-admin__form-grid directory-admin__form-grid--account">
              <label class="directory-admin__field">
                <span>绑定到本地用户 ID / 邮箱 / 用户名 / 手机号</span>
                <input
                  :value="readBindingDraft(account)"
                  class="directory-admin__input"
                  type="text"
                  placeholder="例如 user-123 或 alpha@example.com"
                  @input="onBindingDraftInput(account.id, $event)"
                  @focus="clearBindingSearch(account.id)"
                />
              </label>
              <label class="directory-admin__toggle directory-admin__toggle--compact">
                <input
                  :checked="readAccountGrantToggle(account)"
                  :disabled="!canEnableDingTalkGrant(account)"
                  type="checkbox"
                  @change="onGrantToggleChange(account, $event)"
                />
                <span>绑定后同时开通钉钉登录</span>
              </label>
              <button
                v-if="focusedAccountId === account.id && focusedVisibleAccountBindDraft.length > 0"
                class="directory-admin__button"
                type="button"
                data-testid="directory-focused-bind"
                :disabled="bindingAccountId === account.id"
                @click="void bindAccount(account)"
              >
                {{ focusedVisibleAccountBindLabel }}
              </button>
              <p v-if="shouldWarnMissingOpenIdForGrant(account)" class="directory-admin__status directory-admin__status--error">
                暂时拿不到该成员的 openId（成员完成绑定或激活后用钉钉扫码登录一次才会补齐），当前无法同时开通钉钉登录。
              </p>
              <p v-if="shouldWarnMissingOpenIdForGrant(account)" class="directory-admin__hint">
                修复建议：先不勾选开通，完成绑定或激活 → 让成员用钉钉扫码登录一次 → 刷新当前成员后再开通（或到用户管理开通）。
              </p>
              <p v-if="shouldWarnMissingOpenIdForGrant(account) && account.localUser" class="directory-admin__hint">
                已绑定、升级前用钉钉登录过的成员：升级后请让成员再用钉钉扫码登录一次，点「刷新当前成员」后在本页开通（这类成员不要到用户管理开通）。
              </p>
              <div v-if="shouldWarnMissingOpenIdForGrant(account)" class="directory-admin__actions">
                <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="bindingAccountId === account.id" @click="void refreshSingleAccount(account.id)">
                  刷新当前成员
                </button>
                <router-link
                  v-if="account.localUser"
                  class="directory-admin__button directory-admin__button--secondary"
                  :to="buildUserManagementLocation(account.localUser.id, account)"
                >
                  前往用户管理
                </router-link>
              </div>
            </div>

            <details class="directory-admin__account-more">
              <summary>更多操作</summary>
            <div v-if="account.localUser?.id" class="directory-admin__actions">
              <router-link
                class="directory-admin__button directory-admin__button--secondary"
                :to="buildUserManagementLocation(account.localUser.id, account)"
              >
                前往用户管理
              </router-link>
            </div>
            <div class="directory-admin__actions">
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="readBindingDraft(account).trim().length === 0 || readBindingSearchLoading(account.id)"
                @click="void searchLocalUsers(account.id)"
              >
                {{ readBindingSearchLoading(account.id) ? '搜索中...' : '搜索本地用户' }}
              </button>
              <button
                v-if="!account.localUser"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="bindingAccountId === account.id"
                @click="toggleManualAdmission(account)"
              >
                {{ isManualAdmissionExpanded(account.id) ? '收起手动创建' : '手动创建用户' }}
              </button>
              <button
                class="directory-admin__button"
                type="button"
                :disabled="bindingAccountId === account.id || readBindingDraft(account).trim().length === 0"
                @click="void bindAccount(account)"
              >
                {{ bindingAccountId === account.id ? '绑定中...' : account.localUser ? '更新绑定' : '绑定用户' }}
              </button>
              <button
                v-if="account.localUser"
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="unbindingAccountId === account.id"
                @click="void unbindAccount(account)"
              >
                {{ unbindingAccountId === account.id ? '解绑中...' : '解除绑定' }}
              </button>
            </div>

            <div
              v-if="!account.localUser && isManualAdmissionExpanded(account.id)"
              class="directory-admin__review-admission"
            >
              <p class="directory-admin__hint">从当前钉钉同步成员创建本地用户并立即绑定。邮箱可为空，登录名或手机号可作为登录账号。</p>
              <div class="directory-admin__form-grid">
                <label class="directory-admin__field">
                  <span>姓名</span>
                  <input
                    :value="readManualAdmissionDraft(account).name"
                    class="directory-admin__input"
                    type="text"
                    placeholder="例如 李青"
                    @input="onManualAdmissionDraftInput(account.id, 'name', $event)"
                  />
                </label>
                <label class="directory-admin__field">
                  <span>邮箱（可选）</span>
                  <input
                    :value="readManualAdmissionDraft(account).email"
                    class="directory-admin__input"
                    type="email"
                    placeholder="例如 alpha@example.com"
                    @input="onManualAdmissionDraftInput(account.id, 'email', $event)"
                  />
                </label>
                <label class="directory-admin__field">
                  <span>登录名（可选）</span>
                  <input
                    :value="readManualAdmissionDraft(account).username"
                    class="directory-admin__input"
                    type="text"
                    placeholder="例如 liqing"
                    @input="onManualAdmissionDraftInput(account.id, 'username', $event)"
                  />
                </label>
                <label class="directory-admin__field">
                  <span>手机号</span>
                  <input
                    :value="readManualAdmissionDraft(account).mobile"
                    class="directory-admin__input"
                    type="text"
                    placeholder="可选：目录手机号会自动带入"
                    @input="onManualAdmissionDraftInput(account.id, 'mobile', $event)"
                  />
                </label>
              </div>
              <p class="directory-admin__hint" data-directory-admission-rule="login-name">{{ DIRECTORY_ADMISSION_LOGIN_NAME_HINT }}</p>
              <p class="directory-admin__hint">姓名必填；邮箱、登录名、手机号至少填写一项。无邮箱用户会走临时密码 + 首登强制改密。</p>
              <div class="directory-admin__actions">
                <button
                  class="directory-admin__button"
                  type="button"
                  :disabled="bindingAccountId === account.id || !canSubmitManualAdmission(account)"
                  @click="void createAndBindAccountUser(account)"
                >
                  {{ bindingAccountId === account.id ? '处理中...' : '创建用户并绑定' }}
                </button>
              </div>
            </div>

            <p v-if="readBindingSearchError(account.id)" class="directory-admin__status directory-admin__status--error">
              {{ readBindingSearchError(account.id) }}
            </p>
            <div v-if="readBindingSearchResults(account.id).length > 0" class="directory-admin__search-results">
              <button
                v-for="user in readBindingSearchResults(account.id)"
                :key="user.id"
                class="directory-admin__search-result"
                type="button"
                @click="chooseLocalUser(account.id, user)"
              >
                <strong>{{ describeLocalUserLabel(user) }}</strong>
                <span>{{ describeLocalUserIdentifier(user) }}</span>
                <small>{{ user.id }} · {{ user.role }} · {{ user.is_active ? 'active' : 'inactive' }}</small>
              </button>
            </div>
            </details>
          </article>

          <footer v-if="accountTotal > 0" class="directory-admin__pagination">
            <p class="directory-admin__hint">
              第 {{ accountPage }} / {{ accountPageCount }} 页 · 显示 {{ accountRangeStart }}-{{ accountRangeEnd }} / {{ accountTotal }}
            </p>
            <div class="directory-admin__actions">
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="loadingAccounts || accountPage <= 1"
                @click="void changeAccountPage(accountPage - 1)"
              >
                上一页
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="loadingAccounts || accountPage >= accountPageCount"
                @click="void changeAccountPage(accountPage + 1)"
              >
                下一页
              </button>
            </div>
          </footer>
        </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  DIRECTORY_ADMISSION_LOGIN_NAME_HINT,
  accountPage,
  accountPageCount,
  accountPageSize,
  accountPageSizeOptions,
  accountQuery,
  accountStatusFilter,
  accountRangeEnd,
  accountRangeStart,
  accountTotal,
  accounts,
  bindAccount,
  bindingAccountId,
  buildUserManagementLocation,
  canEnableDingTalkGrant,
  canSubmitManualAdmission,
  changeAccountPage,
  chooseLocalUser,
  clearBindingSearch,
  clearFailedDirectoryNavigation,
  clearFocusedAccount,
  createAndBindAccountUser,
  describeLocalUserIdentifier,
  describeLocalUserLabel,
  focusedAccountId,
  focusedVisibleAccount,
  focusedVisibleAccountBindDraft,
  focusedVisibleAccountBindLabel,
  formatDateTime,
  isManualAdmissionExpanded,
  loadingAccounts,
  onBindingDraftInput,
  onGrantToggleChange,
  onManualAdmissionDraftInput,
  readAccountGrantToggle,
  readBindingDraft,
  readBindingSearchError,
  readBindingSearchLoading,
  readBindingSearchResults,
  readManualAdmissionDraft,
  refreshSingleAccount,
  retryRouteNavigationFailureNotice,
  routeNavigationFailureAction,
  routeNavigationFailureNotice,
  routeNavigationFailureUserManagementLocation,
  searchAccounts,
  searchLocalUsers,
  selectedIntegration,
  shouldWarnMissingOpenIdForGrant,
  toggleManualAdmission,
  unbindAccount,
  unbindingAccountId,
  updateAccountPageSize,
  visibleAccounts,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

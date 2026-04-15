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
        <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loading" @click="void loadIntegrations()">
          {{ loading ? '刷新中...' : '刷新列表' }}
        </button>
        <button class="directory-admin__button" type="button" @click="resetDraft()">新建集成</button>
      </div>
    </header>

    <p v-if="status" class="directory-admin__status" :class="{ 'directory-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <div class="directory-admin__layout">
      <aside class="directory-admin__panel directory-admin__panel--list">
        <div class="directory-admin__section-head">
          <div>
            <h2>集成列表</h2>
            <p class="directory-admin__hint">当前仅支持钉钉目录拉取与手动同步。</p>
          </div>
        </div>

        <div v-if="integrations.length === 0" class="directory-admin__empty">暂无目录集成</div>
        <button
          v-for="integration in integrations"
          :key="integration.id"
          class="directory-admin__item"
          :class="{ 'directory-admin__item--active': selectedIntegrationId === integration.id }"
          type="button"
          @click="selectIntegration(integration.id)"
        >
          <strong>{{ integration.name }}</strong>
          <span>{{ integration.corpId }}</span>
          <small>
            账号 {{ integration.stats.accountCount }} / 部门 {{ integration.stats.departmentCount }} / 待确认 {{ integration.stats.pendingLinkCount }}
          </small>
          <small>
            最近同步：{{ formatDateTime(integration.lastSyncAt) }} · {{ integration.stats.lastRunStatus || '未运行' }}
          </small>
        </button>
      </aside>

      <section class="directory-admin__panel directory-admin__panel--detail">
        <div class="directory-admin__section-head">
          <div>
            <h2>{{ selectedIntegration ? '编辑集成' : '创建集成' }}</h2>
            <p class="directory-admin__hint">`appSecret` 在更新时可留空，系统会继续使用已保存的值。</p>
          </div>
          <div class="directory-admin__summary" v-if="selectedIntegration">
            <span class="directory-admin__badge">{{ selectedIntegration.status }}</span>
            <span class="directory-admin__badge" :class="{ 'directory-admin__badge--inactive': !selectedIntegration.syncEnabled }">
              {{ selectedIntegration.syncEnabled ? '已启用同步' : '仅手动同步' }}
            </span>
            <span class="directory-admin__badge">已链接 {{ selectedIntegration.stats.linkedCount }}</span>
          </div>
        </div>

        <div class="directory-admin__form-grid">
          <label class="directory-admin__field">
            <span>集成名称</span>
            <input v-model.trim="draft.name" class="directory-admin__input" type="text" placeholder="例如 DingTalk CN" />
          </label>
          <label class="directory-admin__field">
            <span>Corp ID</span>
            <input v-model.trim="draft.corpId" class="directory-admin__input" type="text" placeholder="dingxxxx" />
          </label>
          <label class="directory-admin__field">
            <span>App Key</span>
            <input v-model.trim="draft.appKey" class="directory-admin__input" type="text" placeholder="填写企业应用 appKey" />
          </label>
          <label class="directory-admin__field">
            <span>App Secret</span>
            <input v-model.trim="draft.appSecret" class="directory-admin__input" type="password" placeholder="创建必填，更新可留空" />
          </label>
          <label class="directory-admin__field">
            <span>根部门 ID</span>
            <input v-model.trim="draft.rootDepartmentId" class="directory-admin__input" type="text" placeholder="默认 1" />
          </label>
          <label class="directory-admin__field">
            <span>Base URL</span>
            <input v-model.trim="draft.baseUrl" class="directory-admin__input" type="text" placeholder="默认 https://oapi.dingtalk.com" />
          </label>
          <label class="directory-admin__field">
            <span>Page Size</span>
            <input v-model.number="draft.pageSize" class="directory-admin__input" type="number" min="1" max="100" />
          </label>
          <label class="directory-admin__field">
            <span>状态</span>
            <select v-model="draft.status" class="directory-admin__input">
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <label class="directory-admin__field">
            <span>Schedule Cron</span>
            <input v-model.trim="draft.scheduleCron" class="directory-admin__input" type="text" placeholder="一期可留空" />
          </label>
          <label class="directory-admin__field">
            <span>停权策略</span>
            <select v-model="draft.defaultDeprovisionPolicy" class="directory-admin__input">
              <option value="mark_inactive">mark_inactive</option>
              <option value="manual_review">manual_review</option>
            </select>
          </label>
          <label class="directory-admin__toggle">
            <input v-model="draft.syncEnabled" type="checkbox" />
            <span>保存后允许自动同步</span>
          </label>
        </div>

        <footer class="directory-admin__footer">
          <button class="directory-admin__button" type="button" :disabled="busy || !canSave" @click="void saveIntegration()">
            {{ busy ? '处理中...' : selectedIntegration ? '保存变更' : '创建集成' }}
          </button>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void testIntegration()">
            测试连通性
          </button>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !selectedIntegration" @click="void syncIntegration()">
            手动同步
          </button>
        </footer>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <h3>当前概览</h3>
          <div class="directory-admin__chips">
            <span class="directory-admin__chip">部门 {{ selectedIntegration.stats.departmentCount }}</span>
            <span class="directory-admin__chip">账号 {{ selectedIntegration.stats.accountCount }}</span>
            <span class="directory-admin__chip">待确认 {{ selectedIntegration.stats.pendingLinkCount }}</span>
            <span class="directory-admin__chip">已链接 {{ selectedIntegration.stats.linkedCount }}</span>
            <span class="directory-admin__chip">上次成功 {{ formatDateTime(selectedIntegration.lastSuccessAt) }}</span>
          </div>
          <p v-if="selectedIntegration.lastError" class="directory-admin__status directory-admin__status--error">
            最近错误：{{ selectedIntegration.lastError }}
          </p>
        </section>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>自动同步观测</h3>
              <p class="directory-admin__hint">区分“已配置自动同步”和“系统里已观察到自动触发”。下一次时间为按当前 cron 配置推算，不代表已完成调度注册。</p>
            </div>
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingSchedule" @click="void loadScheduleSnapshot(selectedIntegration.id)">
              {{ loadingSchedule ? '刷新中...' : '刷新观测' }}
            </button>
          </div>

          <div v-if="loadingSchedule" class="directory-admin__empty">自动同步观测加载中...</div>
          <div v-else-if="!scheduleSnapshot" class="directory-admin__empty">暂无自动同步观测</div>
          <template v-else>
            <div class="directory-admin__chips">
              <span class="directory-admin__chip" :class="readObservationStatusClass(scheduleSnapshot.observationStatus)">
                {{ readObservationStatusLabel(scheduleSnapshot.observationStatus) }}
              </span>
              <span class="directory-admin__chip" :class="{ 'directory-admin__badge--inactive': !scheduleSnapshot.syncEnabled }">
                {{ scheduleSnapshot.syncEnabled ? '已启用自动同步' : '仅手动同步' }}
              </span>
              <span class="directory-admin__chip">
                Cron {{ scheduleSnapshot.scheduleCron || '未配置' }}
              </span>
              <span class="directory-admin__chip">
                时区 {{ scheduleSnapshot.timezone }}
              </span>
            </div>

            <div class="directory-admin__account-grid">
              <p class="directory-admin__hint"><strong>按 cron 推算下一次：</strong>{{ formatDateTime(scheduleSnapshot.nextExpectedRunAt) }}</p>
              <p class="directory-admin__hint"><strong>Cron 校验：</strong>{{ scheduleSnapshot.cronValid ? '通过' : '未通过 / 未配置' }}</p>
              <p class="directory-admin__hint"><strong>最近一次执行：</strong>{{ formatDateTime(scheduleSnapshot.latestRunAt) }}</p>
              <p class="directory-admin__hint"><strong>最近一次来源：</strong>{{ readTriggerSourceLabel(scheduleSnapshot.latestRunTriggerSource) }}</p>
              <p class="directory-admin__hint"><strong>最近一次手动执行：</strong>{{ formatDateTime(scheduleSnapshot.latestManualRunAt) }}</p>
              <p class="directory-admin__hint"><strong>最近一次自动执行：</strong>{{ formatDateTime(scheduleSnapshot.latestAutoRunAt) }}</p>
            </div>

            <p class="directory-admin__hint">{{ scheduleSnapshot.note }}</p>
            <p v-if="readObservationCaution(scheduleSnapshot)" class="directory-admin__status directory-admin__status--error">
              {{ readObservationCaution(scheduleSnapshot) }}
            </p>
          </template>
        </section>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>最近告警</h3>
              <p class="directory-admin__hint">展示最近 10 条目录同步告警，支持按确认状态筛选并逐条确认。</p>
            </div>
            <div class="directory-admin__actions">
              <div class="directory-admin__filters directory-admin__filters--compact" role="group" aria-label="告警确认状态筛选">
                <button
                  v-for="option in alertFilterOptions"
                  :key="option.value"
                  class="directory-admin__filter"
                  :class="{ 'directory-admin__filter--active': alertFilter === option.value }"
                  type="button"
                  @click="alertFilter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
              <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingAlerts" @click="void loadAlerts(selectedIntegration.id)">
                {{ loadingAlerts ? '刷新中...' : '刷新告警' }}
              </button>
            </div>
          </div>

          <div v-if="loadingAlerts" class="directory-admin__empty">告警加载中...</div>
          <div v-else-if="alerts.length === 0" class="directory-admin__empty">当前筛选下暂无告警</div>
          <article v-for="alert in alerts" :key="alert.id" class="directory-admin__alert">
            <div class="directory-admin__alert-head">
              <div>
                <strong>{{ alert.code }}</strong>
                <p class="directory-admin__hint">{{ alert.message }}</p>
              </div>
              <div class="directory-admin__chips">
                <span class="directory-admin__chip" :class="readAlertLevelClass(alert.level)">
                  {{ readAlertLevelLabel(alert.level) }}
                </span>
                <span class="directory-admin__chip" :class="alert.acknowledgedAt ? 'directory-admin__chip--success' : 'directory-admin__chip--warning'">
                  {{ alert.acknowledgedAt ? '已确认' : '待确认' }}
                </span>
              </div>
            </div>

            <div class="directory-admin__alert-grid">
              <p class="directory-admin__hint"><strong>创建时间：</strong>{{ formatDateTime(alert.createdAt) }}</p>
              <p class="directory-admin__hint"><strong>确认时间：</strong>{{ formatDateTime(alert.acknowledgedAt) }}</p>
            </div>

            <div class="directory-admin__actions">
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="acknowledgingAlertId === alert.id || Boolean(alert.acknowledgedAt)"
                @click="void acknowledgeAlert(alert.id)"
              >
                {{ alert.acknowledgedAt ? '已确认' : acknowledgingAlertId === alert.id ? '确认中...' : '确认告警' }}
              </button>
            </div>
          </article>
        </section>

        <section v-if="selectedIntegration" class="directory-admin__section">
          <div class="directory-admin__section-head">
            <div>
              <h3>待处理队列</h3>
              <p class="directory-admin__hint">先处理未绑定、目录停用但仍已绑定、以及缺身份键的成员。批量停权只会作用到当前选中且仍绑定本地用户的成员。</p>
            </div>
            <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingReviewItems" @click="void loadReviewItems(selectedIntegration.id)">
              {{ loadingReviewItems ? '刷新中...' : '刷新队列' }}
            </button>
          </div>

          <div class="directory-admin__filters" role="group" aria-label="待处理队列筛选">
            <button
              v-for="option in reviewQueueOptions"
              :key="option.value"
              class="directory-admin__filter"
              :class="{ 'directory-admin__filter--active': reviewQueue === option.value }"
              type="button"
              @click="reviewQueue = option.value"
            >
              {{ option.label }} {{ reviewCounts[option.countKey] }}
            </button>
          </div>

          <div v-if="reviewItems.length > 0" class="directory-admin__bulkbar">
            <p class="directory-admin__hint">
              已选择 {{ selectedReviewAccountIds.length }} 个待处理成员，其中 {{ selectedReviewLinkedAccountIds.length }} 个仍绑定本地用户。
            </p>
            <div class="directory-admin__actions">
              <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingReviewItems || reviewItems.length === 0" @click="clearReviewSelection()">
                清空选择
              </button>
              <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingReviewItems || reviewItems.length === 0" @click="selectVisibleReviewItems()">
                选择当前队列
              </button>
              <label class="directory-admin__toggle directory-admin__toggle--compact">
                <input v-model="reviewDisableGrant" type="checkbox" />
                <span>解绑时同时关闭钉钉登录</span>
              </label>
              <button class="directory-admin__button" type="button" :disabled="batchUnbinding || selectedReviewLinkedAccountIds.length === 0" @click="void batchUnbindReviewItems()">
                {{ batchUnbinding ? '处理中...' : '批量停权处理' }}
              </button>
              <button class="directory-admin__button" type="button" :disabled="batchBinding || selectedReviewBindingBindings.length === 0" @click="void batchBindReviewItems()">
                {{ batchBinding ? '处理中...' : `批量绑定用户 (${selectedReviewBindingBindings.length})` }}
              </button>
            </div>
          </div>

          <div v-if="loadingReviewItems" class="directory-admin__empty">待处理队列加载中...</div>
          <div v-else-if="reviewItems.length === 0" class="directory-admin__empty">当前筛选下暂无待处理成员</div>
          <article v-for="account in reviewItems" :key="account.id" class="directory-admin__account directory-admin__account--review">
            <div class="directory-admin__account-head">
              <label class="directory-admin__toggle directory-admin__toggle--compact">
                <input :checked="selectedReviewAccountIds.includes(account.id)" type="checkbox" @change="toggleReviewSelection(account.id, $event)" />
                <span>选择</span>
              </label>
              <div>
                <strong>{{ account.name }}</strong>
                <p class="directory-admin__hint">
                  {{ account.localUser ? `本地用户：${account.localUser.email || account.localUser.id}` : '未绑定本地用户，请在成员表中完成绑定' }}
                </p>
              </div>
              <div class="directory-admin__chips">
                <span v-for="reason in account.reviewReasons" :key="`${account.id}-${reason}`" class="directory-admin__chip directory-admin__chip--warning">
                  {{ readReviewReasonLabel(reason) }}
                </span>
              </div>
            </div>

            <div class="directory-admin__account-grid">
              <p class="directory-admin__hint"><strong>用户 ID：</strong>{{ account.externalUserId }}</p>
              <p class="directory-admin__hint"><strong>Union ID：</strong>{{ account.unionId || '未返回' }}</p>
              <p class="directory-admin__hint"><strong>Open ID：</strong>{{ account.openId || '未返回' }}</p>
              <p class="directory-admin__hint"><strong>目录状态：</strong>{{ account.isActive ? '启用' : '停用' }}</p>
            </div>

            <div class="directory-admin__form-grid directory-admin__form-grid--account">
              <label class="directory-admin__field">
                <span>绑定到本地用户 ID / 邮箱</span>
                <input
                  :value="readReviewBindingDraft(account)"
                  class="directory-admin__input"
                  type="text"
                  placeholder="例如 user-123 或 alpha@example.com"
                  @input="onReviewBindingDraftInput(account.id, $event)"
                  @focus="clearReviewBindingSearch(account.id)"
                />
              </label>
              <label class="directory-admin__toggle directory-admin__toggle--compact">
                <input
                  :checked="readReviewGrantToggle(account.id)"
                  type="checkbox"
                  @change="onReviewGrantToggleChange(account.id, $event)"
                />
                <span>绑定后同时开通钉钉登录</span>
              </label>
            </div>

            <div class="directory-admin__actions">
              <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="void focusReviewItem(account)">
                在成员表中定位
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="readReviewBindingDraft(account).trim().length === 0 || readReviewBindingSearchLoading(account.id)"
                @click="void searchReviewLocalUsers(account.id)"
              >
                {{ readReviewBindingSearchLoading(account.id) ? '搜索中...' : '搜索候选用户' }}
              </button>
              <button
                class="directory-admin__button"
                type="button"
                :disabled="reviewBindingAccountId === account.id || readReviewBindingDraft(account).trim().length === 0"
                @click="void bindReviewAccount(account)"
              >
                {{ reviewBindingAccountId === account.id ? '绑定中...' : account.localUser ? '更新绑定' : '快速绑定' }}
              </button>
            </div>

            <p v-if="readReviewBindingSearchError(account.id)" class="directory-admin__status directory-admin__status--error">
              {{ readReviewBindingSearchError(account.id) }}
            </p>
            <div v-if="readReviewBindingSearchResults(account.id).length > 0" class="directory-admin__search-results">
              <button
                v-for="user in readReviewBindingSearchResults(account.id)"
                :key="user.id"
                class="directory-admin__search-result"
                type="button"
                @click="chooseReviewLocalUser(account.id, user)"
              >
                <strong>{{ user.name || user.email }}</strong>
                <span>{{ user.email }}</span>
                <small>{{ user.id }} · {{ user.role }} · {{ user.is_active ? 'active' : 'inactive' }}</small>
              </button>
            </div>
          </article>
        </section>

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

          <div v-if="loadingAccounts" class="directory-admin__empty">成员加载中...</div>
          <div v-else-if="accounts.length === 0" class="directory-admin__empty">暂无同步成员</div>
          <article v-for="account in accounts" :key="account.id" class="directory-admin__account">
            <div class="directory-admin__account-head">
              <div>
                <strong>{{ account.name }}</strong>
                <p class="directory-admin__hint">
                  {{ account.localUser ? `本地用户：${account.localUser.email || account.localUser.id}` : '未绑定本地用户' }}
                </p>
              </div>
              <div class="directory-admin__chips">
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
            </div>

            <p class="directory-admin__hint">
              部门：{{ account.departmentPaths.join('，') || '未分配部门' }}
            </p>

            <div class="directory-admin__form-grid directory-admin__form-grid--account">
              <label class="directory-admin__field">
                <span>绑定到本地用户 ID / 邮箱</span>
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
                  :checked="readGrantToggle(account.id)"
                  type="checkbox"
                  @change="onGrantToggleChange(account.id, $event)"
                />
                <span>绑定后同时开通钉钉登录</span>
              </label>
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
                <strong>{{ user.name || user.email }}</strong>
                <span>{{ user.email }}</span>
                <small>{{ user.id }} · {{ user.role }} · {{ user.is_active ? 'active' : 'inactive' }}</small>
              </button>
            </div>
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

        <section v-if="testResult" class="directory-admin__section">
          <h3>连通性测试</h3>
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
            <p v-if="run.errorMessage" class="directory-admin__status directory-admin__status--error">{{ run.errorMessage }}</p>
          </article>
        </section>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { apiFetch } from '../utils/api'

type DirectoryIntegration = {
  id: string
  name: string
  corpId: string
  status: string
  syncEnabled: boolean
  scheduleCron: string | null
  defaultDeprovisionPolicy: string
  lastSyncAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  config: {
    appKey: string
    appSecretConfigured: boolean
    rootDepartmentId: string
    baseUrl: string | null
    pageSize: number
  }
  stats: {
    departmentCount: number
    accountCount: number
    pendingLinkCount: number
    linkedCount: number
    lastRunStatus: string | null
  }
}

type DirectoryRun = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats: Record<string, unknown>
  errorMessage: string | null
}

type DirectoryAccount = {
  id: string
  integrationId: string
  provider: string
  corpId: string | null
  externalUserId: string
  unionId: string | null
  openId: string | null
  externalKey: string
  name: string
  email: string | null
  mobile: string | null
  isActive: boolean
  updatedAt: string
  linkStatus: string
  matchStrategy: string | null
  reviewedBy: string | null
  reviewNote: string | null
  linkUpdatedAt: string | null
  localUser: {
    id: string
    email: string | null
    name: string | null
  } | null
  departmentPaths: string[]
}

type DirectoryReviewReason = 'needs_binding' | 'inactive_linked' | 'missing_identity'

type DirectoryReviewItem = DirectoryAccount & {
  reviewReasons: DirectoryReviewReason[]
}

type DirectoryReviewCounts = {
  total: number
  needsBinding: number
  inactiveLinked: number
  missingIdentity: number
}

type DirectoryAlertFilter = 'all' | 'pending' | 'acknowledged'

type DirectorySyncAlert = {
  id: string
  integrationId: string
  runId: string | null
  level: string
  code: string
  message: string
  details: Record<string, unknown>
  sentToWebhook: boolean
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  createdAt: string
  updatedAt: string
}

type DirectoryAlertCounts = {
  total: number
  pending: number
  acknowledged: number
}

type DirectoryScheduleObservationStatus =
  | 'disabled'
  | 'missing_cron'
  | 'invalid_cron'
  | 'configured_no_runs'
  | 'manual_only'
  | 'auto_observed'

type DirectoryScheduleSnapshot = {
  integrationId: string
  syncEnabled: boolean
  scheduleCron: string | null
  cronValid: boolean
  nextExpectedRunAt: string | null
  timezone: string
  latestRunAt: string | null
  latestRunStatus: string | null
  latestRunTriggerSource: string | null
  latestManualRunAt: string | null
  latestManualRunStatus: string | null
  latestAutoRunAt: string | null
  latestAutoRunStatus: string | null
  autoTriggerObserved: boolean
  observationStatus: DirectoryScheduleObservationStatus
  note: string
}

type LocalUserOption = {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
}

type TestResult = {
  rootDepartmentId: string
  departmentSampleCount: number
  sampledDepartments: Array<{ id: string; name: string }>
  userSampleCount: number
  sampledUsers: Array<{ userId: string; name: string }>
  diagnostics: {
    rootDepartmentChildCount: number
    rootDepartmentDirectUserCount: number
    rootDepartmentDirectUserHasMore: boolean
    rootDepartmentDirectUserCountWithAccessLimit: number
    rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
    sampledRootDepartmentUsers: Array<{ userId: string; name: string }>
    sampledRootDepartmentUsersWithAccessLimit: Array<{ userId: string; name: string }>
  }
  warnings: string[]
}

type DirectoryDraft = {
  name: string
  corpId: string
  appKey: string
  appSecret: string
  rootDepartmentId: string
  baseUrl: string
  pageSize: number
  status: string
  scheduleCron: string
  defaultDeprovisionPolicy: string
  syncEnabled: boolean
}

const integrations = ref<DirectoryIntegration[]>([])
const runs = ref<DirectoryRun[]>([])
const accounts = ref<DirectoryAccount[]>([])
const reviewItems = ref<DirectoryReviewItem[]>([])
const alerts = ref<DirectorySyncAlert[]>([])
const scheduleSnapshot = ref<DirectoryScheduleSnapshot | null>(null)
const accountPageSizeOptions = [25, 50, 100]
const accountPage = ref(1)
const accountPageSize = ref(25)
const accountTotal = ref(0)
const selectedIntegrationId = ref('')
const loading = ref(false)
const loadingRuns = ref(false)
const loadingSchedule = ref(false)
const loadingAccounts = ref(false)
const loadingReviewItems = ref(false)
const loadingAlerts = ref(false)
const busy = ref(false)
const bindingAccountId = ref('')
const unbindingAccountId = ref('')
const acknowledgingAlertId = ref('')
const batchUnbinding = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const testResult = ref<TestResult | null>(null)
const accountQuery = ref('')
const reviewQueue = ref<'all' | DirectoryReviewReason>('all')
const alertFilter = ref<DirectoryAlertFilter>('pending')
const reviewCounts = ref<DirectoryReviewCounts>({
  total: 0,
  needsBinding: 0,
  inactiveLinked: 0,
  missingIdentity: 0,
})
const alertCounts = ref<DirectoryAlertCounts>({
  total: 0,
  pending: 0,
  acknowledged: 0,
})
const selectedReviewAccountIds = ref<string[]>([])
const reviewDisableGrant = ref(true)
const batchBinding = ref(false)
const reviewBindingAccountId = ref('')
const bindingDrafts = reactive<Record<string, string>>({})
const userSearchResults = reactive<Record<string, LocalUserOption[]>>({})
const userSearchLoading = reactive<Record<string, boolean>>({})
const userSearchError = reactive<Record<string, string>>({})
const grantToggles = reactive<Record<string, boolean>>({})
const reviewBindingDrafts = reactive<Record<string, string>>({})
const reviewUserSearchResults = reactive<Record<string, LocalUserOption[]>>({})
const reviewUserSearchLoading = reactive<Record<string, boolean>>({})
const reviewUserSearchError = reactive<Record<string, string>>({})
const reviewGrantToggles = reactive<Record<string, boolean>>({})

const draft = reactive<DirectoryDraft>({
  name: '',
  corpId: '',
  appKey: '',
  appSecret: '',
  rootDepartmentId: '1',
  baseUrl: '',
  pageSize: 50,
  status: 'active',
  scheduleCron: '',
  defaultDeprovisionPolicy: 'mark_inactive',
  syncEnabled: false,
})

const selectedIntegration = computed(() =>
  integrations.value.find((integration) => integration.id === selectedIntegrationId.value) ?? null,
)
const accountPageCount = computed(() => Math.max(1, Math.ceil(accountTotal.value / accountPageSize.value)))
const accountRangeStart = computed(() => (
  accountTotal.value === 0
    ? 0
    : ((accountPage.value - 1) * accountPageSize.value) + 1
))
const accountRangeEnd = computed(() => (
  accountTotal.value === 0
    ? 0
    : Math.min(accountPage.value * accountPageSize.value, accountTotal.value)
))
const selectedReviewLinkedAccountIds = computed(() => reviewItems.value
  .filter((item) => selectedReviewAccountIds.value.includes(item.id) && item.localUser)
  .map((item) => item.id))
const selectedReviewBindingBindings = computed(() => reviewItems.value
  .filter((item) => selectedReviewAccountIds.value.includes(item.id))
  .map((item) => ({
    accountId: item.id,
    localUserRef: readReviewBindingDraftByAccountId(item.id).trim(),
    enableDingTalkGrant: readReviewGrantToggle(item.id),
  }))
  .filter((item) => item.localUserRef.length > 0))
const reviewQueueOptions = [
  { value: 'all', label: '全部待处理', countKey: 'total' },
  { value: 'needs_binding', label: '待绑定', countKey: 'needsBinding' },
  { value: 'inactive_linked', label: '目录停用但仍已绑定', countKey: 'inactiveLinked' },
  { value: 'missing_identity', label: '缺身份键', countKey: 'missingIdentity' },
] as const
const alertFilterOptions = [
  { value: 'pending', label: '待确认', countKey: 'pending' },
  { value: 'acknowledged', label: '已确认', countKey: 'acknowledged' },
  { value: 'all', label: '全部告警', countKey: 'total' },
] as const

const canSave = computed(() =>
  draft.name.trim().length > 0 &&
  draft.corpId.trim().length > 0 &&
  draft.appKey.trim().length > 0 &&
  (selectedIntegration.value !== null || draft.appSecret.trim().length > 0),
)

function setStatus(message: string, tone: 'info' | 'error' = 'info') {
  status.value = message
  statusTone.value = tone
}

function resetDraft() {
  selectedIntegrationId.value = ''
  testResult.value = null
  runs.value = []
  accounts.value = []
  reviewItems.value = []
  alerts.value = []
  scheduleSnapshot.value = null
  accountPage.value = 1
  accountPageSize.value = accountPageSizeOptions[0]
  accountTotal.value = 0
  accountQuery.value = ''
  reviewQueue.value = 'all'
  alertFilter.value = 'pending'
  reviewCounts.value = {
    total: 0,
    needsBinding: 0,
    inactiveLinked: 0,
    missingIdentity: 0,
  }
  alertCounts.value = {
    total: 0,
    pending: 0,
    acknowledged: 0,
  }
  selectedReviewAccountIds.value = []
  reviewDisableGrant.value = true
  for (const key of Object.keys(bindingDrafts)) delete bindingDrafts[key]
  for (const key of Object.keys(userSearchResults)) delete userSearchResults[key]
  for (const key of Object.keys(userSearchLoading)) delete userSearchLoading[key]
  for (const key of Object.keys(userSearchError)) delete userSearchError[key]
  for (const key of Object.keys(grantToggles)) delete grantToggles[key]
  for (const key of Object.keys(reviewBindingDrafts)) delete reviewBindingDrafts[key]
  for (const key of Object.keys(reviewUserSearchResults)) delete reviewUserSearchResults[key]
  for (const key of Object.keys(reviewUserSearchLoading)) delete reviewUserSearchLoading[key]
  for (const key of Object.keys(reviewUserSearchError)) delete reviewUserSearchError[key]
  for (const key of Object.keys(reviewGrantToggles)) delete reviewGrantToggles[key]
  batchBinding.value = false
  reviewBindingAccountId.value = ''
  acknowledgingAlertId.value = ''
  draft.name = ''
  draft.corpId = ''
  draft.appKey = ''
  draft.appSecret = ''
  draft.rootDepartmentId = '1'
  draft.baseUrl = ''
  draft.pageSize = 50
  draft.status = 'active'
  draft.scheduleCron = ''
  draft.defaultDeprovisionPolicy = 'mark_inactive'
  draft.syncEnabled = false
}

function applyIntegrationToDraft(integration: DirectoryIntegration) {
  draft.name = integration.name
  draft.corpId = integration.corpId
  draft.appKey = integration.config.appKey
  draft.appSecret = ''
  draft.rootDepartmentId = integration.config.rootDepartmentId
  draft.baseUrl = integration.config.baseUrl ?? ''
  draft.pageSize = integration.config.pageSize
  draft.status = integration.status
  draft.scheduleCron = integration.scheduleCron ?? ''
  draft.defaultDeprovisionPolicy = integration.defaultDeprovisionPolicy
  draft.syncEnabled = integration.syncEnabled
}

function selectIntegration(integrationId: string) {
  selectedIntegrationId.value = integrationId
  testResult.value = null
  accountPage.value = 1
  accountTotal.value = 0
  const integration = integrations.value.find((item) => item.id === integrationId)
  if (!integration) return
  applyIntegrationToDraft(integration)
  void Promise.all([
    loadRuns(integrationId),
    loadScheduleSnapshot(integrationId),
    loadAlerts(integrationId),
    loadReviewItems(integrationId),
    loadAccounts(integrationId),
  ])
}

function readApiError(payload: unknown, fallback: string): string {
  const error = payload && typeof payload === 'object' ? (payload as { error?: { message?: unknown } }).error : undefined
  return typeof error?.message === 'string' && error.message.trim().length > 0 ? error.message : fallback
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function loadIntegrations() {
  loading.value = true
  try {
    const response = await apiFetch('/api/admin/directory/integrations')
    const payload = await readJson(response)
    if (!response.ok) throw new Error(readApiError(payload, '加载目录集成失败'))

    integrations.value = Array.isArray(payload?.data?.items) ? payload.data.items : []
    if (!selectedIntegrationId.value && integrations.value.length > 0) {
      selectIntegration(integrations.value[0].id)
    } else if (selectedIntegrationId.value) {
      const current = integrations.value.find((item) => item.id === selectedIntegrationId.value)
      if (current) applyIntegrationToDraft(current)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载目录集成失败', 'error')
  } finally {
    loading.value = false
  }
}

function readBindingDraft(account: DirectoryAccount): string {
  return bindingDrafts[account.id] ?? account.localUser?.email ?? account.localUser?.id ?? ''
}

function readBindingDraftByAccountId(accountId: string): string {
  const account = accounts.value.find((item) => item.id === accountId)
  if (!account) return bindingDrafts[accountId] ?? ''
  return readBindingDraft(account)
}

function updateBindingDraft(accountId: string, value: string) {
  bindingDrafts[accountId] = value
}

function onBindingDraftInput(accountId: string, event: Event) {
  const target = event.target
  updateBindingDraft(accountId, target instanceof HTMLInputElement ? target.value : '')
  clearBindingSearch(accountId)
}

function readBindingSearchResults(accountId: string): LocalUserOption[] {
  return userSearchResults[accountId] ?? []
}

function readBindingSearchLoading(accountId: string): boolean {
  return userSearchLoading[accountId] ?? false
}

function readBindingSearchError(accountId: string): string {
  return userSearchError[accountId] ?? ''
}

function setBindingSearchState(accountId: string, state: {
  loading?: boolean
  error?: string
  results?: LocalUserOption[]
}) {
  if (typeof state.loading === 'boolean') userSearchLoading[accountId] = state.loading
  if (typeof state.error === 'string') userSearchError[accountId] = state.error
  else delete userSearchError[accountId]
  if (Array.isArray(state.results)) userSearchResults[accountId] = state.results
}

async function searchLocalUsers(accountId: string) {
  const term = readBindingDraftByAccountId(accountId).trim()
  if (!term) {
    setBindingSearchState(accountId, { results: [], error: '', loading: false })
    return
  }

  setBindingSearchState(accountId, { loading: true, error: '' })
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '8', q: term })
    const response = await apiFetch(`/api/admin/users?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '搜索本地用户失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    setBindingSearchState(accountId, { results: items, loading: false })
  } catch (error) {
    setBindingSearchState(accountId, {
      results: [],
      loading: false,
      error: error instanceof Error ? error.message : '搜索本地用户失败',
    })
  }
}

function chooseLocalUser(accountId: string, user: LocalUserOption) {
  updateBindingDraft(accountId, user.email || user.id)
  setBindingSearchState(accountId, { results: [] })
}

function readGrantToggle(accountId: string): boolean {
  return grantToggles[accountId] ?? true
}

function updateGrantToggle(accountId: string, value: boolean) {
  grantToggles[accountId] = value
}

function onGrantToggleChange(accountId: string, event: Event) {
  const target = event.target
  updateGrantToggle(accountId, target instanceof HTMLInputElement ? target.checked : true)
}

function clearBindingSearch(accountId: string) {
  setBindingSearchState(accountId, { results: [], error: '' })
}

function clearReviewSelection() {
  selectedReviewAccountIds.value = []
}

function selectVisibleReviewItems() {
  selectedReviewAccountIds.value = reviewItems.value.map((item) => item.id)
}

function toggleReviewSelection(accountId: string, event: Event) {
  const target = event.target
  const checked = target instanceof HTMLInputElement ? target.checked : false
  if (checked) {
    if (!selectedReviewAccountIds.value.includes(accountId)) {
      selectedReviewAccountIds.value = [...selectedReviewAccountIds.value, accountId]
    }
    return
  }
  selectedReviewAccountIds.value = selectedReviewAccountIds.value.filter((item) => item !== accountId)
}

function readReviewReasonLabel(reason: DirectoryReviewReason): string {
  if (reason === 'needs_binding') return '待绑定'
  if (reason === 'inactive_linked') return '目录停用但仍已绑定'
  return '缺 openId / unionId'
}

function readAlertLevelLabel(level: string | null | undefined): string {
  const normalizedLevel = typeof level === 'string' ? level.trim().toLowerCase() : ''
  if (normalizedLevel === 'critical' || normalizedLevel === 'error') return '严重'
  if (normalizedLevel === 'warning') return '警告'
  return '信息'
}

function readAlertLevelClass(level: string | null | undefined): string {
  const normalizedLevel = typeof level === 'string' ? level.trim().toLowerCase() : ''
  if (normalizedLevel === 'critical' || normalizedLevel === 'error') return 'directory-admin__chip--critical'
  if (normalizedLevel === 'warning') return 'directory-admin__chip--warning'
  return 'directory-admin__chip--info'
}

function readObservationStatusLabel(status: DirectoryScheduleObservationStatus): string {
  if (status === 'disabled') return '未启用'
  if (status === 'missing_cron') return '缺少 Cron'
  if (status === 'invalid_cron') return 'Cron 无效'
  if (status === 'configured_no_runs') return '仅有配置'
  if (status === 'manual_only') return '仅观察到手动执行'
  return '已观察到自动执行'
}

function readObservationStatusClass(status: DirectoryScheduleObservationStatus): string {
  if (status === 'auto_observed') return 'directory-admin__chip--success'
  if (status === 'disabled') return 'directory-admin__badge--inactive'
  if (status === 'missing_cron' || status === 'invalid_cron') return 'directory-admin__chip--critical'
  return 'directory-admin__chip--warning'
}

function readTriggerSourceLabel(triggerSource: string | null): string {
  if (!triggerSource) return '未记录'
  return triggerSource
}

function readObservationCaution(snapshot: DirectoryScheduleSnapshot | null): string {
  if (!snapshot) return ''
  if (snapshot.observationStatus === 'auto_observed') return ''
  if (!snapshot.syncEnabled) {
    return '当前未启用自动同步；此卡片只展示配置与历史记录，不代表系统已接入自动调度。'
  }
  return '当前卡片只反映配置与已记录执行历史；在出现“已观察到自动执行”前，请不要假定系统已接入自动调度。'
}

function reviewBindingStateKey(accountId: string): string {
  return `${selectedIntegrationId.value || 'review'}:${accountId}`
}

function readReviewBindingDraft(account: DirectoryReviewItem): string {
  const key = reviewBindingStateKey(account.id)
  return reviewBindingDrafts[key] ?? account.localUser?.email ?? account.localUser?.id ?? ''
}

function readReviewBindingDraftByAccountId(accountId: string): string {
  const account = reviewItems.value.find((item) => item.id === accountId)
  if (!account) return reviewBindingDrafts[reviewBindingStateKey(accountId)] ?? ''
  return readReviewBindingDraft(account)
}

function updateReviewBindingDraft(accountId: string, value: string) {
  reviewBindingDrafts[reviewBindingStateKey(accountId)] = value
}

function onReviewBindingDraftInput(accountId: string, event: Event) {
  const target = event.target
  updateReviewBindingDraft(accountId, target instanceof HTMLInputElement ? target.value : '')
  clearReviewBindingSearch(accountId)
}

function readReviewBindingSearchResults(accountId: string): LocalUserOption[] {
  return reviewUserSearchResults[reviewBindingStateKey(accountId)] ?? []
}

function readReviewBindingSearchLoading(accountId: string): boolean {
  return reviewUserSearchLoading[reviewBindingStateKey(accountId)] ?? false
}

function readReviewBindingSearchError(accountId: string): string {
  return reviewUserSearchError[reviewBindingStateKey(accountId)] ?? ''
}

function setReviewBindingSearchState(accountId: string, state: {
  loading?: boolean
  error?: string
  results?: LocalUserOption[]
}) {
  const key = reviewBindingStateKey(accountId)
  if (typeof state.loading === 'boolean') reviewUserSearchLoading[key] = state.loading
  if (typeof state.error === 'string') reviewUserSearchError[key] = state.error
  else delete reviewUserSearchError[key]
  if (Array.isArray(state.results)) reviewUserSearchResults[key] = state.results
}

async function searchReviewLocalUsers(accountId: string) {
  const term = readReviewBindingDraftByAccountId(accountId).trim()
  if (!term) {
    setReviewBindingSearchState(accountId, { results: [], error: '', loading: false })
    return
  }

  setReviewBindingSearchState(accountId, { loading: true, error: '' })
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '8', q: term })
    const response = await apiFetch(`/api/admin/users?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '搜索本地用户失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    setReviewBindingSearchState(accountId, { results: items, loading: false })
  } catch (error) {
    setReviewBindingSearchState(accountId, {
      results: [],
      loading: false,
      error: error instanceof Error ? error.message : '搜索本地用户失败',
    })
  }
}

function chooseReviewLocalUser(accountId: string, user: LocalUserOption) {
  updateReviewBindingDraft(accountId, user.email || user.id)
  setReviewBindingSearchState(accountId, { results: [] })
}

function readReviewGrantToggle(accountId: string): boolean {
  const key = reviewBindingStateKey(accountId)
  return reviewGrantToggles[key] ?? true
}

function updateReviewGrantToggle(accountId: string, value: boolean) {
  reviewGrantToggles[reviewBindingStateKey(accountId)] = value
}

function onReviewGrantToggleChange(accountId: string, event: Event) {
  const target = event.target
  updateReviewGrantToggle(accountId, target instanceof HTMLInputElement ? target.checked : true)
}

function clearReviewBindingSearch(accountId: string) {
  setReviewBindingSearchState(accountId, { results: [], error: '' })
}

async function focusReviewItem(account: DirectoryReviewItem) {
  if (!selectedIntegration.value) return
  accountQuery.value = account.externalUserId
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
  setStatus(`已在成员表中定位目录成员 ${account.name}`)
}

async function submitReviewBindings(
  bindings: Array<{ accountId: string; localUserRef: string; enableDingTalkGrant: boolean }>,
  successMessage: string,
) {
  if (!selectedIntegration.value || bindings.length === 0) return

  const response = await apiFetch('/api/admin/directory/accounts/batch-bind', {
    method: 'POST',
    body: JSON.stringify({ bindings }),
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, '批量绑定失败'))

  await Promise.all([
    loadIntegrations(),
    loadReviewItems(selectedIntegration.value.id),
    loadAccounts(selectedIntegration.value.id),
  ])
  setStatus(successMessage)
}

function buildPayload() {
  return {
    integrationId: selectedIntegration.value?.id,
    name: draft.name.trim(),
    corpId: draft.corpId.trim(),
    appKey: draft.appKey.trim(),
    appSecret: draft.appSecret.trim(),
    rootDepartmentId: draft.rootDepartmentId.trim() || '1',
    baseUrl: draft.baseUrl.trim(),
    pageSize: Number(draft.pageSize || 50),
    status: draft.status,
    scheduleCron: draft.scheduleCron.trim(),
    defaultDeprovisionPolicy: draft.defaultDeprovisionPolicy,
    syncEnabled: draft.syncEnabled,
  }
}

async function saveIntegration() {
  busy.value = true
  try {
    const payload = buildPayload()
    const path = selectedIntegration.value
      ? `/api/admin/directory/integrations/${selectedIntegration.value.id}`
      : '/api/admin/directory/integrations'
    const method = selectedIntegration.value ? 'PUT' : 'POST'
    const response = await apiFetch(path, {
      method,
      body: JSON.stringify(payload),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '保存目录集成失败'))

    const integration = body?.data?.integration as DirectoryIntegration | undefined
    setStatus(selectedIntegration.value ? '目录集成已更新' : '目录集成已创建')
    testResult.value = null
    await loadIntegrations()
    if (integration?.id) selectIntegration(integration.id)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存目录集成失败', 'error')
  } finally {
    busy.value = false
  }
}

async function testIntegration() {
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/integrations/test', {
      method: 'POST',
      body: JSON.stringify(buildPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '目录连通性测试失败'))
    testResult.value = body?.data ?? null
    setStatus('目录连通性测试通过')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '目录连通性测试失败', 'error')
  } finally {
    busy.value = false
  }
}

async function syncIntegration() {
  if (!selectedIntegration.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${selectedIntegration.value.id}/sync`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '目录同步失败'))
    setStatus('目录同步已完成')
    await Promise.all([
      loadIntegrations(),
      loadRuns(selectedIntegration.value.id),
      loadScheduleSnapshot(selectedIntegration.value.id),
      loadAlerts(selectedIntegration.value.id),
      loadReviewItems(selectedIntegration.value.id),
      loadAccounts(selectedIntegration.value.id),
    ])
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '目录同步失败', 'error')
  } finally {
    busy.value = false
  }
}

async function loadAlerts(integrationId: string) {
  loadingAlerts.value = true
  try {
    const params = new URLSearchParams({
      page: '1',
      pageSize: '10',
      ack: alertFilter.value,
    })
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/alerts?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载目录告警失败'))
    alerts.value = Array.isArray(body?.data?.items) ? body.data.items : []
    alertCounts.value = {
      total: Number(body?.data?.counts?.total ?? 0),
      pending: Number(body?.data?.counts?.pending ?? 0),
      acknowledged: Number(body?.data?.counts?.acknowledged ?? 0),
    }
  } catch (error) {
    alerts.value = []
    alertCounts.value = {
      total: 0,
      pending: 0,
      acknowledged: 0,
    }
    setStatus(error instanceof Error ? error.message : '加载目录告警失败', 'error')
  } finally {
    loadingAlerts.value = false
  }
}

async function loadScheduleSnapshot(integrationId: string) {
  loadingSchedule.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/schedule`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载自动同步观测失败'))
    scheduleSnapshot.value = body?.data?.snapshot ?? null
  } catch (error) {
    scheduleSnapshot.value = null
    setStatus(error instanceof Error ? error.message : '加载自动同步观测失败', 'error')
  } finally {
    loadingSchedule.value = false
  }
}

async function acknowledgeAlert(alertId: string) {
  if (!selectedIntegration.value) return
  acknowledgingAlertId.value = alertId
  try {
    const response = await apiFetch(`/api/admin/directory/alerts/${alertId}/ack`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '确认目录告警失败'))
    await loadAlerts(selectedIntegration.value.id)
    setStatus('目录告警已确认')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '确认目录告警失败', 'error')
  } finally {
    acknowledgingAlertId.value = ''
  }
}

async function searchAccounts() {
  if (!selectedIntegration.value) return
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
}

async function changeAccountPage(nextPage: number) {
  if (!selectedIntegration.value) return
  const normalizedPage = Math.max(1, Math.min(nextPage, accountPageCount.value))
  if (normalizedPage === accountPage.value) return
  accountPage.value = normalizedPage
  await loadAccounts(selectedIntegration.value.id)
}

async function updateAccountPageSize(event: Event) {
  if (!selectedIntegration.value) return
  const target = event.target
  const nextPageSize = Number(target instanceof HTMLSelectElement ? target.value : accountPageSize.value)
  if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === accountPageSize.value) return
  accountPageSize.value = nextPageSize
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
}

async function loadAccounts(integrationId: string) {
  loadingAccounts.value = true
  try {
    const params = new URLSearchParams({
      page: String(accountPage.value),
      pageSize: String(accountPageSize.value),
    })
    if (accountQuery.value.trim().length > 0) {
      params.set('q', accountQuery.value.trim())
    }
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/accounts?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载目录成员失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    const total = typeof body?.data?.total === 'number'
      ? body.data.total
      : Number(body?.data?.total ?? items.length)
    const normalizedTotal = Number.isFinite(total) && total >= 0 ? total : items.length
    const maxPage = Math.max(1, Math.ceil(normalizedTotal / accountPageSize.value))
    if (normalizedTotal > 0 && accountPage.value > maxPage) {
      accountPage.value = maxPage
      await loadAccounts(integrationId)
      return
    }
    accountTotal.value = normalizedTotal
    accounts.value = items
  } catch (error) {
    accounts.value = []
    accountTotal.value = 0
    setStatus(error instanceof Error ? error.message : '加载目录成员失败', 'error')
  } finally {
    loadingAccounts.value = false
  }
}

async function loadReviewItems(integrationId: string) {
  loadingReviewItems.value = true
  try {
    const params = new URLSearchParams({
      page: '1',
      pageSize: '25',
      queue: reviewQueue.value,
    })
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/review-items?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载待处理队列失败'))
    reviewItems.value = Array.isArray(body?.data?.items) ? body.data.items : []
    reviewCounts.value = {
      total: Number(body?.data?.counts?.total ?? 0),
      needsBinding: Number(body?.data?.counts?.needsBinding ?? 0),
      inactiveLinked: Number(body?.data?.counts?.inactiveLinked ?? 0),
      missingIdentity: Number(body?.data?.counts?.missingIdentity ?? 0),
    }
    selectedReviewAccountIds.value = selectedReviewAccountIds.value.filter((accountId) => reviewItems.value.some((item) => item.id === accountId))
  } catch (error) {
    reviewItems.value = []
    reviewCounts.value = {
      total: 0,
      needsBinding: 0,
      inactiveLinked: 0,
      missingIdentity: 0,
    }
    setStatus(error instanceof Error ? error.message : '加载待处理队列失败', 'error')
  } finally {
    loadingReviewItems.value = false
  }
}

async function loadRuns(integrationId: string) {
  loadingRuns.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/runs?page=1&pageSize=10`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载同步记录失败'))
    runs.value = Array.isArray(body?.data?.items) ? body.data.items : []
  } catch (error) {
    runs.value = []
    setStatus(error instanceof Error ? error.message : '加载同步记录失败', 'error')
  } finally {
    loadingRuns.value = false
  }
}

async function bindAccount(account: DirectoryAccount) {
  bindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${account.id}/bind`, {
      method: 'POST',
      body: JSON.stringify({
        localUserRef: readBindingDraft(account).trim(),
        enableDingTalkGrant: readGrantToggle(account.id),
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '绑定目录成员失败'))

    const boundAccount = body?.data?.account as DirectoryAccount | undefined
    if (boundAccount) {
      accounts.value = accounts.value.map((item) => (item.id === boundAccount.id ? boundAccount : item))
      bindingDrafts[account.id] = boundAccount.localUser?.email || boundAccount.localUser?.id || readBindingDraft(account)
    }

    setStatus(`目录成员 ${account.name} 已绑定到本地用户`)
    if (selectedIntegration.value) {
      await loadIntegrations()
      await loadReviewItems(selectedIntegration.value.id)
      await loadAccounts(selectedIntegration.value.id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '绑定目录成员失败', 'error')
  } finally {
    bindingAccountId.value = ''
  }
}

async function unbindAccount(account: DirectoryAccount) {
  unbindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${account.id}/unbind`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '解除绑定失败'))

    const unboundAccount = body?.data?.account as DirectoryAccount | undefined
    accounts.value = accounts.value.map((item) => {
      if (item.id !== account.id) return item
      if (unboundAccount) return unboundAccount
      return {
        ...item,
        linkStatus: 'unmatched',
        matchStrategy: 'manual_unbound',
        localUser: null,
      }
    })
    delete bindingDrafts[account.id]
    clearBindingSearch(account.id)
    setStatus(`目录成员 ${account.name} 已解除绑定`)
    if (selectedIntegration.value) {
      await loadIntegrations()
      await loadReviewItems(selectedIntegration.value.id)
      await loadAccounts(selectedIntegration.value.id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '解除绑定失败', 'error')
  } finally {
    unbindingAccountId.value = ''
  }
}

async function batchUnbindReviewItems() {
  if (!selectedIntegration.value) return
  const accountIds = selectedReviewLinkedAccountIds.value
  if (accountIds.length === 0) return

  batchUnbinding.value = true
  try {
    const response = await apiFetch('/api/admin/directory/accounts/batch-unbind', {
      method: 'POST',
      body: JSON.stringify({
        accountIds,
        disableDingTalkGrant: reviewDisableGrant.value,
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '批量停权失败'))

    clearReviewSelection()
    await loadIntegrations()
    await loadReviewItems(selectedIntegration.value.id)
    await loadAccounts(selectedIntegration.value.id)
    setStatus(reviewDisableGrant.value
      ? `已批量解除 ${accountIds.length} 个目录成员绑定并关闭钉钉登录`
      : `已批量解除 ${accountIds.length} 个目录成员绑定`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '批量停权失败', 'error')
  } finally {
    batchUnbinding.value = false
  }
}

async function bindReviewAccount(account: DirectoryReviewItem) {
  const localUserRef = readReviewBindingDraft(account).trim()
  if (!selectedIntegration.value || localUserRef.length === 0) return

  reviewBindingAccountId.value = account.id
  try {
    await submitReviewBindings([
      {
        accountId: account.id,
        localUserRef,
        enableDingTalkGrant: readReviewGrantToggle(account.id),
      },
    ], `目录成员 ${account.name} 已绑定到本地用户`)
    clearReviewSelection()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '绑定目录成员失败', 'error')
  } finally {
    reviewBindingAccountId.value = ''
  }
}

async function batchBindReviewItems() {
  if (!selectedIntegration.value) return
  const bindings = selectedReviewBindingBindings.value
  if (bindings.length === 0) return

  batchBinding.value = true
  try {
    await submitReviewBindings(bindings, `已批量绑定 ${bindings.length} 个目录成员`)
    clearReviewSelection()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '批量绑定失败', 'error')
  } finally {
    batchBinding.value = false
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function readNumericStat(stats: Record<string, unknown> | null | undefined, key: string): number {
  const value = stats && typeof stats === 'object' ? stats[key] : undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) return Number(value)
  return 0
}

function formatSampleUsers(users: Array<{ userId: string; name: string }>, hasMore: boolean): string {
  const summary = users.map((user) => `${user.name} (${user.userId})`).join('，')
  if (!summary) return '无'
  return hasMore ? `${summary} 等` : summary
}

onMounted(() => {
  void loadIntegrations()
})

watch(reviewQueue, async () => {
  if (!selectedIntegration.value) return
  clearReviewSelection()
  await loadReviewItems(selectedIntegration.value.id)
})

watch(alertFilter, async () => {
  if (!selectedIntegration.value) return
  await loadAlerts(selectedIntegration.value.id)
})
</script>

<style scoped>
.directory-admin {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
}

.directory-admin__header,
.directory-admin__section-head,
.directory-admin__footer,
.directory-admin__actions,
.directory-admin__run-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.directory-admin__layout {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 20px;
}

.directory-admin__panel {
  border: 1px solid #d8dee8;
  border-radius: 18px;
  background: #fff;
  padding: 20px;
  box-shadow: 0 14px 40px rgba(15, 23, 42, 0.06);
}

.directory-admin__panel--list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__panel--detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.directory-admin__item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border: 1px solid #d8dee8;
  border-radius: 14px;
  background: #f8fafc;
  text-align: left;
  cursor: pointer;
}

.directory-admin__item--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.directory-admin__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.directory-admin__form-grid--account {
  grid-template-columns: minmax(0, 1.8fr) minmax(220px, 1fr);
}

.directory-admin__field,
.directory-admin__toggle {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__field--inline {
  flex-direction: row;
  align-items: center;
}

.directory-admin__toggle {
  justify-content: flex-end;
}

.directory-admin__input {
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 10px 12px;
  font: inherit;
}

.directory-admin__input--search {
  min-width: min(320px, 100%);
}

.directory-admin__input--compact {
  min-width: 88px;
}

.directory-admin__button,
.directory-admin__link {
  border: 1px solid #1d4ed8;
  border-radius: 999px;
  padding: 9px 16px;
  background: #1d4ed8;
  color: #fff;
  text-decoration: none;
  font: inherit;
  cursor: pointer;
}

.directory-admin__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.directory-admin__button--secondary,
.directory-admin__link {
  background: #eff6ff;
  color: #1d4ed8;
}

.directory-admin__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__chips,
.directory-admin__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.directory-admin__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.directory-admin__filters--compact {
  max-width: min(100%, 480px);
}

.directory-admin__filter {
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  background: #fff;
  color: #1e293b;
  padding: 8px 14px;
  cursor: pointer;
}

.directory-admin__filter--active {
  border-color: #1d4ed8;
  background: #dbeafe;
  color: #1d4ed8;
}

.directory-admin__bulkbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid #bfdbfe;
  border-radius: 16px;
  background: linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
}

.directory-admin__chip,
.directory-admin__badge {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #0f172a;
  font-size: 13px;
}

.directory-admin__badge--inactive {
  background: #fef3c7;
  color: #92400e;
}

.directory-admin__chip--warning {
  background: #fef3c7;
  color: #92400e;
}

.directory-admin__chip--success {
  background: #dcfce7;
  color: #166534;
}

.directory-admin__chip--critical {
  background: #fee2e2;
  color: #991b1b;
}

.directory-admin__chip--info {
  background: #dbeafe;
  color: #1d4ed8;
}

.directory-admin__status {
  margin: 0;
  color: #0f766e;
}

.directory-admin__status--error {
  color: #b91c1c;
}

.directory-admin__hint,
.directory-admin__item small {
  margin: 0;
  color: #475569;
}

.directory-admin__empty {
  color: #64748b;
}

.directory-admin__run {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px;
  background: #f8fafc;
}

.directory-admin__alert {
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__alert-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.directory-admin__alert-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}

.directory-admin__account {
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__account-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.directory-admin__account-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}

.directory-admin__search-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__search-result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  background: #fff;
  text-align: left;
  cursor: pointer;
}

.directory-admin__search-result span,
.directory-admin__search-result small {
  color: #475569;
}

.directory-admin__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.directory-admin__toggle--compact {
  justify-content: center;
}

@media (max-width: 960px) {
  .directory-admin__layout,
  .directory-admin__form-grid {
    grid-template-columns: 1fr;
  }

  .directory-admin__account-grid {
    grid-template-columns: 1fr;
  }
}
</style>

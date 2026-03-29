<template>
  <section class="directory-admin">
    <header class="directory-admin__header">
      <div>
        <h1>钉钉组织目录同步</h1>
        <p>维护钉钉企业目录集成、同步运行、成员审核与离职策略。绑定与授权仍遵循 MetaSheet 内部审核规则。</p>
      </div>

      <div class="directory-admin__actions">
        <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="loadingIntegrations" @click="void loadIntegrations()">
          {{ loadingIntegrations ? '加载中...' : '刷新' }}
        </button>
        <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="startCreateIntegration()">
          新建集成
        </button>
        <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !selectedIntegrationId" @click="void testIntegration()">
          测试连接
        </button>
        <button class="directory-admin__button" type="button" :disabled="busy || !selectedIntegrationId" @click="void syncIntegration()">
          立即同步
        </button>
      </div>
    </header>

    <section
      v-if="latestRun || accountSummary.total > 0 || directoryScheduleStatus || directoryTemplateCenterLoaded"
      class="directory-admin__summary"
    >
      <article class="directory-admin__summary-card directory-admin__summary-card--run">
        <h3>最近同步</h3>
        <p class="directory-admin__summary-status" :class="latestRun?.status === 'success' ? 'directory-admin__summary-status--success' : ''">
          {{ latestRun ? `${latestRun.statusLabel} · ${latestRun.startedAt || '未知时间'}` : '尚未同步' }}
        </p>
        <p>部门 {{ latestRun?.departmentsFetched ?? 0 }} · 成员 {{ latestRun?.accountsFetched ?? 0 }} · 冲突 {{ latestRun?.linksConflicted ?? 0 }}</p>
        <div v-if="latestRun?.permissionHint" class="directory-admin__remediation directory-admin__remediation--inline">
          <p v-if="latestRun.permissionHint.requiredScopes.length > 0">缺少权限：{{ latestRun.permissionHint.requiredScopes.join('、') }}</p>
          <a v-if="latestRun.permissionHint.applyUrl" class="directory-admin__remediation-link" :href="latestRun.permissionHint.applyUrl" target="_blank" rel="noreferrer">
            申请钉钉权限
          </a>
        </div>
      </article>
      <article class="directory-admin__summary-card">
        <h3>成员概览</h3>
        <p>{{ accountSummary.total }} 名成员 · 已绑定 {{ accountSummary.bound }} · 已授权 {{ accountSummary.dingtalkAuthEnabled }}</p>
        <p>待审核 {{ accountSummary.pending }} · 已匹配 {{ accountSummary.linked }} · 冲突 {{ accountSummary.conflict }}</p>
      </article>
      <article v-if="directoryScheduleStatus" class="directory-admin__summary-card">
        <h3>计划同步</h3>
        <p>{{ directoryScheduleStatusSummary || '未配置计划同步' }}</p>
        <p>告警 {{ directoryScheduleStatus.alertCount }} · 未确认 {{ directoryScheduleStatus.unacknowledgedAlertCount }}</p>
      </article>
      <article v-if="directoryTemplateCenterLoaded" class="directory-admin__summary-card">
        <h3>模板中心</h3>
        <p>{{ directoryTemplateCenterSyncSummary || '服务端模板中心已加载' }}</p>
        <p>
          团队标准 {{ directoryTemplateGovernanceReport?.totals.teamTemplates ?? 0 }}
          · 导入预设 {{ directoryTemplateGovernanceReport?.totals.importPresets ?? 0 }}
          · 高频 {{ directoryTemplateGovernanceReport?.totals.highFrequency ?? 0 }}
        </p>
      </article>
    </section>

    <p v-if="status" class="directory-admin__status" :class="{ 'directory-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>
    <div v-if="statusPermissionHint" class="directory-admin__remediation">
      <p class="directory-admin__remediation-title">钉钉应用缺少通讯录权限</p>
      <p v-if="statusPermissionHint.requiredScopes.length > 0">缺少权限：{{ statusPermissionHint.requiredScopes.join('、') }}</p>
      <a v-if="statusPermissionHint.applyUrl" class="directory-admin__remediation-link" :href="statusPermissionHint.applyUrl" target="_blank" rel="noreferrer">
        前往钉钉开放平台申请权限
      </a>
    </div>

    <div class="directory-admin__layout">
      <aside class="directory-admin__panel directory-admin__panel--sidebar">
        <section class="directory-admin__section">
          <div class="directory-admin__section-head">
            <h2>集成列表</h2>
            <span>{{ integrations.length }} 项</span>
          </div>
          <div v-if="integrations.length === 0" class="directory-admin__empty">暂无目录集成</div>
          <button
            v-for="integration in integrations"
            :key="integration.id"
            class="directory-admin__item"
            :class="{ 'directory-admin__item--active': selectedIntegrationId === integration.id }"
            type="button"
            @click="selectIntegration(integration)"
          >
            <strong>{{ integration.name }}</strong>
            <span>{{ integration.corpId || '未填写 CorpID' }}</span>
            <small>{{ integration.provider }} · {{ integration.statusLabel }}</small>
            <small>默认离职策略：{{ policyLabel(integration.defaultDeprovisionPolicy) }}</small>
          </button>
        </section>

        <section class="directory-admin__section">
          <div class="directory-admin__section-head">
            <h2>部门目录</h2>
            <span>{{ departments.length }} 项</span>
          </div>
          <div v-if="departments.length === 0" class="directory-admin__empty">同步后显示部门树</div>
          <article v-for="department in departments" :key="department.id" class="directory-admin__department">
            <strong>{{ department.name }}</strong>
            <p>{{ department.fullPath || department.externalDepartmentId }}</p>
            <small>
              {{ department.isActive ? '在职' : '失活' }}
              · 排序 {{ department.orderIndex ?? '-' }}
            </small>
          </article>
        </section>
      </aside>

      <section class="directory-admin__panel directory-admin__panel--content">
        <template v-if="selectedIntegration || isCreating">
          <section class="directory-admin__section">
            <div class="directory-admin__section-head">
              <div>
                <h2>{{ isCreating ? '新建目录集成' : '集成配置' }}</h2>
                <p class="directory-admin__hint">配置保存后即可立即同步部门和成员目录。</p>
              </div>
              <div class="directory-admin__chip-row">
                <span class="directory-admin__chip">CorpID：{{ selectedIntegration?.corpId || draft.corpId || '未填写' }}</span>
                <span class="directory-admin__chip">状态：{{ selectedIntegration?.statusLabel || '新建' }}</span>
                <span class="directory-admin__chip">离职策略：{{ policyLabel(selectedIntegration?.defaultDeprovisionPolicy || draft.defaultDeprovisionPolicy) }}</span>
                <span class="directory-admin__chip">未开户登录捕获：{{ draft.captureUnboundLogins ? '开启' : '关闭' }}</span>
              </div>
            </div>

            <div class="directory-admin__form-grid">
              <label class="directory-admin__field">
                <span>集成名称</span>
                <input v-model.trim="draft.name" class="directory-admin__input" type="text" placeholder="例如 钉钉总部目录">
              </label>
              <label class="directory-admin__field">
                <span>CorpID</span>
                <input v-model.trim="draft.corpId" class="directory-admin__input" type="text" placeholder="dingxxxxxxxx">
              </label>
              <label class="directory-admin__field">
                <span>AppKey / Client ID</span>
                <input v-model.trim="draft.appKey" class="directory-admin__input" type="text" placeholder="dingxxxxxxxx">
              </label>
              <label class="directory-admin__field">
                <span>AppSecret / Client Secret</span>
                <input v-model.trim="draft.appSecret" class="directory-admin__input" type="password" placeholder="请输入应用密钥">
              </label>
              <label class="directory-admin__field">
                <span>根部门 ID</span>
                <input v-model.trim="draft.rootDepartmentId" class="directory-admin__input" type="text" placeholder="可选">
              </label>
              <label class="directory-admin__field">
                <span>定时同步 Cron</span>
                <input v-model.trim="draft.scheduleCron" class="directory-admin__input" type="text" placeholder="例如 0 3 * * *">
              </label>
              <div class="directory-admin__field">
                <span>默认离职策略</span>
                <div class="directory-admin__preset-row">
                  <button
                    v-for="preset in policyPresets"
                    :key="preset.key"
                    class="directory-admin__preset"
                    :class="{ 'directory-admin__preset--active': samePolicies(draft.defaultDeprovisionPolicy, preset.policies) }"
                    type="button"
                    @click="applyDraftPreset(preset.policies)"
                  >
                    {{ preset.label }}
                  </button>
                </div>
                <div class="directory-admin__policy-group">
                  <label v-for="option in policyOptions" :key="option.value" class="directory-admin__policy-option">
                    <input
                      type="checkbox"
                      :checked="hasPolicy(draft.defaultDeprovisionPolicy, option.value)"
                      @change="updateDraftDeprovisionPolicy(option.value, eventChecked($event))"
                    >
                    <span>{{ option.label }}</span>
                  </label>
                </div>
                <small class="directory-admin__hint">三项动作可自由组合，未勾选时仅保留目录状态变化。</small>
              </div>
              <label class="directory-admin__field directory-admin__field--checkbox">
                <span>启用定时同步</span>
                <input v-model="draft.syncEnabled" type="checkbox">
              </label>
              <label class="directory-admin__field directory-admin__field--checkbox">
                <span>未开通钉钉用户登录时加入管理员待审核队列</span>
                <input v-model="draft.captureUnboundLogins" type="checkbox">
              </label>
            </div>

            <div class="directory-admin__footer">
              <button class="directory-admin__button" type="button" :disabled="busy || !canSaveIntegration" @click="void saveIntegration()">
                {{ isCreating ? '创建集成' : '保存集成' }}
              </button>
              <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="resetDraft()">
                重置
              </button>
            </div>
          </section>

          <section class="directory-admin__section">
            <div class="directory-admin__section-head">
              <h2>同步运行</h2>
              <span>{{ runs.length }} 次</span>
            </div>
            <div v-if="runs.length === 0" class="directory-admin__empty">暂无同步运行记录</div>
            <article v-for="run in runs" :key="run.id" class="directory-admin__run">
              <div class="directory-admin__run-head">
                <strong>{{ run.statusLabel }}</strong>
                <span>{{ run.startedAt || '未知开始时间' }}</span>
              </div>
              <div class="directory-admin__run-meta">
                <span>完成：{{ run.finishedAt || '未完成' }}</span>
                <span>部门：{{ run.departmentsFetched ?? 0 }}</span>
                <span>成员：{{ run.accountsFetched ?? 0 }}</span>
                <span>匹配：{{ run.linksMatched ?? 0 }}</span>
                <span>冲突：{{ run.linksConflicted ?? 0 }}</span>
                <span>失活：{{ run.accountsDeactivated ?? 0 }}</span>
              </div>
              <p v-if="run.errorMessage" class="directory-admin__run-error">{{ run.errorMessage }}</p>
              <div v-if="run.permissionHint" class="directory-admin__remediation directory-admin__remediation--inline">
                <p v-if="run.permissionHint.requiredScopes.length > 0">缺少权限：{{ run.permissionHint.requiredScopes.join('、') }}</p>
                <a v-if="run.permissionHint.applyUrl" class="directory-admin__remediation-link" :href="run.permissionHint.applyUrl" target="_blank" rel="noreferrer">
                  前往申请权限
                </a>
              </div>
            </article>
          </section>

          <section v-if="directoryScheduleStatus || directorySyncAlerts.length > 0" class="directory-admin__section">
            <div class="directory-admin__section-head">
              <div>
                <h2>计划同步与告警</h2>
                <p class="directory-admin__hint">展示下次执行时间、最近运行状态和需要管理员确认的同步失败告警。</p>
              </div>
              <span>{{ directorySyncAlerts.length }} 条</span>
            </div>
            <div v-if="directoryScheduleStatus" class="directory-admin__run">
              <div class="directory-admin__run-head">
                <strong>{{ directoryScheduleStatus.syncEnabled ? '已启用定时同步' : '未启用定时同步' }}</strong>
                <span>{{ directoryScheduleStatus.nextRunAt || directoryScheduleStatus.scheduleCron || '未设置 Cron' }}</span>
              </div>
              <div class="directory-admin__run-meta">
                <span>最近状态：{{ directoryScheduleStatus.lastRunStatus ? statusLabel(directoryScheduleStatus.lastRunStatus) : '暂无' }}</span>
                <span>最近成功：{{ directoryScheduleStatus.lastSuccessAt || '-' }}</span>
                <span>最近告警：{{ directoryScheduleStatus.lastAlertAt || '-' }}</span>
                <span>未确认：{{ directoryScheduleStatus.unacknowledgedAlertCount }}</span>
              </div>
              <p v-if="directoryScheduleStatus.lastError" class="directory-admin__run-error">
                {{ directoryScheduleStatus.lastError }}
              </p>
            </div>
            <div v-if="directorySyncAlerts.length === 0" class="directory-admin__empty">当前没有目录同步告警</div>
            <article v-for="alert in directorySyncAlerts" :key="alert.id" class="directory-admin__run">
              <div class="directory-admin__run-head">
                <strong>{{ alert.level === 'error' ? '同步失败告警' : alert.level }}</strong>
                <span>{{ alert.createdAt || '-' }}</span>
              </div>
              <div class="directory-admin__run-meta">
                <span>代码：{{ alert.code || '-' }}</span>
                <span>来源：{{ readString(alert.details, ['source'], '-') }}</span>
                <span>Webhook：{{ alert.sentToWebhook ? '已发送' : '未发送' }}</span>
                <span>状态：{{ alert.acknowledgedAt ? `已确认 ${alert.acknowledgedAt}` : '待确认' }}</span>
              </div>
              <p class="directory-admin__run-error">{{ alert.message }}</p>
              <div class="directory-admin__batch-row">
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || !!alert.acknowledgedAt"
                  @click="void acknowledgeDirectorySyncAlert(alert.id)"
                >
                  {{ alert.acknowledgedAt ? '已确认' : '确认告警' }}
                </button>
              </div>
            </article>
          </section>

          <section class="directory-admin__section">
            <div class="directory-admin__section-head">
              <div>
                <h2>目录操作历史</h2>
                <p class="directory-admin__hint">在当前目录上下文里回查同步、审核、授权、模板和告警动作，不需要跳去通用审计页。</p>
              </div>
              <span>{{ directoryActivitySummary.total }} 条</span>
            </div>

            <div class="directory-admin__filter-row directory-admin__filter-row--wrap">
              <input
                v-model.trim="directoryActivitySearch"
                class="directory-admin__input directory-admin__input--compact"
                type="search"
                placeholder="搜索操作、对象、操作人"
                @input="handleDirectoryActivityFilterChange"
              >
              <select
                v-model="directoryActivityActionFilter"
                class="directory-admin__input directory-admin__input--compact"
                @change="handleDirectoryActivityFilterChange"
              >
                <option value="">全部动作</option>
                <option v-for="option in directoryActivityActionOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <select
                v-model="directoryActivityResourceTypeFilter"
                class="directory-admin__input directory-admin__input--compact"
                @change="handleDirectoryActivityFilterChange"
              >
                <option value="">全部资源</option>
                <option v-for="option in directoryActivityResourceTypeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <input
                v-model="directoryActivityFromDate"
                class="directory-admin__input directory-admin__input--compact"
                type="date"
                @change="handleDirectoryActivityFilterChange"
              >
              <input
                v-model="directoryActivityToDate"
                class="directory-admin__input directory-admin__input--compact"
                type="date"
                @change="handleDirectoryActivityFilterChange"
              >
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="busy || !selectedAccount"
                @click="toggleSelectedAccountActivityFilter"
              >
                {{ directoryActivityScopeFilter === 'selected-account' ? '恢复全部成员历史' : `仅看当前成员：${selectedAccount ? accountDisplayName(selectedAccount) : ''}` }}
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="directoryActivityLoading || !selectedIntegrationId"
                @click="void loadDirectoryActivity(selectedIntegrationId)"
              >
                {{ directoryActivityLoading ? '加载中...' : '刷新历史' }}
              </button>
              <button
                class="directory-admin__button directory-admin__button--secondary"
                type="button"
                :disabled="exportingDirectoryActivity || !selectedIntegrationId"
                @click="void exportDirectoryActivityCsv()"
              >
                {{ exportingDirectoryActivity ? '导出中...' : '导出历史 CSV' }}
              </button>
            </div>

            <div class="directory-admin__chip-row">
              <span class="directory-admin__chip">总计 {{ directoryActivitySummary.total }}</span>
              <span class="directory-admin__chip">集成 {{ directoryActivitySummary.integrationActions }}</span>
              <span class="directory-admin__chip">成员 {{ directoryActivitySummary.accountActions }}</span>
              <span class="directory-admin__chip">同步 {{ directoryActivitySummary.syncActions }}</span>
              <span class="directory-admin__chip">告警 {{ directoryActivitySummary.alertActions }}</span>
              <span class="directory-admin__chip">模板 {{ directoryActivitySummary.templateActions }}</span>
            </div>
            <p v-if="directoryActivityScopeFilter === 'selected-account' && selectedAccount" class="directory-admin__hint">
              当前仅显示成员“{{ accountDisplayName(selectedAccount) }}”相关的目录操作历史。
            </p>

            <div v-if="directoryActivityLoading" class="directory-admin__empty">目录操作历史加载中...</div>
            <div v-else-if="directoryActivityItems.length === 0" class="directory-admin__empty">当前筛选条件下暂无目录操作历史</div>
            <article v-for="item in directoryActivityItems" :key="item.id" class="directory-admin__run directory-admin__activity">
              <div class="directory-admin__run-head">
                <strong>{{ directoryActivityActionLabel(item.action) }}</strong>
                <span>{{ item.createdAt || '-' }}</span>
              </div>
              <div class="directory-admin__run-meta">
                <span>资源：{{ directoryActivityResourceTypeLabel(item.resourceType) }}</span>
                <span>对象：{{ directoryActivitySubjectLabel(item) }}</span>
                <span>操作人：{{ directoryActivityActorLabel(item) }}</span>
                <span v-if="item.errorCode">错误：{{ item.errorCode }}</span>
              </div>
              <p class="directory-admin__hint directory-admin__activity-summary">{{ summarizeDirectoryActivity(item) }}</p>
            </article>

            <div class="directory-admin__pager">
              <div>第 {{ directoryActivityPage }} / {{ directoryActivityTotalPages }} 页 · 共 {{ directoryActivityTotal }} 条</div>
              <div class="directory-admin__pager-actions">
                <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !directoryActivityHasPreviousPage" @click="prevDirectoryActivityPage">
                  上一页
                </button>
                <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !directoryActivityHasNextPage" @click="nextDirectoryActivityPage">
                  下一页
                </button>
              </div>
            </div>
          </section>

          <section class="directory-admin__section">
            <div class="directory-admin__section-head">
              <div>
                <h2>成员目录</h2>
                <p class="directory-admin__hint">支持筛选、详情查看、开通本地账号、授权钉钉登录与离职策略覆盖。</p>
              </div>
              <div class="directory-admin__filter-row directory-admin__filter-row--wrap">
                <input
                  v-model.trim="accountSearch"
                  class="directory-admin__input directory-admin__input--compact"
                  type="search"
                  placeholder="搜索姓名、邮箱、手机号、部门"
                  @input="handleAccountFilterChange"
                >
                <select v-model="accountStatusFilter" class="directory-admin__input directory-admin__input--compact" @change="handleAccountFilterChange">
                  <option value="all">全部状态</option>
                  <option value="linked">已绑定</option>
                  <option value="pending">待审核</option>
                  <option value="conflict">冲突</option>
                  <option value="ignored">已忽略</option>
                  <option value="inactive">目录失活</option>
                </select>
                <select v-model="accountMatchStrategyFilter" class="directory-admin__input directory-admin__input--compact" @change="handleAccountFilterChange">
                  <option value="">全部匹配方式</option>
                  <option value="external_identity">外部身份</option>
                  <option value="email_exact">邮箱匹配</option>
                  <option value="mobile_exact">手机号匹配</option>
                  <option value="manual">手动</option>
                </select>
                <select v-model="accountDingtalkAuthFilter" class="directory-admin__input directory-admin__input--compact" @change="handleAccountFilterChange">
                  <option value="all">钉钉认证（全部）</option>
                  <option value="enabled">已授权</option>
                  <option value="disabled">未授权</option>
                </select>
                <select v-model="accountBindingFilter" class="directory-admin__input directory-admin__input--compact" @change="handleAccountFilterChange">
                  <option value="all">绑定状态（全部）</option>
                  <option value="bound">已绑定</option>
                  <option value="unbound">未绑定</option>
                </select>
                <select v-model="accountDepartmentFilter" class="directory-admin__input directory-admin__input--compact" @change="handleAccountFilterChange">
                  <option value="">全部部门</option>
                  <option v-for="department in departments" :key="department.id" :value="department.externalDepartmentId">
                    {{ department.name }}
                  </option>
                </select>
                <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="exportingAccounts || !selectedIntegrationId" @click="void exportAccountsCsv()">
                  {{ exportingAccounts ? '导出中...' : '导出 CSV' }}
                </button>
              </div>
            </div>

            <div class="directory-admin__quick-bar">
              <div class="directory-admin__preset-row">
                <button
                  class="directory-admin__preset"
                  :class="{ 'directory-admin__preset--active': activeQuickFilter === 'all' }"
                  type="button"
                  @click="applyQuickFilter('all')"
                >
                  全部成员（{{ accountSummary.total }}）
                </button>
                <button
                  class="directory-admin__preset"
                  :class="{ 'directory-admin__preset--active': activeQuickFilter === 'pending' }"
                  type="button"
                  @click="applyQuickFilter('pending')"
                >
                  仅看待审核（{{ accountSummary.pending }}）
                </button>
                <button
                  class="directory-admin__preset"
                  :class="{ 'directory-admin__preset--active': activeQuickFilter === 'bound' }"
                  type="button"
                  @click="applyQuickFilter('bound')"
                >
                  仅看已绑定（{{ accountSummary.bound }}）
                </button>
                <button
                  class="directory-admin__preset"
                  :class="{ 'directory-admin__preset--active': activeQuickFilter === 'dingtalk-disabled' }"
                  type="button"
                  @click="applyQuickFilter('dingtalk-disabled')"
                >
                  仅看未授权钉钉（{{ accountSummary.dingtalkAuthDisabled }}）
                </button>
              </div>

              <div class="directory-admin__batch-row">
                <label class="directory-admin__selection-toggle">
                  <input
                    type="checkbox"
                    :checked="allVisibleAccountsSelected"
                    :disabled="filteredAccounts.length === 0 || busy"
                    @change="toggleSelectAllVisible(eventChecked($event))"
                  >
                  <span>全选当前页</span>
                </label>
                <span class="directory-admin__hint">已选 {{ selectedAccounts.length }} 项，仅处理当前页已加载成员。</span>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || selectedAccounts.length === 0"
                  @click="clearSelectedAccounts()"
                >
                  清空选择
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchProvisionEligible.length === 0"
                  @click="void batchProvisionUsers(false)"
                >
                  批量开通账号（{{ batchProvisionEligible.length }}）
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchProvisionEligible.length === 0"
                  @click="void batchProvisionUsers(true)"
                >
                  批量开通并授权（{{ batchProvisionEligible.length }}）
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchAutoLinkByEmailEligible.length === 0"
                  @click="void batchAutoLinkByEmail()"
                >
                  按邮箱批量关联（{{ batchAutoLinkByEmailEligible.length }}）
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchAuthorizeEligible.length === 0"
                  @click="void batchAuthorizeDingtalk(true)"
                >
                  批量授权钉钉（{{ batchAuthorizeEligible.length }}）
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchRevokeEligible.length === 0"
                  @click="void batchAuthorizeDingtalk(false)"
                >
                  批量取消授权（{{ batchRevokeEligible.length }}）
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchIgnoreEligible.length === 0"
                  @click="void batchIgnoreAccounts()"
                >
                  批量忽略（{{ batchIgnoreEligible.length }}）
                </button>
                <button
                  class="directory-admin__button directory-admin__button--secondary"
                  type="button"
                  :disabled="busy || batchUnlinkEligible.length === 0"
                  @click="void batchUnlinkAccounts()"
                >
                  批量解除绑定（{{ batchUnlinkEligible.length }}）
                </button>
              </div>

              <section
                v-if="latestBatchResult"
                class="directory-admin__batch-result"
                :class="{
                  'directory-admin__batch-result--error': latestBatchResult.failureCount > 0,
                  'directory-admin__batch-result--success': latestBatchResult.failureCount === 0,
                }"
              >
                <div class="directory-admin__batch-result-head">
                  <div>
                    <strong>本次批量处理结果</strong>
                    <p>{{ latestBatchResult.label }} · {{ latestBatchResult.completedAt }}</p>
                  </div>
                  <div class="directory-admin__batch-result-actions">
                    <button
                      v-if="latestBatchResult.failures.length > 0"
                      class="directory-admin__button directory-admin__button--secondary"
                      type="button"
                      :disabled="busy"
                      @click="toggleBatchFailureFilter()"
                    >
                      {{ batchFailureFilterActive ? '恢复全部成员' : `仅看失败成员（${visibleBatchFailureCount}）` }}
                    </button>
                    <button
                      v-if="latestBatchResult.failures.length > 0"
                      class="directory-admin__button directory-admin__button--secondary"
                      type="button"
                      :disabled="busy"
                      @click="void copyBatchFailures()"
                    >
                      复制失败清单
                    </button>
                    <button
                      v-if="latestBatchResult.failures.length > 0"
                      class="directory-admin__button directory-admin__button--secondary"
                      type="button"
                      :disabled="busy"
                      @click="exportBatchFailuresCsv()"
                    >
                      导出失败 CSV
                    </button>
                    <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="clearBatchResult()">
                      收起
                    </button>
                  </div>
                </div>
                <p class="directory-admin__batch-result-summary">
                  共 {{ latestBatchResult.total }} 项，成功 {{ latestBatchResult.successCount }} 项，失败 {{ latestBatchResult.failureCount }} 项
                </p>
                <p v-if="batchFailureFilterActive && !activeBatchFailureReasonGroup" class="directory-admin__hint">
                  当前仅显示本次批量失败成员，便于立即重试处理。
                </p>
                <p v-if="activeBatchFailureReasonGroup" class="directory-admin__hint">
                  当前仅显示失败原因“{{ activeBatchFailureReasonGroup.message }}”的成员；再次点击该摘要可恢复全部失败成员。
                </p>
                <div v-if="batchFailureReasonGroups.length > 0" class="directory-admin__batch-failure-groups">
                  <strong>失败原因摘要</strong>
                  <ul class="directory-admin__batch-failure-group-list">
                    <li v-for="group in batchFailureReasonGroups" :key="group.message">
                      <button
                        class="directory-admin__batch-failure-group-button"
                        :class="{ 'directory-admin__batch-failure-group-button--active': batchFailureReasonFilter === group.message }"
                        type="button"
                        :disabled="busy"
                        @click="toggleBatchFailureReasonFilter(group.message)"
                      >
                        <div class="directory-admin__batch-failure-group-copy">
                          <span>{{ group.message }}</span>
                          <small>
                            {{ group.recommendations.length > 0 ? `建议：${group.recommendations.map((label) => label.replace(/^推荐：/, '')).join(' / ')}` : '建议：人工处理' }}
                          </small>
                        </div>
                        <strong>{{ group.count }} 项</strong>
                      </button>
                    </li>
                  </ul>
                </div>
                <div v-if="batchRecommendationGroups.length > 0" class="directory-admin__batch-recommendations">
                  <strong>{{ batchRecommendationTitle }}</strong>
                  <div class="directory-admin__batch-row">
                    <button
                      v-for="recommendation in batchRecommendationGroups"
                      :key="recommendation.key"
                      class="directory-admin__button directory-admin__button--secondary"
                      type="button"
                      :disabled="busy"
                      @click="void runBatchRecommendation(recommendation.key)"
                    >
                      {{ recommendation.label }}（{{ recommendation.accounts.length }}）
                    </button>
                  </div>
                  <p class="directory-admin__hint">
                    {{ batchRecommendationSummary }}
                  </p>
                </div>
                <p v-else-if="activeBatchFailureReasonGroup" class="directory-admin__hint">
                  当前失败原因“{{ activeBatchFailureReasonGroup.message }}”暂无可直接推荐的批量动作，请查看失败明细人工处理。
                </p>
                <div v-if="activeBatchFailureReasonGroup" class="directory-admin__batch-note">
                  <div class="directory-admin__batch-note-head">
                    <div>
                      <strong>人工处理备注模板</strong>
                      <p class="directory-admin__hint">可直接复制给管理员、客服或运营继续跟进。</p>
                    </div>
                    <div class="directory-admin__batch-row">
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy"
                        @click="void copyActiveBatchFailureReasonFailures()"
                      >
                        复制该类失败
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy"
                        @click="exportActiveBatchFailureReasonFailuresCsv()"
                      >
                        导出该类 CSV
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy"
                        @click="void copyActiveBatchFailureReasonNote()"
                      >
                        复制处理备注
                      </button>
                    </div>
                  </div>
                  <div class="directory-admin__batch-note-presets">
                    <div class="directory-admin__preset-row">
                      <button
                        v-for="preset in batchFailureReasonNotePresets"
                        :key="preset.key"
                        class="directory-admin__preset"
                        :class="{ 'directory-admin__preset--active': activeBatchFailureReasonNotePreset === preset.key }"
                        type="button"
                        :disabled="busy"
                        @click="selectBatchFailureReasonNotePreset(preset.key)"
                      >
                        {{ preset.label }}
                      </button>
                    </div>
                    <p class="directory-admin__hint">
                      当前模板：{{ activeBatchFailureReasonNotePresetOption.label }}。{{ activeBatchFailureReasonNotePresetOption.description }}
                    </p>
                    <p class="directory-admin__hint">
                      默认推荐：{{ recommendedBatchFailureReasonNotePreset.label }}
                    </p>
                  </div>
                  <div class="directory-admin__batch-note-output">
                    <div class="directory-admin__preset-row">
                      <button
                        v-for="output in batchFailureReasonNoteOutputModes"
                        :key="output.key"
                        class="directory-admin__preset"
                        :class="{ 'directory-admin__preset--active': activeBatchFailureReasonNoteOutputMode === output.key }"
                        type="button"
                        :disabled="busy"
                        @click="selectBatchFailureReasonNoteOutputMode(output.key)"
                      >
                        {{ output.label }}
                      </button>
                    </div>
                    <p class="directory-admin__hint">
                      当前输出：{{ activeBatchFailureReasonNoteOutputModeOption.label }}。{{ activeBatchFailureReasonNoteOutputModeOption.description }}
                    </p>
                    <p v-if="activeStoredBatchFailureReasonNotePreference" class="directory-admin__hint">
                      已记住上次偏好：{{ activeStoredBatchFailureReasonNoteSummary }}
                    </p>
                    <p v-else class="directory-admin__hint">
                      当前输出还没有已记住的上次偏好，新失败原因会先沿用推荐字段。
                    </p>
                  </div>
                  <div class="directory-admin__batch-note-handling-groups">
                    <div class="directory-admin__preset-row">
                      <button
                        v-for="group in batchFailureReasonHandlingGroups"
                        :key="group.key"
                        class="directory-admin__preset"
                        :class="{ 'directory-admin__preset--active': activeBatchFailureReasonHandlingGroupKey === group.key }"
                        type="button"
                        :disabled="busy"
                        @click="selectBatchFailureReasonHandlingGroup(group.key)"
                      >
                        {{ group.label }}
                      </button>
                    </div>
                    <p class="directory-admin__hint">
                      当前处理组：{{ activeBatchFailureReasonHandlingGroupOption.label }}。{{ activeBatchFailureReasonHandlingGroupOption.description }}
                    </p>
                    <p class="directory-admin__hint">
                      只改处理分工与补充语组合，不改当前输出格式。
                    </p>
                  </div>
                  <div class="directory-admin__batch-note-standards">
                    <div class="directory-admin__batch-row">
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy"
                        @click="saveActiveBatchFailureReasonTeamTemplate()"
                      >
                        保存为团队标准
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !activeBatchFailureReasonTeamTemplate"
                        @click="applyActiveBatchFailureReasonTeamTemplate()"
                      >
                        应用团队标准
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !activeBatchFailureReasonTeamTemplate"
                        @click="void copyActiveBatchFailureReasonTeamTemplate()"
                      >
                        复制团队模板
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !activeBatchFailureReasonTeamTemplate"
                        @click="void copyActiveBatchFailureReasonTeamTemplateCode()"
                      >
                        复制模板码
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy"
                        @click="toggleBatchFailureReasonTeamTemplateImport()"
                      >
                        {{ showBatchFailureReasonTeamTemplateImport ? '收起导入区' : '导入模板码' }}
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !activeBatchFailureReasonTeamTemplate"
                        @click="clearActiveBatchFailureReasonTeamTemplate()"
                      >
                        清空团队标准
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || directoryTemplateCenterLoading"
                        @click="void refreshDirectoryTemplateCenterFromServer()"
                      >
                        {{ directoryTemplateCenterLoading ? '刷新中...' : '从服务端刷新' }}
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="exportingAccounts || !directoryTemplateGovernanceReport"
                        @click="void exportDirectoryTemplateGovernanceCsv()"
                      >
                        导出治理 CSV
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !directoryTemplateGovernanceReport"
                        @click="void copyDirectoryTemplateGovernanceJson()"
                      >
                        复制治理 JSON
                      </button>
                    </div>
                    <p v-if="activeBatchFailureReasonTeamTemplate" class="directory-admin__hint">
                      团队标准模板：{{ activeBatchFailureReasonTeamTemplateSummary }}
                    </p>
                    <p v-else class="directory-admin__hint">
                      当前输出还没有团队标准模板；保存后可作为稳定快照反复应用，不会被临时编辑自动覆盖。
                    </p>
                    <p v-if="directoryTemplateCenterSyncSummary" class="directory-admin__hint">
                      {{ directoryTemplateCenterSyncSummary }}
                    </p>
                    <p v-if="directoryTemplateCenterLastSavedAt" class="directory-admin__hint">
                      最近一次浏览器同步：{{ directoryTemplateCenterLastSavedAt }}
                    </p>
                    <p v-if="directoryTemplateGovernanceReport" class="directory-admin__hint">
                      治理摘要：团队标准 {{ directoryTemplateGovernanceReport.totals.teamTemplates }} · 预设 {{ directoryTemplateGovernanceReport.totals.importPresets }} · 收藏 {{ directoryTemplateGovernanceReport.totals.favorites }} · 置顶 {{ directoryTemplateGovernanceReport.totals.pinned }}
                    </p>
                    <p v-if="directoryTemplateGovernanceTagSummary" class="directory-admin__hint">
                      高频标签：{{ directoryTemplateGovernanceTagSummary }}
                    </p>
                    <div v-if="showBatchFailureReasonTeamTemplateImport" class="directory-admin__batch-note-import">
                      <label class="directory-admin__field">
                        <span>团队模板码</span>
                        <textarea
                          v-model="batchFailureReasonTeamTemplateCodeInput"
                          class="directory-admin__input directory-admin__input--textarea"
                          rows="3"
                          placeholder="粘贴通过“复制模板码”生成的内容，或直接粘贴合法 JSON。"
                        />
                      </label>
                      <div class="directory-admin__batch-row">
                        <button
                          class="directory-admin__button directory-admin__button--secondary"
                          type="button"
                          :disabled="busy || batchFailureReasonTeamTemplateCodeInput.trim().length === 0"
                          @click="importBatchFailureReasonTeamTemplateCode()"
                        >
                          确认导入
                        </button>
                        <button
                          class="directory-admin__button directory-admin__button--secondary"
                          type="button"
                          :disabled="busy || batchFailureReasonTeamTemplateCodeInput.trim().length === 0"
                          @click="batchFailureReasonTeamTemplateCodeInput = ''"
                        >
                          清空输入
                        </button>
                      </div>
                      <p class="directory-admin__hint">
                        导入支持版本化模板码，当前会按模板码里的输出格式落库；若与当前输出一致，会立即应用到当前失败原因。
                      </p>
                      <p v-if="batchFailureReasonTeamTemplateImportPreview" class="directory-admin__hint">
                        {{ batchFailureReasonTeamTemplateImportPreviewText(batchFailureReasonTeamTemplateImportPreview) }}
                      </p>
                      <div
                        v-if="batchFailureReasonTeamTemplateImportPreview"
                        class="directory-admin__batch-note-diff"
                      >
                        <p class="directory-admin__hint">
                          导入差异：{{ batchFailureReasonTeamTemplateImportDiffSummary }}
                        </p>
                        <p
                          v-if="batchFailureReasonTeamTemplateIgnoredFieldLabels.length > 0"
                          class="directory-admin__hint"
                        >
                          当前忽略：{{ batchFailureReasonTeamTemplateIgnoredFieldLabels.join(' / ') }}
                        </p>
                        <p
                          v-if="activeBatchFailureReasonTeamTemplateImportPreset"
                          class="directory-admin__hint"
                        >
                          当前选中预设（{{ batchFailureReasonNoteOutputModeLabel(activeBatchFailureReasonTeamTemplateImportPresetOutputMode) }}）：
                          {{ activeBatchFailureReasonTeamTemplateImportPreset.name }}
                          ·
                          {{ activeBatchFailureReasonTeamTemplateImportPresetLabels.join(' / ') || '不忽略任何字段' }}
                        </p>
                        <p
                          v-if="activeBatchFailureReasonTeamTemplateImportPresetStateLabels.length > 0"
                          class="directory-admin__hint"
                        >
                          当前选中状态：{{ activeBatchFailureReasonTeamTemplateImportPresetStateLabels.join(' / ') }}
                        </p>
                        <p
                          v-if="activeBatchFailureReasonTeamTemplateImportPresetUsageSummary"
                          class="directory-admin__hint"
                        >
                          当前选中统计：{{ activeBatchFailureReasonTeamTemplateImportPresetUsageSummary }}
                        </p>
                        <p
                          v-if="activeBatchFailureReasonTeamTemplateImportPresetTagLabels.length > 0"
                          class="directory-admin__hint"
                        >
                          当前选中标签：{{ activeBatchFailureReasonTeamTemplateImportPresetTagLabels.join(' / ') }}
                        </p>
                        <div class="directory-admin__preset-row">
                          <button
                            v-for="preset in batchFailureReasonTeamTemplateImportPresetOptions"
                            :key="preset.key"
                            class="directory-admin__preset"
                            :class="{ 'directory-admin__preset--active': isActiveBatchFailureReasonTeamTemplateImportPresetOption(preset.key) }"
                            type="button"
                            :disabled="busy"
                            @click="applyBatchFailureReasonTeamTemplateImportPreset(preset.key)"
                          >
                            {{ preset.label }}
                          </button>
                        </div>
                        <div
                          v-if="activeBatchFailureReasonTeamTemplateImportPresetList.length > 0"
                          class="directory-admin__batch-note-import-presets"
                        >
                          <div class="directory-admin__batch-row">
                            <button
                              class="directory-admin__button directory-admin__button--secondary"
                              type="button"
                              :disabled="busy"
                              @click="toggleBatchFailureReasonTeamTemplateImportPresetRecentOrderLock()"
                            >
                              {{ batchFailureReasonTeamTemplateImportPresetPreference.lockRecentUsageOrder ? '解除排序锁定' : '锁定最近使用排序' }}
                            </button>
                            <button
                              class="directory-admin__button directory-admin__button--secondary"
                              type="button"
                              :disabled="busy || lowFrequencyBatchFailureReasonTeamTemplateImportPresets.length === 0"
                              @click="clearLowFrequencyBatchFailureReasonTeamTemplateImportPresets()"
                            >
                              清理低频预设（{{ lowFrequencyBatchFailureReasonTeamTemplateImportPresets.length }}）
                            </button>
                          </div>
                          <p class="directory-admin__hint">
                            排序规则：置顶优先，其次收藏；{{ batchFailureReasonTeamTemplateImportPresetPreference.lockRecentUsageOrder ? '当前已锁定最近使用排序' : '当前按最近使用刷新排序' }}。
                          </p>
                          <p class="directory-admin__hint">
                            当前范围低频预设：{{ lowFrequencyBatchFailureReasonTeamTemplateImportPresets.length }} 项
                            （使用次数 ≤ 1，且未收藏、未置顶）
                          </p>
                          <label class="directory-admin__field">
                            <span>搜索预设</span>
                            <input
                              v-model.trim="batchFailureReasonTeamTemplateImportPresetSearch"
                              class="directory-admin__input"
                              type="text"
                              placeholder="按预设名称或标签筛选"
                            >
                          </label>
                          <div
                            v-if="batchFailureReasonTeamTemplateImportPresetAvailableTags.length > 0"
                            class="directory-admin__preset-row"
                          >
                            <button
                              class="directory-admin__preset"
                              :class="{ 'directory-admin__preset--active': !selectedBatchFailureReasonTeamTemplateImportPresetTag }"
                              type="button"
                              :disabled="busy"
                              @click="selectedBatchFailureReasonTeamTemplateImportPresetTag = ''"
                            >
                              全部标签
                            </button>
                            <button
                              v-for="tag in batchFailureReasonTeamTemplateImportPresetAvailableTags"
                              :key="tag"
                              class="directory-admin__preset"
                              :class="{ 'directory-admin__preset--active': selectedBatchFailureReasonTeamTemplateImportPresetTag === tag }"
                              type="button"
                              :disabled="busy"
                              @click="selectedBatchFailureReasonTeamTemplateImportPresetTag = tag"
                            >
                              {{ tag }}
                            </button>
                          </div>
                          <p
                            v-if="groupedBatchFailureReasonTeamTemplateImportPresets.length === 0"
                            class="directory-admin__hint"
                          >
                            当前搜索与标签条件下没有匹配的导入预设。
                          </p>
                          <div
                            v-for="group in groupedBatchFailureReasonTeamTemplateImportPresets"
                            :key="group.key"
                            class="directory-admin__batch-note-import-preset-group"
                          >
                            <p class="directory-admin__hint">标签组：{{ group.label }}（{{ group.presets.length }}）</p>
                            <div class="directory-admin__preset-row">
                              <button
                                v-for="preset in group.presets"
                                :key="preset.id"
                                class="directory-admin__preset"
                                :class="{ 'directory-admin__preset--active': activeBatchFailureReasonTeamTemplateImportPreset?.id === preset.id }"
                                type="button"
                                :disabled="busy"
                                @click="applySavedBatchFailureReasonTeamTemplateImportPreset(preset.id)"
                              >
                                {{ batchFailureReasonTeamTemplateImportPresetButtonLabel(preset) }}
                              </button>
                            </div>
                          </div>
                        </div>
                        <label class="directory-admin__field">
                          <span>预设名称</span>
                          <input
                            v-model.trim="batchFailureReasonTeamTemplateImportPresetName"
                            class="directory-admin__input"
                            type="text"
                            :placeholder="activeBatchFailureReasonTeamTemplateImportPreset?.name || '例如 保留本地渠道'"
                          >
                        </label>
                        <label class="directory-admin__field">
                          <span>预设标签</span>
                          <input
                            v-model.trim="batchFailureReasonTeamTemplateImportPresetTagsInput"
                            class="directory-admin__input"
                            type="text"
                            placeholder="例如 工单、财务、保留渠道"
                          >
                        </label>
                        <div class="directory-admin__batch-row">
                          <button
                            class="directory-admin__button directory-admin__button--secondary"
                            type="button"
                            :disabled="busy"
                            @click="saveBatchFailureReasonTeamTemplateImportPreset()"
                          >
                            保存为新预设
                          </button>
                          <button
                            class="directory-admin__button directory-admin__button--secondary"
                            type="button"
                            :disabled="busy || !activeBatchFailureReasonTeamTemplateImportPreset"
                            @click="overwriteBatchFailureReasonTeamTemplateImportPreset()"
                          >
                            覆盖当前预设
                          </button>
                          <button
                            class="directory-admin__button directory-admin__button--secondary"
                            type="button"
                            :disabled="busy || !activeBatchFailureReasonTeamTemplateImportPreset"
                            @click="removeBatchFailureReasonTeamTemplateImportPreset()"
                          >
                            删除当前预设
                          </button>
                          <button
                            class="directory-admin__button directory-admin__button--secondary"
                            type="button"
                            :disabled="busy || !activeBatchFailureReasonTeamTemplateImportPreset"
                            @click="toggleFavoriteBatchFailureReasonTeamTemplateImportPreset()"
                          >
                            {{ activeBatchFailureReasonTeamTemplateImportPreset?.favorite ? '取消收藏' : '收藏当前预设' }}
                          </button>
                          <button
                            class="directory-admin__button directory-admin__button--secondary"
                            type="button"
                            :disabled="busy || !activeBatchFailureReasonTeamTemplateImportPreset"
                            @click="togglePinBatchFailureReasonTeamTemplateImportPreset()"
                          >
                            {{ activeBatchFailureReasonTeamTemplateImportPreset?.pinned ? '取消置顶' : '置顶当前预设' }}
                          </button>
                        </div>
                        <ul
                          v-if="batchFailureReasonTeamTemplateImportDiffPreview.length > 0"
                          class="directory-admin__batch-note-diff-list"
                        >
                          <li
                            v-for="entry in batchFailureReasonTeamTemplateImportDiffPreview"
                            :key="entry.key"
                            class="directory-admin__batch-note-diff-item"
                            :class="[
                              `directory-admin__batch-note-diff-item--${entry.mode}`,
                              { 'directory-admin__batch-note-diff-item--ignored': isBatchFailureReasonTeamTemplateFieldIgnored(entry.key) },
                            ]"
                          >
                            <strong>{{ entry.label }}</strong>
                            <span>{{ entry.before }}</span>
                            <span aria-hidden="true">→</span>
                            <strong>{{ entry.after }}</strong>
                            <button
                              class="directory-admin__button directory-admin__button--secondary"
                              type="button"
                              :disabled="busy || !canIgnoreBatchFailureReasonTeamTemplateField(batchFailureReasonTeamTemplates[batchFailureReasonTeamTemplateImportPreview.outputMode] || null, entry.key)"
                              @click="toggleBatchFailureReasonTeamTemplateIgnoredField(entry.key)"
                            >
                              {{ isBatchFailureReasonTeamTemplateFieldIgnored(entry.key) ? '恢复导入' : '忽略该字段' }}
                            </button>
                          </li>
                        </ul>
                      </div>
                    </div>
                    <div
                      v-if="recentBatchFailureReasonTeamTemplateImports.length > 0"
                      class="directory-admin__batch-history directory-admin__batch-note-import-history"
                    >
                      <div class="directory-admin__batch-history-head">
                        <strong>最近模板码导入</strong>
                        <small>保留最近 5 条，可直接重新应用或回滚到导入前模板。</small>
                      </div>
                      <div class="directory-admin__batch-history-list">
                        <div
                          v-for="item in recentBatchFailureReasonTeamTemplateImports"
                          :key="item.id"
                          class="directory-admin__batch-history-item directory-admin__batch-history-item--import"
                          :class="{
                            'directory-admin__batch-history-item--active': item.outputMode === activeBatchFailureReasonNoteOutputMode,
                          }"
                        >
                          <div class="directory-admin__batch-history-item-head">
                            <strong>{{ batchFailureReasonNoteOutputModeLabel(item.outputMode) }}</strong>
                            <span v-if="item.rolledBackAt" class="directory-admin__batch-history-badge">
                              已回滚
                            </span>
                          </div>
                          <small>
                            来源：{{ batchFailureReasonTeamTemplateImportSourceLabel(item.source) }} ·
                            {{ item.appliedImmediately ? '导入后已应用' : '仅保存到该输出' }}
                          </small>
                          <small>导入时间：{{ item.importedAt || '-' }}</small>
                          <small>{{ summarizeBatchFailureReasonTeamTemplate(item.importedTemplate) }}</small>
                          <small>
                            差异：{{ buildBatchFailureReasonTeamTemplateDiffSummary(item.previousTemplate, item.importedTemplate, item.ignoredFieldKeys) }}
                          </small>
                          <small v-if="item.ignoredFieldKeys.length > 0">
                            已忽略：{{ item.ignoredFieldKeys.map((key) => batchFailureReasonTeamTemplateFieldLabel(key)).join(' / ') }}
                          </small>
                          <ul
                            v-if="buildBatchFailureReasonTeamTemplateDiffEntries(item.previousTemplate, item.importedTemplate).length > 0"
                            class="directory-admin__batch-note-diff-list directory-admin__batch-note-diff-list--history"
                          >
                            <li
                              v-for="entry in buildBatchFailureReasonTeamTemplateDiffEntries(item.previousTemplate, item.importedTemplate)"
                              :key="`${item.id}-${entry.key}`"
                              class="directory-admin__batch-note-diff-item"
                              :class="`directory-admin__batch-note-diff-item--${entry.mode}`"
                            >
                              <strong>{{ entry.label }}</strong>
                              <span>{{ entry.before }}</span>
                              <span aria-hidden="true">→</span>
                              <strong>{{ entry.after }}</strong>
                            </li>
                          </ul>
                          <small v-if="item.previousTemplate">
                            导入前：{{ summarizeBatchFailureReasonTeamTemplate(item.previousTemplate) }}
                          </small>
                          <small v-else>
                            导入前：该输出还没有团队标准模板
                          </small>
                          <small v-if="item.rolledBackAt">
                            最近回滚：{{ item.rolledBackAt }}
                          </small>
                          <div class="directory-admin__batch-row directory-admin__batch-note-import-history-actions">
                            <button
                              class="directory-admin__button directory-admin__button--secondary"
                              type="button"
                              :disabled="busy"
                              @click="applyBatchFailureReasonTeamTemplateImportHistoryItem(item)"
                            >
                              应用此导入
                            </button>
                            <button
                              class="directory-admin__button directory-admin__button--secondary"
                              type="button"
                              :disabled="busy"
                              @click="rollbackBatchFailureReasonTeamTemplateImport(item)"
                            >
                              {{ item.previousTemplate ? '回滚到导入前模板' : '回滚并清空该输出模板' }}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div
                      v-if="directoryTemplateCenterVersions.length > 0"
                      class="directory-admin__batch-history directory-admin__batch-note-import-history"
                    >
                      <div class="directory-admin__batch-history-head">
                        <strong>服务端模板中心版本</strong>
                        <small>保留最近版本快照，可直接回滚到指定版本。</small>
                      </div>
                      <div class="directory-admin__batch-history-list">
                        <div
                          v-for="version in directoryTemplateCenterVersions"
                          :key="version.id"
                          class="directory-admin__batch-history-item directory-admin__batch-history-item--import"
                        >
                          <div class="directory-admin__batch-history-item-head">
                            <strong>{{ version.changeReason || 'manual_update' }}</strong>
                            <span class="directory-admin__batch-history-badge">
                              {{ version.snapshotSummary.importPresetCount }} 预设
                            </span>
                          </div>
                          <small>时间：{{ version.createdAt || '-' }} · 操作人：{{ version.createdBy || 'system' }}</small>
                          <small>
                            输出：{{ version.snapshotSummary.outputModes.join(' / ') || '无' }}
                            · 团队标准 {{ version.snapshotSummary.teamTemplateCount }}
                            · 导入历史 {{ version.snapshotSummary.importHistoryCount }}
                          </small>
                          <div class="directory-admin__batch-row directory-admin__batch-note-import-history-actions">
                            <button
                              class="directory-admin__button directory-admin__button--secondary"
                              type="button"
                              :disabled="busy"
                              @click="void restoreDirectoryTemplateCenterVersion(version.id)"
                            >
                              回滚到此版本
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="directory-admin__batch-note-fields">
                    <label class="directory-admin__field">
                      <span>处理负责人</span>
                      <input
                        v-model="batchFailureReasonNoteOwner"
                        class="directory-admin__input"
                        type="text"
                        placeholder="例如：值班管理员 / 张三"
                      >
                    </label>
                    <label class="directory-admin__field">
                      <span>截止时间</span>
                      <input
                        v-model="batchFailureReasonNoteDeadline"
                        class="directory-admin__input"
                        type="text"
                        placeholder="例如：今天 18:00 前"
                      >
                    </label>
                    <label class="directory-admin__field">
                      <span>同步渠道</span>
                      <input
                        v-model="batchFailureReasonNoteChannel"
                        class="directory-admin__input"
                        type="text"
                        placeholder="例如：钉钉群 / 工单 #123"
                      >
                    </label>
                  </div>
                  <label class="directory-admin__field">
                    <span>补充说明</span>
                    <textarea
                      v-model="batchFailureReasonNoteExtra"
                      class="directory-admin__input directory-admin__input--textarea"
                      rows="3"
                      placeholder="例如：处理完成后请通知用户重新扫码登录。"
                    />
                  </label>
                  <div class="directory-admin__batch-note-snippets">
                    <span>快捷补充语</span>
                    <div class="directory-admin__preset-row">
                      <button
                        v-for="snippet in batchFailureReasonNoteSnippets"
                        :key="snippet.key"
                        class="directory-admin__preset"
                        type="button"
                        :disabled="busy"
                        @click="appendBatchFailureReasonSnippet(snippet.key)"
                      >
                        {{ snippet.label }}
                      </button>
                    </div>
                    <div class="directory-admin__batch-row">
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy"
                        @click="restoreActiveBatchFailureReasonNoteContext()"
                      >
                        恢复推荐字段
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !activeStoredBatchFailureReasonNotePreference"
                        @click="restoreRememberedBatchFailureReasonNoteContext()"
                      >
                        恢复上次偏好
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || !hasActiveStoredBatchFailureReasonNoteSnippets"
                        @click="restoreRememberedBatchFailureReasonNoteSnippets()"
                      >
                        恢复上次补充语
                      </button>
                      <button
                        class="directory-admin__button directory-admin__button--secondary"
                        type="button"
                        :disabled="busy || activeBatchFailureReasonNoteContext.extra.length === 0"
                        @click="clearActiveBatchFailureReasonNoteExtra()"
                      >
                        清空补充说明
                      </button>
                    </div>
                    <p class="directory-admin__hint">
                      推荐负责人：{{ recommendedBatchFailureReasonNoteOwner || '未设置' }} · 推荐截止：{{ recommendedBatchFailureReasonNoteDeadline || '未设置' }} · 推荐渠道：{{ recommendedBatchFailureReasonNoteChannel || '未设置' }}
                    </p>
                    <p class="directory-admin__hint">
                      推荐补充：{{ recommendedBatchFailureReasonNoteExtra || '无' }}
                    </p>
                    <p v-if="hasActiveStoredBatchFailureReasonNoteSnippets" class="directory-admin__hint">
                      已记住快捷补充语：{{ activeStoredBatchFailureReasonNoteSnippetLabels.join(' / ') }}
                    </p>
                    <p class="directory-admin__hint">
                      这些字段会自动写入预览与复制内容；复制结果会跟随当前输出格式切换。
                    </p>
                  </div>
                  <pre class="directory-admin__batch-note-preview">{{ activeBatchFailureReasonNotePreview }}</pre>
                </div>
                <ul v-if="latestBatchResult.failures.length > 0" class="directory-admin__batch-result-list">
                  <li v-for="failure in latestBatchResult.failures" :key="`${failure.accountId}-${failure.message}`">
                    <strong>{{ failure.accountName }}</strong>
                    <span>{{ failure.message }}</span>
                  </li>
                </ul>
                <p v-else class="directory-admin__hint">全部处理成功，没有失败明细。</p>
              </section>

              <section v-if="batchResultHistory.length > 1" class="directory-admin__batch-history">
                <div class="directory-admin__batch-history-head">
                  <div>
                    <strong>最近批量处理记录</strong>
                    <span>{{ filteredBatchResultHistory.length }} / {{ batchResultHistory.length }} 条</span>
                  </div>
                  <div class="directory-admin__batch-history-controls">
                    <div class="directory-admin__preset-row">
                      <button
                        class="directory-admin__preset"
                        :class="{ 'directory-admin__preset--active': batchHistoryFilter === 'all' }"
                        type="button"
                        @click="batchHistoryFilter = 'all'"
                      >
                        全部
                      </button>
                      <button
                        class="directory-admin__preset"
                        :class="{ 'directory-admin__preset--active': batchHistoryFilter === 'failed' }"
                        type="button"
                        @click="batchHistoryFilter = 'failed'"
                      >
                        仅失败
                      </button>
                      <button
                        class="directory-admin__preset"
                        :class="{ 'directory-admin__preset--active': batchHistoryFilter === 'success' }"
                        type="button"
                        @click="batchHistoryFilter = 'success'"
                      >
                        仅成功
                      </button>
                    </div>
                    <button
                      class="directory-admin__button directory-admin__button--secondary"
                      type="button"
                      :disabled="busy"
                      @click="clearBatchHistory()"
                    >
                      清空历史
                    </button>
                  </div>
                </div>
                <div class="directory-admin__batch-history-list">
                  <button
                    v-for="result in filteredBatchResultHistory"
                    :key="`${result.label}-${result.completedAt}`"
                    class="directory-admin__batch-history-item"
                    :class="{
                      'directory-admin__batch-history-item--active': latestBatchResult?.completedAt === result.completedAt && latestBatchResult?.label === result.label,
                      'directory-admin__batch-history-item--failed': result.failureCount > 0,
                    }"
                    type="button"
                    @click="restoreBatchResult(result)"
                  >
                    <div class="directory-admin__batch-history-item-head">
                      <strong>{{ result.label }}</strong>
                      <span v-if="result.failureCount > 0" class="directory-admin__batch-history-badge">
                        失败 {{ result.failureCount }}
                      </span>
                    </div>
                    <span>{{ result.completedAt }}</span>
                    <small>成功 {{ result.successCount }} · 失败 {{ result.failureCount }}</small>
                  </button>
                </div>
              </section>
            </div>

            <div class="directory-admin__split">
              <div class="directory-admin__accounts">
                <div v-if="filteredAccounts.length === 0" class="directory-admin__empty">暂无成员数据</div>
                <article
                  v-for="account in filteredAccounts"
                  :key="account.id"
                  class="directory-admin__account-card"
                  :class="{ 'directory-admin__account-card--active': selectedAccountId === account.id }"
                >
                  <label class="directory-admin__selection-toggle directory-admin__selection-toggle--account">
                    <input
                      type="checkbox"
                      :checked="isAccountSelected(account.id)"
                      :disabled="busy"
                      @change="toggleSelectedAccount(account.id, eventChecked($event))"
                    >
                    <span>选择</span>
                  </label>
                  <button
                    class="directory-admin__account"
                    :class="{ 'directory-admin__account--active': selectedAccountId === account.id }"
                    type="button"
                    @click="void selectAccount(account)"
                  >
                    <div class="directory-admin__account-head">
                      <strong>{{ account.name || account.nick || account.externalUserId }}</strong>
                      <span>{{ account.email || account.mobile || '无邮箱' }}</span>
                    </div>
                    <div class="directory-admin__chip-row">
                      <span class="directory-admin__chip">{{ account.matchStatusLabel }}</span>
                      <span class="directory-admin__chip">{{ account.linkStatusLabel }}</span>
                      <span class="directory-admin__chip">{{ account.dingtalkAuthEnabled ? '已授权钉钉登录' : '未授权钉钉登录' }}</span>
                      <span class="directory-admin__chip">{{ account.isBound ? '已完成钉钉绑定' : '未完成钉钉绑定' }}</span>
                    </div>
                    <small>离职策略：{{ policyLabel(account.effectiveDeprovisionPolicy) }}</small>
                  </button>
                </article>
              </div>
              <div class="directory-admin__pager">
                <div>第 {{ accountsPage }} / {{ totalPages }} 页 · 共 {{ accountSummary.total }} 条</div>
                <div class="directory-admin__pager-actions">
                  <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !accountsHasPreviousPage" @click="prevPage">上一页</button>
                  <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !accountsHasNextPage" @click="nextPage">下一页</button>
                </div>
              </div>

              <div class="directory-admin__detail">
                <template v-if="selectedAccount">
                  <div class="directory-admin__detail-head">
                    <div>
                      <h3>{{ selectedAccount.name || selectedAccount.nick || selectedAccount.externalUserId }}</h3>
                      <p>{{ selectedAccount.email || '暂无邮箱' }} · {{ selectedAccount.mobile || '暂无手机号' }}</p>
                    </div>
                    <div class="directory-admin__chip-row">
                      <span class="directory-admin__chip">{{ selectedAccount.matchStatusLabel }}</span>
                      <span class="directory-admin__chip">{{ selectedAccount.linkStatusLabel }}</span>
                      <span class="directory-admin__chip">{{ selectedAccount.dingtalkAuthEnabled ? '已授权钉钉登录' : '未授权钉钉登录' }}</span>
                      <span class="directory-admin__chip">{{ selectedAccount.isBound ? '已完成钉钉绑定' : '未完成钉钉绑定' }}</span>
                    </div>
                  </div>

                  <div class="directory-admin__detail-grid">
                    <div class="directory-admin__info-card">
                      <strong>目录信息</strong>
                      <p>外部用户 ID：{{ selectedAccount.externalUserId }}</p>
                      <p>Job Number：{{ selectedAccount.jobNumber || '-' }}</p>
                      <p>Title：{{ selectedAccount.title || '-' }}</p>
                      <p>部门：{{ selectedAccount.departmentNames.join(' / ') || '-' }}</p>
                      <p>状态：{{ selectedAccount.isActive ? '在职' : '目录失活' }}</p>
                    </div>

                    <div class="directory-admin__info-card">
                      <strong>绑定与授权</strong>
                      <p>本地账号：{{ selectedAccount.linkedUser?.email || selectedAccount.linkedUser?.name || '未绑定' }}</p>
                      <p>匹配方式：{{ selectedAccount.matchStrategyLabel }}</p>
                      <p>有效离职策略：{{ policyLabel(selectedAccount.effectiveDeprovisionPolicy) }}</p>
                      <p>覆盖策略：{{ policyOverrideLabel(selectedAccount.deprovisionPolicyOverride) }}</p>
                    </div>
                  </div>

                  <div class="directory-admin__form-grid directory-admin__form-grid--actions">
                    <label class="directory-admin__field">
                      <span>关联已有 MetaSheet 用户 ID</span>
                      <input v-model.trim="manualLinkUserId" class="directory-admin__input" type="text" placeholder="例如 user-123">
                    </label>
                    <label class="directory-admin__field">
                      <span>开通邮箱</span>
                      <input v-model.trim="provisionEmail" class="directory-admin__input" type="email" placeholder="可留空，系统将生成钉钉占位邮箱">
                    </label>
                    <label class="directory-admin__field">
                      <span>开通姓名</span>
                      <input v-model.trim="provisionName" class="directory-admin__input" type="text" placeholder="可选">
                    </label>
                    <label class="directory-admin__field directory-admin__field--checkbox">
                      <span>开户后自动授权钉钉登录</span>
                      <input v-model="provisionAuthorizeDingtalk" type="checkbox">
                    </label>
                    <div class="directory-admin__field">
                      <span>离职策略覆盖</span>
                      <label class="directory-admin__policy-option directory-admin__policy-option--inline">
                        <input
                          type="checkbox"
                          :checked="useDefaultDeprovisionPolicy"
                          @change="setUseDefaultDeprovisionPolicy(eventChecked($event))"
                        >
                        <span>沿用集成默认策略</span>
                      </label>
                      <div class="directory-admin__preset-row">
                        <button
                          v-for="preset in policyPresets"
                          :key="preset.key"
                          class="directory-admin__preset"
                          :class="{ 'directory-admin__preset--active': !useDefaultDeprovisionPolicy && samePolicies(selectedDeprovisionPolicy, preset.policies) }"
                          type="button"
                          @click="applySelectedPreset(preset.policies)"
                        >
                          {{ preset.label }}
                        </button>
                      </div>
                      <div class="directory-admin__policy-group">
                        <label v-for="option in policyOptions" :key="option.value" class="directory-admin__policy-option">
                          <input
                            type="checkbox"
                            :checked="hasPolicy(selectedDeprovisionPolicy, option.value)"
                            :disabled="useDefaultDeprovisionPolicy"
                            @change="updateSelectedDeprovisionPolicy(option.value, eventChecked($event))"
                          >
                          <span>{{ option.label }}</span>
                        </label>
                      </div>
                      <small class="directory-admin__hint">取消“沿用”后可自由组合三项动作；不勾选任何项表示不执行额外离职动作。</small>
                    </div>
                  </div>

                  <div class="directory-admin__footer directory-admin__footer--wrap">
                    <button class="directory-admin__button" type="button" :disabled="busy || !manualLinkUserId.trim()" @click="void linkExisting()">
                      关联已有账号
                    </button>
                    <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !selectedAccount?.email || !!selectedAccount?.linkedUser?.id" @click="void autoLinkByEmail()">
                      按邮箱关联已有账号
                    </button>
                    <button class="directory-admin__button" type="button" :disabled="busy" @click="void provisionUser()">
                      开通本地账号
                    </button>
                    <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void authorizeDingtalk()">
                      {{ selectedAccount.dingtalkAuthEnabled ? '取消钉钉授权' : '授权钉钉登录' }}
                    </button>
                    <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void ignoreAccount()">
                      忽略
                    </button>
                    <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void unlinkAccount()">
                      解除绑定
                    </button>
                    <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void saveDeprovisionPolicy()">
                      保存离职策略
                    </button>
                  </div>
                  <p v-if="provisionedTemporaryPassword" class="directory-admin__status">
                    最新开户临时密码：{{ provisionedTemporaryPassword }}{{ provisionedUserEmail ? `（${provisionedUserEmail}）` : '' }}
                  </p>
                </template>

                <div v-else class="directory-admin__empty">请选择成员查看详情与操作</div>
              </div>
            </div>
          </section>
        </template>

        <div v-else class="directory-admin__empty directory-admin__empty--panel">
          暂无目录集成，请先创建一个钉钉组织目录配置。
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { apiFetch } from '../utils/api'
import { readErrorMessage } from '../utils/error'

type DeprovisionPolicyAction = 'mark_inactive' | 'disable_dingtalk_auth' | 'disable_local_user'
type DeprovisionPolicy = DeprovisionPolicyAction[]

type DirectoryIntegration = {
  id: string
  name: string
  provider: string
  corpId: string
  status: string
  statusLabel: string
  scheduleCron: string
  syncEnabled: boolean
  rootDepartmentId: string
  appKey: string
  appSecret: string
  hasAppSecret: boolean
  captureUnboundLogins: boolean
  defaultDeprovisionPolicy: DeprovisionPolicy
  lastSyncAt: string
  lastSuccessAt: string
  lastCursor: string
  lastError: string
}

type DirectoryRun = {
  id: string
  status: string
  statusLabel: string
  startedAt: string
  finishedAt: string
  cursorBefore: string
  cursorAfter: string
  errorMessage: string
  departmentsFetched: number
  accountsFetched: number
  accountsInserted: number
  accountsUpdated: number
  linksMatched: number
  linksConflicted: number
  accountsDeactivated: number
  permissionHint: DingTalkPermissionHint | null
}

type DirectoryScheduleStatus = {
  integrationId: string
  syncEnabled: boolean
  scheduleCron: string
  nextRunAt: string
  lastRunStatus: string
  lastRunStartedAt: string
  lastRunFinishedAt: string
  lastSuccessAt: string
  lastError: string
  alertCount: number
  unacknowledgedAlertCount: number
  lastAlertAt: string
}

type DirectorySyncAlert = {
  id: string
  integrationId: string
  runId: string
  level: string
  code: string
  message: string
  details: Record<string, unknown>
  sentToWebhook: boolean
  acknowledgedAt: string
  acknowledgedBy: string
  createdAt: string
  updatedAt: string
}

type DirectoryActivityResourceType =
  | 'directory-integration'
  | 'directory-account'
  | 'directory-sync-alert'
  | 'directory-template-center'

type DirectoryActivityItem = {
  id: string
  createdAt: string
  eventType: string
  eventCategory: string
  eventSeverity: string
  action: string
  resourceType: DirectoryActivityResourceType
  resourceId: string
  actorUserId: string
  actorName: string
  actorEmail: string
  actionDetails: Record<string, unknown>
  errorCode: string
  integrationId: string
  integrationName: string
  accountId: string
  accountName: string
  accountEmail: string
  accountExternalUserId: string
}

type DirectoryActivitySummary = {
  total: number
  integrationActions: number
  accountActions: number
  syncActions: number
  alertActions: number
  templateActions: number
}

type DingTalkPermissionHint = {
  provider: 'dingtalk'
  message: string
  subcode: string
  requiredScopes: string[]
  applyUrl: string
}

type DirectoryDepartment = {
  id: string
  externalDepartmentId: string
  name: string
  fullPath: string
  isActive: boolean
  orderIndex: number | null
  lastSeenAt: string
}

type DirectoryLinkedUser = {
  id: string
  email: string
  name: string
  isActive: boolean
}

type DirectoryAccount = {
  id: string
  externalUserId: string
  name: string
  nick: string
  email: string
  mobile: string
  jobNumber: string
  title: string
  avatarUrl: string
  isActive: boolean
  matchStatus: string
  matchStatusLabel: string
  matchStrategy: string
  matchStrategyLabel: string
  linkStatus: string
  linkStatusLabel: string
  dingtalkAuthEnabled: boolean
  isBound: boolean
  deprovisionPolicyOverride: DeprovisionPolicy | null
  effectiveDeprovisionPolicy: DeprovisionPolicy
  departmentNames: string[]
  linkedUser: DirectoryLinkedUser | null
}

type DirectoryAccountSummary = {
  total: number
  linked: number
  pending: number
  conflict: number
  ignored: number
  active: number
  inactive: number
  dingtalkAuthEnabled: number
  dingtalkAuthDisabled: number
  bound: number
  unbound: number
}

type BatchOperationFailure = {
  accountId: string
  accountName: string
  message: string
}

type BatchOperationResult = {
  label: string
  total: number
  successCount: number
  failureCount: number
  completedAt: string
  failures: BatchOperationFailure[]
}

type BatchHistoryFilter = 'all' | 'failed' | 'success'
type BatchRecommendationKey = 'auto-link' | 'provision-authorize' | 'authorize-dingtalk'
type BatchFailureReasonNotePresetKey = 'full' | 'brief' | 'admin' | 'ops'
type BatchFailureReasonNoteOutputModeKey = 'plain' | 'ticket' | 'im'
type BatchFailureReasonNoteSnippetKey = 'notify-retry' | 'fill-result' | 'escalate-admin'
type BatchFailureReasonHandlingGroupKey = 'recommended' | 'ticket-duty' | 'ops-handoff' | 'admin-escalation' | 'im-notify'
type BatchFailureReasonTeamTemplateFieldKey =
  | 'preset'
  | 'handlingGroupKey'
  | 'owner'
  | 'deadline'
  | 'channel'
  | 'extra'
  | 'snippetKeys'
type BatchFailureReasonTeamTemplateImportPresetKey =
  | 'all'
  | 'keep-owner-channel'
  | 'keep-extra-snippets'
  | 'structure-only'
type BatchFailureReasonNoteContext = {
  owner: string
  deadline: string
  channel: string
  extra: string
}
type BatchFailureReasonNotePreference = {
  preset: BatchFailureReasonNotePresetKey
  owner: string
  deadline: string
  channel: string
  snippetKeys: BatchFailureReasonNoteSnippetKey[]
}
type BatchFailureReasonNotePreferenceStore = {
  lastOutputMode: BatchFailureReasonNoteOutputModeKey
  byOutputMode: Partial<Record<BatchFailureReasonNoteOutputModeKey, BatchFailureReasonNotePreference>>
}
type BatchFailureReasonTeamTemplate = {
  preset: BatchFailureReasonNotePresetKey
  handlingGroupKey: BatchFailureReasonHandlingGroupKey
  owner: string
  deadline: string
  channel: string
  extra: string
  snippetKeys: BatchFailureReasonNoteSnippetKey[]
  savedAt: string
}
type BatchFailureReasonTeamTemplateStore = Partial<Record<BatchFailureReasonNoteOutputModeKey, BatchFailureReasonTeamTemplate>>
type BatchFailureReasonTeamTemplateCodePayload = {
  version: 1
  outputMode: BatchFailureReasonNoteOutputModeKey
  template: BatchFailureReasonTeamTemplate
}
type BatchFailureReasonTeamTemplateImportSource = 'code' | 'json'
type BatchFailureReasonTeamTemplateDiffMode = 'added' | 'removed' | 'changed'
type BatchFailureReasonTeamTemplateDiffEntry = {
  key: BatchFailureReasonTeamTemplateFieldKey
  label: string
  before: string
  after: string
  mode: BatchFailureReasonTeamTemplateDiffMode
}
type BatchFailureReasonTeamTemplateImportHistoryItem = {
  id: string
  importedAt: string
  outputMode: BatchFailureReasonNoteOutputModeKey
  source: BatchFailureReasonTeamTemplateImportSource
  appliedImmediately: boolean
  importedTemplate: BatchFailureReasonTeamTemplate
  previousTemplate: BatchFailureReasonTeamTemplate | null
  previousPreference: BatchFailureReasonNotePreference | null
  previousActiveTemplate: BatchFailureReasonTeamTemplate | null
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[]
  rolledBackAt: string
}
type BatchFailureReasonTeamTemplateImportHistory = BatchFailureReasonTeamTemplateImportHistoryItem[]
type BatchFailureReasonTeamTemplateImportPreset = {
  id: string
  name: string
  tags: string[]
  favorite: boolean
  pinned: boolean
  lockedOrder: number
  useCount: number
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[]
  savedAt: string
  updatedAt: string
  lastUsedAt: string
}
type BatchFailureReasonTeamTemplateImportPresetStore = Partial<Record<
  BatchFailureReasonNoteOutputModeKey,
  BatchFailureReasonTeamTemplateImportPreset[]
>>
type BatchFailureReasonTeamTemplateImportPresetGroup = {
  key: string
  label: string
  presets: BatchFailureReasonTeamTemplateImportPreset[]
}
type BatchFailureReasonTeamTemplateImportPresetPreference = {
  lockRecentUsageOrder: boolean
}
type DirectoryTemplateCenter = {
  integrationId: string
  teamTemplates: BatchFailureReasonTeamTemplateStore
  importHistory: BatchFailureReasonTeamTemplateImportHistory
  importPresets: BatchFailureReasonTeamTemplateImportPresetStore
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}
type DirectoryTemplateCenterVersion = {
  id: string
  centerId: string
  integrationId: string
  changeReason: string
  createdBy: string
  createdAt: string
  snapshotSummary: {
    outputModes: string[]
    teamTemplateCount: number
    importPresetCount: number
    importHistoryCount: number
  }
}
type DirectoryTemplateGovernancePreset = {
  outputMode: string
  id: string
  name: string
  tags: string[]
  favorite: boolean
  pinned: boolean
  useCount: number
  lastUsedAt: string
  ignoredFieldCount: number
  usageBucket: 'unused' | 'low' | 'high'
}
type DirectoryTemplateGovernanceReport = {
  integrationId: string
  generatedAt: string
  totals: {
    outputModes: number
    teamTemplates: number
    importPresets: number
    favorites: number
    pinned: number
    highFrequency: number
    lowFrequency: number
    unused: number
    distinctTags: number
  }
  tagSummary: Array<{
    tag: string
    count: number
  }>
  presets: DirectoryTemplateGovernancePreset[]
}
type BatchFailureReasonNoteDrafts = Record<string, BatchFailureReasonNoteContext>
type BatchFailureReasonNoteSnippetDrafts = Record<string, BatchFailureReasonNoteSnippetKey[]>
type BatchFailureReasonHandlingGroupDrafts = Record<string, BatchFailureReasonHandlingGroupKey>
type BatchFailureContext = {
  failure: BatchOperationFailure
  account: DirectoryAccount | null
}
type BatchRecommendationGroup = {
  key: BatchRecommendationKey
  label: string
  accounts: DirectoryAccount[]
}
type BatchFailureReasonGroup = {
  message: string
  count: number
  accountIds: string[]
  recommendations: string[]
}

type DirectoryForm = {
  name: string
  corpId: string
  appKey: string
  appSecret: string
  rootDepartmentId: string
  scheduleCron: string
  syncEnabled: boolean
  captureUnboundLogins: boolean
  defaultDeprovisionPolicy: DeprovisionPolicy
}

type AccountQuickFilter = 'all' | 'pending' | 'bound' | 'dingtalk-disabled'
type DirectoryActivityScopeFilter = 'all' | 'selected-account'

const policyOptions = [
  { value: 'mark_inactive', label: '标记目录失活' },
  { value: 'disable_dingtalk_auth', label: '禁用钉钉登录' },
  { value: 'disable_local_user', label: '停用本地账号' },
] as const
const directoryActivityActionOptions = [
  { value: 'create', label: '创建' },
  { value: 'update', label: '更新' },
  { value: 'test', label: '测试连接' },
  { value: 'sync', label: '手动同步' },
  { value: 'schedule', label: '计划同步' },
  { value: 'acknowledge', label: '确认告警' },
  { value: 'capture-unbound-login', label: '捕获未开户登录' },
  { value: 'refresh-unbound-login', label: '刷新未开户登录' },
  { value: 'dedupe-unbound-login-capture', label: '去重待审核登录' },
  { value: 'link', label: '关联已有账号' },
  { value: 'provision', label: '开通本地账号' },
  { value: 'authorize', label: '授权钉钉' },
  { value: 'revoke', label: '取消授权钉钉' },
  { value: 'ignore', label: '忽略成员' },
  { value: 'unlink', label: '解除绑定' },
] as const
const directoryActivityResourceTypeOptions = [
  { value: 'directory-integration', label: '目录集成' },
  { value: 'directory-account', label: '目录成员' },
  { value: 'directory-sync-alert', label: '同步告警' },
  { value: 'directory-template-center', label: '模板中心' },
] as const

const DEFAULT_DEPROVISION_POLICY: DeprovisionPolicy = ['mark_inactive']
const policyPresets = [
  { key: 'status-only', label: '仅目录失活', policies: ['mark_inactive'] },
  { key: 'disable-dingtalk', label: '失活+禁用钉钉', policies: ['mark_inactive', 'disable_dingtalk_auth'] },
  { key: 'all', label: '全部执行', policies: ['mark_inactive', 'disable_dingtalk_auth', 'disable_local_user'] },
  { key: 'none', label: '无额外动作', policies: [] },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  policies: DeprovisionPolicy
}>
const batchFailureReasonNotePresets = [
  {
    key: 'full',
    label: '完整交接',
    description: '保留操作时间、建议动作和完整成员清单，适合工单或交接记录。',
  },
  {
    key: 'brief',
    label: 'IM 简版',
    description: '压缩成一段短通知，适合发在钉钉群或 IM。',
  },
  {
    key: 'admin',
    label: '管理员处理',
    description: '强调后台处理动作和成员名单，适合转给系统管理员。',
  },
  {
    key: 'ops',
    label: '运营跟进',
    description: '强调回填与跟进动作，适合客服或运营接手。',
  },
] as const satisfies ReadonlyArray<{
  key: BatchFailureReasonNotePresetKey
  label: string
  description: string
}>
const batchFailureReasonNoteOutputModes = [
  {
    key: 'plain',
    label: '备注原文',
    description: '保留当前模板原文，适合直接粘贴到系统备注或交接记录。',
  },
  {
    key: 'ticket',
    label: '工单 Markdown',
    description: '增加标题与摘要，适合工单、知识库或 Markdown 备注。',
  },
  {
    key: 'im',
    label: 'IM 外发',
    description: '压缩为便于群聊或私聊外发的短消息。',
  },
] as const satisfies ReadonlyArray<{
  key: BatchFailureReasonNoteOutputModeKey
  label: string
  description: string
}>
const batchFailureReasonNoteSnippets = [
  { key: 'notify-retry', label: '通知用户重试', text: '处理完成后请通知用户重新尝试。' },
  { key: 'fill-result', label: '处理后回填', text: '处理完成后请在群里或工单中回填结果。' },
  { key: 'escalate-admin', label: '仍失败升级管理员', text: '若再次失败，请升级管理员继续排查。' },
] as const satisfies ReadonlyArray<{
  key: BatchFailureReasonNoteSnippetKey
  label: string
  text: string
}>
const batchFailureReasonHandlingGroups = [
  {
    key: 'recommended',
    label: '推荐处理组',
    description: '按当前失败原因带出推荐模板、负责人、截止时间、同步渠道和默认补充语。',
  },
  {
    key: 'ticket-duty',
    label: '工单值班',
    description: '偏值班/工单交接，默认带回填动作，适合 Jira 或工单系统。',
  },
  {
    key: 'ops-handoff',
    label: '运营跟进',
    description: '偏运营/客服接手，默认带通知重试和处理后回填。',
  },
  {
    key: 'admin-escalation',
    label: '管理员升级',
    description: '偏平台管理员介入，默认带升级管理员动作。',
  },
  {
    key: 'im-notify',
    label: '即时通知',
    description: '偏钉钉群或 IM 快速通知，默认强调重试提醒。',
  },
] as const satisfies ReadonlyArray<{
  key: BatchFailureReasonHandlingGroupKey
  label: string
  description: string
}>
const batchFailureReasonTeamTemplateImportPresetOptions = [
  {
    key: 'all',
    label: '全量导入',
    description: '不忽略任何字段，完整覆盖当前输出模板。',
    ignoredFieldKeys: [],
  },
  {
    key: 'keep-owner-channel',
    label: '保留负责人/渠道',
    description: '保留负责人、截止时间和同步渠道，只更新模板结构与说明。',
    ignoredFieldKeys: ['owner', 'deadline', 'channel'],
  },
  {
    key: 'keep-extra-snippets',
    label: '保留说明/补充语',
    description: '保留补充说明和快捷补充语，适合沿用本地沟通话术。',
    ignoredFieldKeys: ['extra', 'snippetKeys'],
  },
  {
    key: 'structure-only',
    label: '仅更新模板结构',
    description: '只更新内容模板与处理组，保留全部人工填写字段。',
    ignoredFieldKeys: ['owner', 'deadline', 'channel', 'extra', 'snippetKeys'],
  },
] as const satisfies ReadonlyArray<{
  key: BatchFailureReasonTeamTemplateImportPresetKey
  label: string
  description: string
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[]
}>
const BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY = 'metasheet_directory_batch_failure_note_preferences'
const BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY = 'metasheet_directory_batch_failure_team_templates'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_STORAGE_KEY = 'metasheet_directory_batch_failure_team_template_import_history'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY = 'metasheet_directory_batch_failure_team_template_import_presets'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_PREFERENCES_STORAGE_KEY = 'metasheet_directory_batch_failure_team_template_import_preset_preferences'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX = 'MSDT-TPL-1:'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_LIMIT = 5
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_LIMIT = 6
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_TAG_LIMIT = 4

const loadingIntegrations = ref(false)
const busy = ref(false)
const exportingAccounts = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const statusPermissionHint = ref<DingTalkPermissionHint | null>(null)
const integrations = ref<DirectoryIntegration[]>([])
const runs = ref<DirectoryRun[]>([])
const departments = ref<DirectoryDepartment[]>([])
const accounts = ref<DirectoryAccount[]>([])
const selectedIntegrationId = ref('')
const selectedAccountId = ref('')
const accountSearch = ref('')
const accountStatusFilter = ref<'all' | 'linked' | 'pending' | 'conflict' | 'ignored' | 'inactive'>('all')
const accountMatchStrategyFilter = ref('')
const accountDingtalkAuthFilter = ref<'all' | 'enabled' | 'disabled'>('all')
const accountBindingFilter = ref<'all' | 'bound' | 'unbound'>('all')
const accountDepartmentFilter = ref('')
const selectedAccountIds = ref<string[]>([])
const manualLinkUserId = ref('')
const provisionEmail = ref('')
const provisionName = ref('')
const provisionAuthorizeDingtalk = ref(true)
const provisionedTemporaryPassword = ref('')
const provisionedUserEmail = ref('')
const selectedDeprovisionPolicy = ref<DeprovisionPolicy>([...DEFAULT_DEPROVISION_POLICY])
const useDefaultDeprovisionPolicy = ref(true)
const accountsTotal = ref(0)
const accountsPage = ref(1)
const accountsPageSize = ref(20)
const accountsPageCount = ref(1)
const accountsHasNextPage = ref(false)
const accountsHasPreviousPage = ref(false)
const accountSummary = ref<DirectoryAccountSummary>({
  total: 0,
  linked: 0,
  pending: 0,
  conflict: 0,
  ignored: 0,
  active: 0,
  inactive: 0,
  dingtalkAuthEnabled: 0,
  dingtalkAuthDisabled: 0,
  bound: 0,
  unbound: 0,
})
const latestBatchResult = ref<BatchOperationResult | null>(null)
const batchResultHistory = ref<BatchOperationResult[]>([])
const batchHistoryFilter = ref<BatchHistoryFilter>('all')
const batchFailureFilterActive = ref(false)
const batchFailureReasonFilter = ref('')
const batchFailureReasonNotePreferences = ref<BatchFailureReasonNotePreferenceStore>(
  loadBatchFailureReasonNotePreferences(),
)
const batchFailureReasonTeamTemplates = ref<BatchFailureReasonTeamTemplateStore>(
  loadBatchFailureReasonTeamTemplates(),
)
const batchFailureReasonTeamTemplateImportHistory = ref<BatchFailureReasonTeamTemplateImportHistory>(
  loadBatchFailureReasonTeamTemplateImportHistory(),
)
const batchFailureReasonTeamTemplateImportPresets = ref<BatchFailureReasonTeamTemplateImportPresetStore>(
  loadBatchFailureReasonTeamTemplateImportPresets(),
)
const batchFailureReasonTeamTemplateImportPresetPreference = ref<BatchFailureReasonTeamTemplateImportPresetPreference>(
  loadBatchFailureReasonTeamTemplateImportPresetPreference(),
)
const directoryTemplateCenter = ref<DirectoryTemplateCenter | null>(null)
const directoryTemplateCenterVersions = ref<DirectoryTemplateCenterVersion[]>([])
const directoryTemplateGovernanceReport = ref<DirectoryTemplateGovernanceReport | null>(null)
const directoryScheduleStatus = ref<DirectoryScheduleStatus | null>(null)
const directorySyncAlerts = ref<DirectorySyncAlert[]>([])
const directoryActivityLoading = ref(false)
const exportingDirectoryActivity = ref(false)
const directoryActivityItems = ref<DirectoryActivityItem[]>([])
const directoryActivitySearch = ref('')
const directoryActivityActionFilter = ref('')
const directoryActivityResourceTypeFilter = ref('')
const directoryActivityFromDate = ref('')
const directoryActivityToDate = ref('')
const directoryActivityScopeFilter = ref<DirectoryActivityScopeFilter>('all')
const directoryActivityTotal = ref(0)
const directoryActivityPage = ref(1)
const directoryActivityPageSize = ref(10)
const directoryActivityPageCount = ref(1)
const directoryActivityHasNextPage = ref(false)
const directoryActivityHasPreviousPage = ref(false)
const directoryActivitySummary = ref<DirectoryActivitySummary>({
  total: 0,
  integrationActions: 0,
  accountActions: 0,
  syncActions: 0,
  alertActions: 0,
  templateActions: 0,
})
const directoryTemplateCenterLoading = ref(false)
const directoryTemplateCenterSaving = ref(false)
const directoryTemplateCenterLoaded = ref(false)
const directoryTemplateCenterHydrating = ref(false)
const directoryTemplateCenterSyncError = ref('')
const directoryTemplateCenterLastSavedAt = ref('')
const showBatchFailureReasonTeamTemplateImport = ref(false)
const batchFailureReasonTeamTemplateCodeInput = ref('')
const batchFailureReasonTeamTemplateIgnoredFieldKeys = ref<BatchFailureReasonTeamTemplateFieldKey[]>([])
const batchFailureReasonTeamTemplateImportPresetName = ref('')
const batchFailureReasonTeamTemplateImportPresetTagsInput = ref('')
const batchFailureReasonTeamTemplateImportPresetSearch = ref('')
const selectedBatchFailureReasonTeamTemplateImportPresetTag = ref('')
const selectedBatchFailureReasonTeamTemplateImportPresetId = ref('')
const activeBatchFailureReasonNotePreset = ref<BatchFailureReasonNotePresetKey>('full')
const activeBatchFailureReasonNoteOutputMode = ref<BatchFailureReasonNoteOutputModeKey>(
  batchFailureReasonNotePreferences.value.lastOutputMode,
)
const batchFailureReasonNoteDrafts = ref<BatchFailureReasonNoteDrafts>({})
const batchFailureReasonNoteSnippetDrafts = ref<BatchFailureReasonNoteSnippetDrafts>({})
const batchFailureReasonHandlingGroupDrafts = ref<BatchFailureReasonHandlingGroupDrafts>({})
const migratedTemplateCenterIntegrations = new Set<string>()
let directoryTemplateCenterSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingDirectoryTemplateCenterChangeReason = 'ui_edit'
const draft = reactive<DirectoryForm>({
  name: '',
  corpId: '',
  appKey: '',
  appSecret: '',
  rootDepartmentId: '',
  scheduleCron: '',
  syncEnabled: true,
  captureUnboundLogins: true,
  defaultDeprovisionPolicy: [...DEFAULT_DEPROVISION_POLICY],
})

const selectedIntegration = computed(() => integrations.value.find((item) => item.id === selectedIntegrationId.value) || null)
const isCreating = computed(() => selectedIntegrationId.value.length === 0)
const canSaveIntegration = computed(() =>
  draft.name.trim().length > 0
  && draft.corpId.trim().length > 0
  && draft.appKey.trim().length > 0
  && (draft.appSecret.trim().length > 0 || (selectedIntegration.value?.hasAppSecret === true && !isCreating.value)),
)
const selectedAccount = computed(() => accounts.value.find((item) => item.id === selectedAccountId.value) || null)
const latestBatchFailureAccountIds = computed(() =>
  new Set((latestBatchResult.value?.failures || []).map((item) => item.accountId)),
)
const latestBatchFailureContexts = computed<BatchFailureContext[]>(() =>
  (latestBatchResult.value?.failures || []).map((failure) => ({
    failure,
    account: accounts.value.find((item) => item.id === failure.accountId) || null,
  })),
)
const batchFailureReasonGroups = computed<BatchFailureReasonGroup[]>(() => {
  const groups = new Map<string, { count: number; accountIds: string[]; contexts: BatchFailureContext[] }>()
  for (const context of latestBatchFailureContexts.value) {
    const current = groups.get(context.failure.message)
    if (current) {
      current.count += 1
      current.accountIds.push(context.failure.accountId)
      current.contexts.push(context)
      continue
    }
    groups.set(context.failure.message, {
      count: 1,
      accountIds: [context.failure.accountId],
      contexts: [context],
    })
  }
  return Array.from(groups.entries())
    .map(([message, value]) => ({
      message,
      count: value.count,
      accountIds: value.accountIds,
      recommendations: buildBatchRecommendations(value.contexts).map((item) => item.label),
    }))
    .sort((left, right) => right.count - left.count || left.message.localeCompare(right.message, 'zh-CN'))
})
const activeBatchFailureReasonGroup = computed(() =>
  batchFailureReasonGroups.value.find((item) => item.message === batchFailureReasonFilter.value) || null,
)
const activeBatchFailureContexts = computed(() => {
  if (!activeBatchFailureReasonGroup.value) {
    return latestBatchFailureContexts.value
  }

  const activeMessage = activeBatchFailureReasonGroup.value.message
  const activeAccountIds = new Set(activeBatchFailureReasonGroup.value.accountIds)
  return latestBatchFailureContexts.value.filter(({ failure }) =>
    failure.message === activeMessage && activeAccountIds.has(failure.accountId),
  )
})
const batchRecommendationGroups = computed<BatchRecommendationGroup[]>(() =>
  buildBatchRecommendations(activeBatchFailureContexts.value),
)
const batchRecommendationTitle = computed(() =>
  activeBatchFailureReasonGroup.value ? `推荐下一步（${activeBatchFailureReasonGroup.value.message}）` : '推荐下一步',
)
const batchRecommendationSummary = computed(() => {
  const labels = batchRecommendationGroups.value.map((item) => `${item.label} ${item.accounts.length} 项`)
  if (labels.length === 0) {
    return ''
  }
  if (activeBatchFailureReasonGroup.value) {
    return `当前推荐已按失败原因“${activeBatchFailureReasonGroup.value.message}”收窄：${labels.join('；')}`
  }
  return `根据失败成员当前状态，建议优先执行：${labels.join('；')}`
})
const recommendedBatchFailureReasonNotePreset = computed(() => {
  if (!activeBatchFailureReasonGroup.value) {
    return batchFailureReasonNotePresets[0]
  }
  const defaultPresetKey = defaultBatchFailureReasonNotePreset(activeBatchFailureReasonGroup.value)
  return batchFailureReasonNotePresets.find((item) => item.key === defaultPresetKey) || batchFailureReasonNotePresets[0]
})
const activeBatchFailureReasonNotePresetOption = computed(() =>
  batchFailureReasonNotePresets.find((item) => item.key === activeBatchFailureReasonNotePreset.value) || batchFailureReasonNotePresets[0],
)
const activeBatchFailureReasonNoteOutputModeOption = computed(() =>
  batchFailureReasonNoteOutputModes.find((item) => item.key === activeBatchFailureReasonNoteOutputMode.value) || batchFailureReasonNoteOutputModes[0],
)
const activeBatchFailureReasonHandlingGroupKey = computed<BatchFailureReasonHandlingGroupKey>(() => {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return 'recommended'
  }
  return batchFailureReasonHandlingGroupDrafts.value[group.message] || defaultBatchFailureReasonHandlingGroup(group)
})
const activeBatchFailureReasonHandlingGroupOption = computed(() =>
  batchFailureReasonHandlingGroups.find((item) => item.key === activeBatchFailureReasonHandlingGroupKey.value)
  || batchFailureReasonHandlingGroups[0],
)
const activeStoredBatchFailureReasonNotePreference = computed(() =>
  getStoredBatchFailureReasonNotePreference(activeBatchFailureReasonNoteOutputMode.value),
)
const activeBatchFailureReasonTeamTemplate = computed(() =>
  batchFailureReasonTeamTemplates.value[activeBatchFailureReasonNoteOutputMode.value] || null,
)
const batchFailureReasonTeamTemplateImportPreview = computed(() =>
  decodeBatchFailureReasonTeamTemplateCode(batchFailureReasonTeamTemplateCodeInput.value),
)
const batchFailureReasonTeamTemplateImportDiffPreview = computed<BatchFailureReasonTeamTemplateDiffEntry[]>(() => {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    return []
  }
  return buildBatchFailureReasonTeamTemplateDiffEntries(
    batchFailureReasonTeamTemplates.value[payload.outputMode] || null,
    payload.template,
  )
})
const batchFailureReasonTeamTemplateIgnoredDiffPreview = computed(() =>
  batchFailureReasonTeamTemplateImportDiffPreview.value.filter((entry) =>
    batchFailureReasonTeamTemplateIgnoredFieldKeys.value.includes(entry.key),
  ),
)
const batchFailureReasonTeamTemplateAppliedImportPreview = computed<BatchFailureReasonTeamTemplate | null>(() => {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    return null
  }
  return applyIgnoredBatchFailureReasonTeamTemplateFields(
    batchFailureReasonTeamTemplates.value[payload.outputMode] || null,
    payload.template,
    batchFailureReasonTeamTemplateIgnoredFieldKeys.value,
  )
})
const batchFailureReasonTeamTemplateImportDiffSummary = computed(() => {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  const importedTemplate = batchFailureReasonTeamTemplateAppliedImportPreview.value
  if (!payload || !importedTemplate) {
    return ''
  }
  return buildBatchFailureReasonTeamTemplateDiffSummary(
    batchFailureReasonTeamTemplates.value[payload.outputMode] || null,
    importedTemplate,
    batchFailureReasonTeamTemplateIgnoredFieldKeys.value,
  )
})
const batchFailureReasonTeamTemplateIgnoredFieldLabels = computed(() =>
  batchFailureReasonTeamTemplateIgnoredDiffPreview.value.map((entry) => entry.label),
)
const activeBatchFailureReasonTeamTemplateImportPresetOutputMode = computed<BatchFailureReasonNoteOutputModeKey>(() =>
  batchFailureReasonTeamTemplateImportPreview.value?.outputMode || activeBatchFailureReasonNoteOutputMode.value,
)
const activeBatchFailureReasonTeamTemplateImportPresetList = computed(() =>
  sortBatchFailureReasonTeamTemplateImportPresets(
    batchFailureReasonTeamTemplateImportPresets.value[activeBatchFailureReasonTeamTemplateImportPresetOutputMode.value] || [],
    batchFailureReasonTeamTemplateImportPresetPreference.value.lockRecentUsageOrder,
  ),
)
const activeBatchFailureReasonTeamTemplateImportPreset = computed(() => {
  const presets = activeBatchFailureReasonTeamTemplateImportPresetList.value
  if (presets.length === 0) {
    return null
  }
  return presets.find((item) => item.id === selectedBatchFailureReasonTeamTemplateImportPresetId.value) || presets[0] || null
})
const activeBatchFailureReasonTeamTemplateImportPresetLabels = computed(() =>
  (activeBatchFailureReasonTeamTemplateImportPreset.value?.ignoredFieldKeys || [])
    .map((key) => batchFailureReasonTeamTemplateFieldLabel(key))
    .filter((label) => label.length > 0),
)
const activeBatchFailureReasonTeamTemplateImportPresetStateLabels = computed(() =>
  activeBatchFailureReasonTeamTemplateImportPreset.value
    ? batchFailureReasonTeamTemplateImportPresetStateLabels(activeBatchFailureReasonTeamTemplateImportPreset.value)
    : [],
)
const activeBatchFailureReasonTeamTemplateImportPresetTagLabels = computed(() =>
  activeBatchFailureReasonTeamTemplateImportPreset.value?.tags || [],
)
const activeBatchFailureReasonTeamTemplateImportPresetUsageSummary = computed(() => {
  const preset = activeBatchFailureReasonTeamTemplateImportPreset.value
  if (!preset) {
    return ''
  }
  const segments = [`已使用 ${preset.useCount} 次`]
  if (preset.lastUsedAt) {
    segments.push(`最近使用 ${preset.lastUsedAt}`)
  }
  return segments.join(' · ')
})
const batchFailureReasonTeamTemplateImportPresetAvailableTags = computed(() =>
  Array.from(new Set(
    activeBatchFailureReasonTeamTemplateImportPresetList.value.flatMap((preset) => preset.tags),
  )).sort((left, right) => left.localeCompare(right, 'zh-CN')),
)
const filteredBatchFailureReasonTeamTemplateImportPresetList = computed(() => {
  const search = batchFailureReasonTeamTemplateImportPresetSearch.value.trim().toLowerCase()
  const tag = selectedBatchFailureReasonTeamTemplateImportPresetTag.value.trim()
  return activeBatchFailureReasonTeamTemplateImportPresetList.value.filter((preset) => {
    if (tag && !preset.tags.includes(tag)) {
      return false
    }
    if (!search) {
      return true
    }
    const haystacks = [preset.name, ...preset.tags].map((item) => item.toLowerCase())
    return haystacks.some((item) => item.includes(search))
  })
})
const groupedBatchFailureReasonTeamTemplateImportPresets = computed<BatchFailureReasonTeamTemplateImportPresetGroup[]>(() => {
  const activeTag = selectedBatchFailureReasonTeamTemplateImportPresetTag.value.trim()
  const groups = new Map<string, BatchFailureReasonTeamTemplateImportPresetGroup>()
  for (const preset of filteredBatchFailureReasonTeamTemplateImportPresetList.value) {
    const groupLabel = activeTag || preset.tags[0] || '未分组'
    if (!groups.has(groupLabel)) {
      groups.set(groupLabel, {
        key: groupLabel,
        label: groupLabel,
        presets: [],
      })
    }
    groups.get(groupLabel)?.presets.push(preset)
  }
  return Array.from(groups.values())
})
const lowFrequencyBatchFailureReasonTeamTemplateImportPresets = computed(() =>
  filteredBatchFailureReasonTeamTemplateImportPresetList.value.filter((preset) =>
    !preset.favorite && !preset.pinned && preset.useCount <= 1,
  ),
)
const activeStoredBatchFailureReasonNotePresetLabel = computed(() => {
  const storedPreset = activeStoredBatchFailureReasonNotePreference.value?.preset
  if (!storedPreset) {
    return ''
  }
  return batchFailureReasonNotePresets.find((item) => item.key === storedPreset)?.label || ''
})
const activeStoredBatchFailureReasonNoteSnippetLabels = computed(() =>
  (activeStoredBatchFailureReasonNotePreference.value?.snippetKeys || [])
    .map((key) => batchFailureReasonNoteSnippets.find((item) => item.key === key)?.label || key)
    .filter((label) => label.length > 0),
)
const activeStoredBatchFailureReasonNoteSummary = computed(() => {
  const stored = activeStoredBatchFailureReasonNotePreference.value
  if (!stored) {
    return ''
  }

  const segments = [`模板 ${activeStoredBatchFailureReasonNotePresetLabel.value || stored.preset}`]
  if (stored.owner) {
    segments.push(`负责人 ${stored.owner}`)
  }
  if (stored.deadline) {
    segments.push(`截止 ${stored.deadline}`)
  }
  if (stored.channel) {
    segments.push(`渠道 ${stored.channel}`)
  }
  if (activeStoredBatchFailureReasonNoteSnippetLabels.value.length > 0) {
    segments.push(`补充语 ${activeStoredBatchFailureReasonNoteSnippetLabels.value.join(' / ')}`)
  }
  return segments.join(' · ')
})
const hasActiveStoredBatchFailureReasonNoteSnippets = computed(() =>
  activeStoredBatchFailureReasonNoteSnippetLabels.value.length > 0,
)
const activeBatchFailureReasonTeamTemplateSummary = computed(() => {
  const template = activeBatchFailureReasonTeamTemplate.value
  if (!template) {
    return ''
  }
  return summarizeBatchFailureReasonTeamTemplate(template)
})
const recentBatchFailureReasonTeamTemplateImports = computed(() =>
  batchFailureReasonTeamTemplateImportHistory.value.slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_LIMIT),
)
const activeBatchFailureReasonNoteDraft = computed<BatchFailureReasonNoteContext | null>(() => {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return null
  }
  return batchFailureReasonNoteDrafts.value[group.message] || null
})
const activeBatchFailureReasonNoteSnippetKeys = computed<BatchFailureReasonNoteSnippetKey[]>(() => {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return []
  }
  return batchFailureReasonNoteSnippetDrafts.value[group.message] || []
})
const recommendedBatchFailureReasonNoteOwner = computed(() =>
  activeBatchFailureReasonGroup.value ? defaultBatchFailureReasonNoteOwner(activeBatchFailureReasonGroup.value) : '',
)
const recommendedBatchFailureReasonNoteDeadline = computed(() =>
  activeBatchFailureReasonGroup.value ? defaultBatchFailureReasonNoteDeadline(activeBatchFailureReasonGroup.value) : '',
)
const recommendedBatchFailureReasonNoteChannel = computed(() =>
  activeBatchFailureReasonGroup.value ? defaultBatchFailureReasonNoteChannel(activeBatchFailureReasonGroup.value) : '',
)
const recommendedBatchFailureReasonNoteExtra = computed(() =>
  activeBatchFailureReasonGroup.value ? defaultBatchFailureReasonNoteExtra(activeBatchFailureReasonGroup.value) : '',
)
const activeBatchFailureReasonNoteContext = computed<BatchFailureReasonNoteContext>(() => ({
  owner: activeBatchFailureReasonNoteDraft.value?.owner.trim() || '',
  deadline: activeBatchFailureReasonNoteDraft.value?.deadline.trim() || '',
  channel: activeBatchFailureReasonNoteDraft.value?.channel.trim() || '',
  extra: activeBatchFailureReasonNoteDraft.value?.extra.trim() || '',
}))
const batchFailureReasonNoteOwner = computed({
  get: () => activeBatchFailureReasonNoteContext.value.owner,
  set: (value: string) => updateActiveBatchFailureReasonNoteContext('owner', value),
})
const batchFailureReasonNoteDeadline = computed({
  get: () => activeBatchFailureReasonNoteContext.value.deadline,
  set: (value: string) => updateActiveBatchFailureReasonNoteContext('deadline', value),
})
const batchFailureReasonNoteChannel = computed({
  get: () => activeBatchFailureReasonNoteContext.value.channel,
  set: (value: string) => updateActiveBatchFailureReasonNoteContext('channel', value),
})
const batchFailureReasonNoteExtra = computed({
  get: () => activeBatchFailureReasonNoteContext.value.extra,
  set: (value: string) => updateActiveBatchFailureReasonNoteContext('extra', value),
})
const activeBatchFailureReasonRawNote = computed(() =>
  activeBatchFailureReasonGroup.value
    ? buildBatchFailureReasonNote(
        activeBatchFailureReasonGroup.value,
        activeBatchFailureReasonNotePreset.value,
        activeBatchFailureReasonNoteContext.value,
      )
    : '',
)
const activeBatchFailureReasonNotePreview = computed(() =>
  activeBatchFailureReasonGroup.value
    ? formatBatchFailureReasonNoteOutput(
        activeBatchFailureReasonRawNote.value,
        activeBatchFailureReasonGroup.value,
        activeBatchFailureReasonNotePresetOption.value.label,
        activeBatchFailureReasonNoteOutputMode.value,
      )
    : '',
)
const visibleBatchFailureCount = computed(() =>
  accounts.value.filter((item) => latestBatchFailureAccountIds.value.has(item.id)).length,
)
const filteredAccounts = computed(() => {
  if (!batchFailureFilterActive.value) {
    return accounts.value
  }
  if (!batchFailureReasonFilter.value) {
    return accounts.value.filter((item) => latestBatchFailureAccountIds.value.has(item.id))
  }
  const reasonGroup = activeBatchFailureReasonGroup.value
  const accountIds = new Set(reasonGroup?.accountIds || [])
  return accounts.value.filter((item) => accountIds.has(item.id))
})
const selectedAccounts = computed(() => {
  const selectedIds = new Set(selectedAccountIds.value)
  return filteredAccounts.value.filter((item) => selectedIds.has(item.id))
})
const allVisibleAccountsSelected = computed(() =>
  filteredAccounts.value.length > 0
  && filteredAccounts.value.every((item) => selectedAccountIds.value.includes(item.id)),
)
const directoryActivityTotalPages = computed(() => Math.max(1, directoryActivityPageCount.value))
const batchAuthorizeEligible = computed(() =>
  selectedAccounts.value.filter((item) => Boolean(item.linkedUser?.id) && !item.dingtalkAuthEnabled),
)
const batchProvisionEligible = computed(() =>
  selectedAccounts.value.filter((item) => !item.linkedUser?.id),
)
const batchAutoLinkByEmailEligible = computed(() =>
  selectedAccounts.value.filter((item) => !item.linkedUser?.id && Boolean(item.email)),
)
const batchRevokeEligible = computed(() =>
  selectedAccounts.value.filter((item) => Boolean(item.linkedUser?.id) && item.dingtalkAuthEnabled),
)
const batchIgnoreEligible = computed(() =>
  selectedAccounts.value.filter((item) => item.linkStatus !== 'ignored'),
)
const batchUnlinkEligible = computed(() =>
  selectedAccounts.value.filter((item) => Boolean(item.linkedUser?.id) && !item.isBound),
)
const activeQuickFilter = computed<AccountQuickFilter | null>(() => {
  if (
    accountSearch.value.trim().length > 0
    || accountMatchStrategyFilter.value.length > 0
    || accountDepartmentFilter.value.length > 0
  ) {
    return null
  }

  if (
    accountStatusFilter.value === 'all'
    && accountDingtalkAuthFilter.value === 'all'
    && accountBindingFilter.value === 'all'
  ) {
    return 'all'
  }

  if (
    accountStatusFilter.value === 'pending'
    && accountDingtalkAuthFilter.value === 'all'
    && accountBindingFilter.value === 'all'
  ) {
    return 'pending'
  }

  if (
    accountStatusFilter.value === 'all'
    && accountDingtalkAuthFilter.value === 'all'
    && accountBindingFilter.value === 'bound'
  ) {
    return 'bound'
  }

  if (
    accountStatusFilter.value === 'all'
    && accountDingtalkAuthFilter.value === 'disabled'
    && accountBindingFilter.value === 'all'
  ) {
    return 'dingtalk-disabled'
  }

  return null
})
const latestRun = computed(() => runs.value[0] || null)
const recentUnacknowledgedDirectorySyncAlerts = computed(() =>
  directorySyncAlerts.value.filter((item) => !item.acknowledgedAt).slice(0, 5),
)
const directoryScheduleStatusSummary = computed(() => {
  const status = directoryScheduleStatus.value
  if (!status) {
    return ''
  }
  const segments = [status.syncEnabled ? '计划同步已启用' : '计划同步未启用']
  if (status.nextRunAt) {
    segments.push(`下次 ${status.nextRunAt}`)
  } else if (status.scheduleCron) {
    segments.push(`Cron ${status.scheduleCron}`)
  } else {
    segments.push('未设置 Cron')
  }
  if (status.lastRunStatus) {
    segments.push(`最近 ${statusLabel(status.lastRunStatus)}`)
  }
  return segments.join(' · ')
})
const directoryTemplateCenterSyncSummary = computed(() => {
  if (!selectedIntegrationId.value) {
    return ''
  }
  if (directoryTemplateCenterSaving.value) {
    return '服务端模板中心同步中'
  }
  if (directoryTemplateCenterSyncError.value) {
    return `服务端模板中心同步失败：${directoryTemplateCenterSyncError.value}`
  }
  if (directoryTemplateCenter.value?.updatedAt) {
    const updatedBy = directoryTemplateCenter.value.updatedBy ? ` · 更新人 ${directoryTemplateCenter.value.updatedBy}` : ''
    return `服务端模板中心已同步 · ${directoryTemplateCenter.value.updatedAt}${updatedBy}`
  }
  if (directoryTemplateCenterLoaded.value) {
    return '服务端模板中心已加载'
  }
  return ''
})
const directoryTemplateGovernanceTagSummary = computed(() =>
  (directoryTemplateGovernanceReport.value?.tagSummary || [])
    .slice(0, 3)
    .map((item) => `${item.tag} ${item.count}`)
    .join(' · '),
)
const totalPages = computed(() => Math.max(1, accountsPageCount.value))
const filteredBatchResultHistory = computed(() => {
  if (batchHistoryFilter.value === 'failed') {
    return batchResultHistory.value.filter((item) => item.failureCount > 0)
  }
  if (batchHistoryFilter.value === 'success') {
    return batchResultHistory.value.filter((item) => item.failureCount === 0)
  }
  return batchResultHistory.value
})

watch(activeBatchFailureReasonGroup, (group) => {
  if (!group) {
    return
  }

  const defaultHandlingGroupKey = defaultBatchFailureReasonHandlingGroup(group)
  const defaultHandlingGroup = resolveBatchFailureReasonHandlingGroup(group, defaultHandlingGroupKey)
  const storedPreference = getStoredBatchFailureReasonNotePreference(activeBatchFailureReasonNoteOutputMode.value)
  const teamTemplate = batchFailureReasonTeamTemplates.value[activeBatchFailureReasonNoteOutputMode.value] || null
  const hasAnyNoteDraft = Object.keys(batchFailureReasonNoteDrafts.value).length > 0

  if (!batchFailureReasonNoteDrafts.value[group.message]) {
    batchFailureReasonNoteDrafts.value = {
      ...batchFailureReasonNoteDrafts.value,
      [group.message]: !hasAnyNoteDraft && storedPreference
        ? createPreferredBatchFailureReasonNoteContext(group)
        : teamTemplate
          ? {
              owner: teamTemplate.owner,
              deadline: teamTemplate.deadline,
              channel: teamTemplate.channel,
              extra: teamTemplate.extra,
            }
          : defaultHandlingGroup.context,
    }
  }
  if (!batchFailureReasonNoteSnippetDrafts.value[group.message]) {
    batchFailureReasonNoteSnippetDrafts.value = {
      ...batchFailureReasonNoteSnippetDrafts.value,
      [group.message]: !hasAnyNoteDraft && storedPreference
        ? storedPreference.snippetKeys
        : teamTemplate?.snippetKeys || defaultHandlingGroup.snippetKeys,
    }
  }
  if (!batchFailureReasonHandlingGroupDrafts.value[group.message]) {
    batchFailureReasonHandlingGroupDrafts.value = {
      ...batchFailureReasonHandlingGroupDrafts.value,
      [group.message]: teamTemplate?.handlingGroupKey || defaultHandlingGroupKey,
    }
  }
})

watch(batchFailureReasonTeamTemplateCodeInput, () => {
  batchFailureReasonTeamTemplateIgnoredFieldKeys.value = []
})

watch(activeBatchFailureReasonTeamTemplateImportPresetList, (presets) => {
  if (presets.some((item) => item.id === selectedBatchFailureReasonTeamTemplateImportPresetId.value)) {
    return
  }
  selectedBatchFailureReasonTeamTemplateImportPresetId.value = presets[0]?.id || ''
}, { immediate: true })

watch(batchFailureReasonTeamTemplateImportPresetAvailableTags, (tags) => {
  if (!selectedBatchFailureReasonTeamTemplateImportPresetTag.value) {
    return
  }
  if (tags.includes(selectedBatchFailureReasonTeamTemplateImportPresetTag.value)) {
    return
  }
  selectedBatchFailureReasonTeamTemplateImportPresetTag.value = ''
}, { immediate: true })

watch([
  batchFailureReasonTeamTemplates,
  batchFailureReasonTeamTemplateImportHistory,
  batchFailureReasonTeamTemplateImportPresets,
], () => {
  if (directoryTemplateCenterHydrating.value) {
    return
  }
  queueDirectoryTemplateCenterSave(pendingDirectoryTemplateCenterChangeReason)
}, { deep: true })

function eventChecked(event: Event): boolean {
  return (event.target as HTMLInputElement | null)?.checked === true
}

function isBatchFailureReasonNotePresetKey(value: unknown): value is BatchFailureReasonNotePresetKey {
  return value === 'full' || value === 'brief' || value === 'admin' || value === 'ops'
}

function isBatchFailureReasonNoteOutputModeKey(value: unknown): value is BatchFailureReasonNoteOutputModeKey {
  return value === 'plain' || value === 'ticket' || value === 'im'
}

function isBatchFailureReasonNoteSnippetKey(value: unknown): value is BatchFailureReasonNoteSnippetKey {
  return value === 'notify-retry' || value === 'fill-result' || value === 'escalate-admin'
}

function isBatchFailureReasonHandlingGroupKey(value: unknown): value is BatchFailureReasonHandlingGroupKey {
  return value === 'recommended'
    || value === 'ticket-duty'
    || value === 'ops-handoff'
    || value === 'admin-escalation'
    || value === 'im-notify'
}

function isBatchFailureReasonTeamTemplateFieldKey(value: unknown): value is BatchFailureReasonTeamTemplateFieldKey {
  return value === 'preset'
    || value === 'handlingGroupKey'
    || value === 'owner'
    || value === 'deadline'
    || value === 'channel'
    || value === 'extra'
    || value === 'snippetKeys'
}

function isDeprovisionPolicyAction(value: unknown): value is DeprovisionPolicyAction {
  return value === 'mark_inactive' || value === 'disable_dingtalk_auth' || value === 'disable_local_user'
}

function copyPolicies(value: DeprovisionPolicy | null | undefined, fallback: DeprovisionPolicy = []): DeprovisionPolicy {
  return Array.isArray(value) ? [...value] : [...fallback]
}

function normalizePolicies(value: unknown): DeprovisionPolicy | null {
  if (value === null) return null
  if (Array.isArray(value)) {
    return Array.from(new Set(value.filter(isDeprovisionPolicyAction)))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (isDeprovisionPolicyAction(trimmed)) return [trimmed]
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return Array.from(new Set(parsed.filter(isDeprovisionPolicyAction)))
      }
    } catch {
      return null
    }
  }
  return null
}

function hasPolicy(policies: DeprovisionPolicy | null | undefined, policy: DeprovisionPolicyAction): boolean {
  return Array.isArray(policies) && policies.includes(policy)
}

function togglePolicy(policies: DeprovisionPolicy, policy: DeprovisionPolicyAction, enabled: boolean): DeprovisionPolicy {
  const next = new Set(policies)
  if (enabled) {
    next.add(policy)
  } else {
    next.delete(policy)
  }
  return policyOptions
    .map((option) => option.value)
    .filter((value): value is DeprovisionPolicyAction => next.has(value))
}

function samePolicies(left: DeprovisionPolicy | null | undefined, right: DeprovisionPolicy | null | undefined): boolean {
  const leftNormalized = copyPolicies(left, [])
  const rightNormalized = copyPolicies(right, [])
  return leftNormalized.length === rightNormalized.length
    && leftNormalized.every((value, index) => value === rightNormalized[index])
}

function buildBatchRecommendations(contexts: BatchFailureContext[]): BatchRecommendationGroup[] {
  const failedAuthorizeAccounts = contexts
    .filter(({ account }) => account && account.linkStatus === 'linked' && !account.dingtalkAuthEnabled)
    .map(({ account }) => account as DirectoryAccount)
  const failedProvisionAccounts = contexts
    .filter(({ failure, account }) => {
      if (!account || account.linkStatus === 'linked') {
        return false
      }
      if (!account.email) {
        return true
      }
      const message = failure.message
      return message.includes('多个 MetaSheet 账号') || message.includes('人工处理')
    })
    .map(({ account }) => account as DirectoryAccount)
  const failedProvisionIds = new Set(failedProvisionAccounts.map((item) => item.id))
  const failedAutoLinkAccounts = contexts
    .filter(({ account }) =>
      account
      && account.linkStatus !== 'linked'
      && Boolean(account.email)
      && !failedProvisionIds.has(account.id),
    )
    .map(({ account }) => account as DirectoryAccount)

  const groups: BatchRecommendationGroup[] = []
  if (failedAutoLinkAccounts.length > 0) {
    groups.push({
      key: 'auto-link',
      label: '推荐：按邮箱批量关联',
      accounts: failedAutoLinkAccounts,
    })
  }
  if (failedProvisionAccounts.length > 0) {
    groups.push({
      key: 'provision-authorize',
      label: '推荐：批量开通并授权',
      accounts: failedProvisionAccounts,
    })
  }
  if (failedAuthorizeAccounts.length > 0) {
    groups.push({
      key: 'authorize-dingtalk',
      label: '推荐：批量授权钉钉',
      accounts: failedAuthorizeAccounts,
    })
  }
  return groups
}

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
  if (tone !== 'error') {
    statusPermissionHint.value = null
  }
}

function defaultBatchFailureReasonNotePreferenceStore(): BatchFailureReasonNotePreferenceStore {
  return {
    lastOutputMode: 'plain',
    byOutputMode: {},
  }
}

function normalizeBatchFailureReasonNotePreference(value: unknown): BatchFailureReasonNotePreference | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (!isBatchFailureReasonNotePresetKey(record.preset)) {
    return null
  }
  return {
    preset: record.preset,
    owner: typeof record.owner === 'string' ? record.owner.trim() : '',
    deadline: typeof record.deadline === 'string' ? record.deadline.trim() : '',
    channel: typeof record.channel === 'string' ? record.channel.trim() : '',
    snippetKeys: Array.isArray(record.snippetKeys)
      ? record.snippetKeys.filter(isBatchFailureReasonNoteSnippetKey)
      : [],
  }
}

function normalizeBatchFailureReasonTeamTemplate(value: unknown): BatchFailureReasonTeamTemplate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (!isBatchFailureReasonNotePresetKey(record.preset)) {
    return null
  }
  if (!isBatchFailureReasonHandlingGroupKey(record.handlingGroupKey)) {
    return null
  }
  return {
    preset: record.preset,
    handlingGroupKey: record.handlingGroupKey,
    owner: typeof record.owner === 'string' ? record.owner.trim() : '',
    deadline: typeof record.deadline === 'string' ? record.deadline.trim() : '',
    channel: typeof record.channel === 'string' ? record.channel.trim() : '',
    extra: typeof record.extra === 'string' ? record.extra.trim() : '',
    snippetKeys: Array.isArray(record.snippetKeys)
      ? record.snippetKeys.filter(isBatchFailureReasonNoteSnippetKey)
      : [],
    savedAt: typeof record.savedAt === 'string' ? record.savedAt.trim() : '',
  }
}

function normalizeBatchFailureReasonTeamTemplateImportSource(
  value: unknown,
): BatchFailureReasonTeamTemplateImportSource | null {
  if (value === 'code' || value === 'json') {
    return value
  }
  return null
}

function normalizeBatchFailureReasonTeamTemplateImportHistoryItem(
  value: unknown,
): BatchFailureReasonTeamTemplateImportHistoryItem | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.trim()) {
    return null
  }
  if (!isBatchFailureReasonNoteOutputModeKey(record.outputMode)) {
    return null
  }
  const source = normalizeBatchFailureReasonTeamTemplateImportSource(record.source)
  if (!source) {
    return null
  }
  const importedTemplate = normalizeBatchFailureReasonTeamTemplate(record.importedTemplate)
  if (!importedTemplate) {
    return null
  }
  const previousTemplate = record.previousTemplate === null
    ? null
    : normalizeBatchFailureReasonTeamTemplate(record.previousTemplate)
  if (record.previousTemplate !== null && !previousTemplate) {
    return null
  }
  const previousPreference = record.previousPreference === null
    ? null
    : normalizeBatchFailureReasonNotePreference(record.previousPreference)
  if (record.previousPreference !== null && !previousPreference) {
    return null
  }
  const previousActiveTemplate = record.previousActiveTemplate === null
    ? null
    : normalizeBatchFailureReasonTeamTemplate(record.previousActiveTemplate)
  if (record.previousActiveTemplate !== null && !previousActiveTemplate) {
    return null
  }
  const ignoredFieldKeys = Array.isArray(record.ignoredFieldKeys)
    ? record.ignoredFieldKeys.filter(isBatchFailureReasonTeamTemplateFieldKey)
    : []

  return {
    id: record.id.trim(),
    importedAt: typeof record.importedAt === 'string' ? record.importedAt.trim() : '',
    outputMode: record.outputMode,
    source,
    appliedImmediately: record.appliedImmediately === true,
    importedTemplate,
    previousTemplate,
    previousPreference,
    previousActiveTemplate,
    ignoredFieldKeys,
    rolledBackAt: typeof record.rolledBackAt === 'string' ? record.rolledBackAt.trim() : '',
  }
}

function normalizeBatchFailureReasonTeamTemplateImportPreset(
  value: unknown,
): BatchFailureReasonTeamTemplateImportPreset | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const ignoredFieldKeys = Array.isArray(record.ignoredFieldKeys)
    ? record.ignoredFieldKeys.filter(isBatchFailureReasonTeamTemplateFieldKey)
    : []
  const suggestedName = describeBatchFailureReasonTeamTemplateIgnoredFields(ignoredFieldKeys)
  return {
    id: typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : createBatchFailureReasonTeamTemplateImportPresetId(),
    name: typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : suggestedName,
    tags: normalizeBatchFailureReasonTeamTemplateImportPresetTags(record.tags),
    favorite: record.favorite === true,
    pinned: record.pinned === true,
    lockedOrder: typeof record.lockedOrder === 'number' && Number.isFinite(record.lockedOrder)
      ? record.lockedOrder
      : 0,
    useCount: typeof record.useCount === 'number' && Number.isFinite(record.useCount)
      ? Math.max(0, Math.trunc(record.useCount))
      : 0,
    ignoredFieldKeys,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt.trim() : formatDateTime(new Date().toISOString()),
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : typeof record.savedAt === 'string' && record.savedAt.trim()
        ? record.savedAt.trim()
        : formatDateTime(new Date().toISOString()),
    lastUsedAt: typeof record.lastUsedAt === 'string' && record.lastUsedAt.trim()
      ? record.lastUsedAt.trim()
      : '',
  }
}

function createBatchFailureReasonTeamTemplateImportPresetId(): string {
  return `batch-failure-import-preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeBatchFailureReasonTeamTemplateImportPresetTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const tags = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
  return Array.from(new Set(tags)).slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_TAG_LIMIT)
}

function defaultBatchFailureReasonTeamTemplateImportPresetPreference(): BatchFailureReasonTeamTemplateImportPresetPreference {
  return {
    lockRecentUsageOrder: false,
  }
}

function normalizeBatchFailureReasonTeamTemplateImportPresetPreference(
  value: unknown,
): BatchFailureReasonTeamTemplateImportPresetPreference {
  if (!value || typeof value !== 'object') {
    return defaultBatchFailureReasonTeamTemplateImportPresetPreference()
  }
  const record = value as Record<string, unknown>
  return {
    lockRecentUsageOrder: record.lockRecentUsageOrder === true,
  }
}

function normalizeBatchFailureReasonTeamTemplateCodePayload(
  value: unknown,
): BatchFailureReasonTeamTemplateCodePayload | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) {
    return null
  }
  if (!isBatchFailureReasonNoteOutputModeKey(record.outputMode)) {
    return null
  }
  const template = normalizeBatchFailureReasonTeamTemplate(record.template)
  if (!template) {
    return null
  }
  return {
    version: 1,
    outputMode: record.outputMode,
    template,
  }
}

function encodeBatchFailureReasonTeamTemplateCode(payload: BatchFailureReasonTeamTemplateCodePayload): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `${BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX}${globalThis.btoa(binary)}`
}

function decodeBatchFailureReasonTeamTemplateCode(raw: string): BatchFailureReasonTeamTemplateCodePayload | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsedDirect = normalizeBatchFailureReasonTeamTemplateCodePayload(JSON.parse(trimmed) as unknown)
    if (parsedDirect) {
      return parsedDirect
    }
  } catch {
    // Ignore direct JSON parse errors and continue with prefixed code decode.
  }

  if (!trimmed.startsWith(BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX)) {
    return null
  }

  try {
    const encoded = trimmed.slice(BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX.length)
    const binary = globalThis.atob(encoded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const json = new TextDecoder().decode(bytes)
    return normalizeBatchFailureReasonTeamTemplateCodePayload(JSON.parse(json) as unknown)
  } catch {
    return null
  }
}

function loadBatchFailureReasonNotePreferences(): BatchFailureReasonNotePreferenceStore {
  if (typeof localStorage === 'undefined') {
    return defaultBatchFailureReasonNotePreferenceStore()
  }

  try {
    const raw = localStorage.getItem(BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY)
    if (!raw) {
      return defaultBatchFailureReasonNotePreferenceStore()
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const byOutputMode: BatchFailureReasonNotePreferenceStore['byOutputMode'] = {}
    const rawByOutputMode = parsed.byOutputMode
    if (rawByOutputMode && typeof rawByOutputMode === 'object') {
      for (const outputMode of batchFailureReasonNoteOutputModes.map((item) => item.key)) {
        const normalized = normalizeBatchFailureReasonNotePreference(
          (rawByOutputMode as Record<string, unknown>)[outputMode],
        )
        if (normalized) {
          byOutputMode[outputMode] = normalized
        }
      }
    }

    return {
      lastOutputMode: isBatchFailureReasonNoteOutputModeKey(parsed.lastOutputMode) ? parsed.lastOutputMode : 'plain',
      byOutputMode,
    }
  } catch {
    return defaultBatchFailureReasonNotePreferenceStore()
  }
}

function persistBatchFailureReasonNotePreferences(): void {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    localStorage.setItem(
      BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY,
      JSON.stringify(batchFailureReasonNotePreferences.value),
    )
  } catch {
    // Ignore preference persistence failures and keep the UI usable.
  }
}

function loadBatchFailureReasonTeamTemplates(): BatchFailureReasonTeamTemplateStore {
  if (typeof localStorage === 'undefined') {
    return {}
  }

  try {
    const raw = localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const result: BatchFailureReasonTeamTemplateStore = {}
    for (const outputMode of batchFailureReasonNoteOutputModes.map((item) => item.key)) {
      const normalized = normalizeBatchFailureReasonTeamTemplate(parsed[outputMode])
      if (normalized) {
        result[outputMode] = normalized
      }
    }
    return result
  } catch {
    return {}
  }
}

function persistBatchFailureReasonTeamTemplates(): void {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify(batchFailureReasonTeamTemplates.value),
    )
  } catch {
    // Ignore persistence failures and keep local editing usable.
  }
}

function loadBatchFailureReasonTeamTemplateImportHistory(): BatchFailureReasonTeamTemplateImportHistory {
  if (typeof localStorage === 'undefined') {
    return []
  }

  try {
    const raw = localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map((item) => normalizeBatchFailureReasonTeamTemplateImportHistoryItem(item))
      .filter((item): item is BatchFailureReasonTeamTemplateImportHistoryItem => Boolean(item))
      .slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

function persistBatchFailureReasonTeamTemplateImportHistory(): void {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_STORAGE_KEY,
      JSON.stringify(batchFailureReasonTeamTemplateImportHistory.value.slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_LIMIT)),
    )
  } catch {
    // Ignore persistence failures and keep local editing usable.
  }
}

function loadBatchFailureReasonTeamTemplateImportPresets(): BatchFailureReasonTeamTemplateImportPresetStore {
  if (typeof localStorage === 'undefined') {
    return {}
  }

  try {
    const raw = localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const result: BatchFailureReasonTeamTemplateImportPresetStore = {}
    for (const outputMode of batchFailureReasonNoteOutputModes.map((item) => item.key)) {
      const value = parsed[outputMode]
      const normalized = Array.isArray(value)
        ? value
          .map((item) => normalizeBatchFailureReasonTeamTemplateImportPreset(item))
          .filter((item): item is BatchFailureReasonTeamTemplateImportPreset => Boolean(item))
          .slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_LIMIT)
        : (() => {
            const legacyPreset = normalizeBatchFailureReasonTeamTemplateImportPreset(value)
            return legacyPreset ? [legacyPreset] : []
          })()
      if (normalized.length > 0) {
        result[outputMode] = normalized
      }
    }
    return result
  } catch {
    return {}
  }
}

function loadBatchFailureReasonTeamTemplateImportPresetPreference(): BatchFailureReasonTeamTemplateImportPresetPreference {
  if (typeof localStorage === 'undefined') {
    return defaultBatchFailureReasonTeamTemplateImportPresetPreference()
  }

  try {
    const raw = localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_PREFERENCES_STORAGE_KEY)
    if (!raw) {
      return defaultBatchFailureReasonTeamTemplateImportPresetPreference()
    }
    return normalizeBatchFailureReasonTeamTemplateImportPresetPreference(JSON.parse(raw))
  } catch {
    return defaultBatchFailureReasonTeamTemplateImportPresetPreference()
  }
}

function persistBatchFailureReasonTeamTemplateImportPresets(): void {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(batchFailureReasonTeamTemplateImportPresets.value).map(([outputMode, presets]) => [
            outputMode,
            presets.slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_LIMIT),
          ]),
        ),
      ),
    )
  } catch {
    // Ignore persistence failures and keep local editing usable.
  }
}

function persistBatchFailureReasonTeamTemplateImportPresetPreference(): void {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_PREFERENCES_STORAGE_KEY,
      JSON.stringify(batchFailureReasonTeamTemplateImportPresetPreference.value),
    )
  } catch {
    // Ignore persistence failures and keep local editing usable.
  }
}

function summarizeBatchFailureReasonTeamTemplate(template: BatchFailureReasonTeamTemplate): string {
  const handlingGroupLabel = batchFailureReasonHandlingGroups.find((item) => item.key === template.handlingGroupKey)?.label || template.handlingGroupKey
  const presetLabel = batchFailureReasonNotePresets.find((item) => item.key === template.preset)?.label || template.preset
  const snippetLabels = template.snippetKeys
    .map((key) => batchFailureReasonNoteSnippets.find((item) => item.key === key)?.label || key)
    .filter((label) => label.length > 0)
  const segments = [`处理组 ${handlingGroupLabel}`, `模板 ${presetLabel}`]
  if (template.owner) {
    segments.push(`负责人 ${template.owner}`)
  }
  if (template.deadline) {
    segments.push(`截止 ${template.deadline}`)
  }
  if (template.channel) {
    segments.push(`渠道 ${template.channel}`)
  }
  if (snippetLabels.length > 0) {
    segments.push(`补充语 ${snippetLabels.join(' / ')}`)
  }
  return segments.join(' · ')
}

function batchFailureReasonTeamTemplateFieldLabel(key: BatchFailureReasonTeamTemplateFieldKey): string {
  switch (key) {
    case 'preset':
      return '内容模板'
    case 'handlingGroupKey':
      return '处理组'
    case 'owner':
      return '处理负责人'
    case 'deadline':
      return '截止时间'
    case 'channel':
      return '同步渠道'
    case 'extra':
      return '补充说明'
    case 'snippetKeys':
      return '快捷补充语'
    default:
      return key
  }
}

function describeBatchFailureReasonTeamTemplateIgnoredFields(
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[],
): string {
  const labels = ignoredFieldKeys
    .map((key) => batchFailureReasonTeamTemplateFieldLabel(key))
    .filter((label) => label.length > 0)
  if (labels.length === 0) {
    return '全量导入'
  }
  return `保留${labels.join(' / ')}`
}

function batchFailureReasonTeamTemplateImportPresetSortTimestamp(
  preset: BatchFailureReasonTeamTemplateImportPreset,
  lockRecentUsageOrder: boolean,
): number {
  const value = lockRecentUsageOrder
    ? ''
    : preset.lastUsedAt || preset.updatedAt || preset.savedAt
  const parsed = Date.parse(value.replace(/\//g, '-'))
  return Number.isFinite(parsed) ? parsed : 0
}

function sortBatchFailureReasonTeamTemplateImportPresets(
  presets: BatchFailureReasonTeamTemplateImportPreset[],
  lockRecentUsageOrder: boolean,
): BatchFailureReasonTeamTemplateImportPreset[] {
  return [...presets].sort((left, right) =>
    Number(right.pinned) - Number(left.pinned)
    || Number(right.favorite) - Number(left.favorite)
    || (lockRecentUsageOrder
      ? left.lockedOrder - right.lockedOrder
      : batchFailureReasonTeamTemplateImportPresetSortTimestamp(right, false) - batchFailureReasonTeamTemplateImportPresetSortTimestamp(left, false))
    || left.name.localeCompare(right.name, 'zh-CN'),
  )
}

function assignBatchFailureReasonTeamTemplateImportPresetLockedOrder(
  presets: BatchFailureReasonTeamTemplateImportPreset[],
): BatchFailureReasonTeamTemplateImportPreset[] {
  return sortBatchFailureReasonTeamTemplateImportPresets(presets, false).map((preset, index) => ({
    ...preset,
    lockedOrder: index,
  }))
}

function batchFailureReasonTeamTemplateImportPresetStateLabels(
  preset: BatchFailureReasonTeamTemplateImportPreset,
): string[] {
  const labels: string[] = []
  if (preset.pinned) {
    labels.push('置顶')
  }
  if (preset.favorite) {
    labels.push('收藏')
  }
  return labels
}

function batchFailureReasonTeamTemplateImportPresetButtonLabel(
  preset: BatchFailureReasonTeamTemplateImportPreset,
): string {
  const stateLabels = batchFailureReasonTeamTemplateImportPresetStateLabels(preset)
  const segments = [...stateLabels, preset.name]
  if (preset.useCount > 0) {
    segments.push(`使用 ${preset.useCount} 次`)
  }
  if (preset.tags.length > 0) {
    segments.push(preset.tags.join(' / '))
  }
  return segments.join(' · ')
}

function parseBatchFailureReasonTeamTemplateImportPresetTagsInput(value: string): string[] {
  const normalized = value
    .split(/[,\n，、]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Array.from(new Set(normalized)).slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_TAG_LIMIT)
}

function sameBatchFailureReasonTeamTemplateIgnoredFieldKeys(
  left: BatchFailureReasonTeamTemplateFieldKey[],
  right: BatchFailureReasonTeamTemplateFieldKey[],
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}

function batchFailureReasonTeamTemplateFieldValue(
  template: BatchFailureReasonTeamTemplate,
  key: BatchFailureReasonTeamTemplateFieldKey,
): string {
  switch (key) {
    case 'preset':
      return batchFailureReasonNotePresets.find((item) => item.key === template.preset)?.label || template.preset
    case 'handlingGroupKey':
      return batchFailureReasonHandlingGroups.find((item) => item.key === template.handlingGroupKey)?.label || template.handlingGroupKey
    case 'owner':
      return template.owner || '未设置'
    case 'deadline':
      return template.deadline || '未设置'
    case 'channel':
      return template.channel || '未设置'
    case 'extra': {
      const lines = batchFailureReasonNoteExtraLines(template.extra)
      return lines.length > 0 ? lines.join('；') : '未设置'
    }
    case 'snippetKeys': {
      const labels = template.snippetKeys
        .map((snippetKey) => batchFailureReasonNoteSnippets.find((item) => item.key === snippetKey)?.label || snippetKey)
        .filter((label) => label.length > 0)
      return labels.length > 0 ? labels.join(' / ') : '未设置'
    }
    default:
      return '未设置'
  }
}

function canIgnoreBatchFailureReasonTeamTemplateField(
  previousTemplate: BatchFailureReasonTeamTemplate | null,
  key: BatchFailureReasonTeamTemplateFieldKey,
): boolean {
  if (previousTemplate) {
    return true
  }
  return key !== 'preset' && key !== 'handlingGroupKey'
}

function applyIgnoredBatchFailureReasonTeamTemplateFields(
  previousTemplate: BatchFailureReasonTeamTemplate | null,
  importedTemplate: BatchFailureReasonTeamTemplate,
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[],
): BatchFailureReasonTeamTemplate {
  const ignored = new Set(ignoredFieldKeys)
  return {
    preset: ignored.has('preset') && previousTemplate ? previousTemplate.preset : importedTemplate.preset,
    handlingGroupKey: ignored.has('handlingGroupKey') && previousTemplate
      ? previousTemplate.handlingGroupKey
      : importedTemplate.handlingGroupKey,
    owner: ignored.has('owner') ? previousTemplate?.owner || '' : importedTemplate.owner,
    deadline: ignored.has('deadline') ? previousTemplate?.deadline || '' : importedTemplate.deadline,
    channel: ignored.has('channel') ? previousTemplate?.channel || '' : importedTemplate.channel,
    extra: ignored.has('extra') ? previousTemplate?.extra || '' : importedTemplate.extra,
    snippetKeys: ignored.has('snippetKeys')
      ? [...(previousTemplate?.snippetKeys || [])]
      : [...importedTemplate.snippetKeys],
    savedAt: importedTemplate.savedAt,
  }
}

function buildBatchFailureReasonTeamTemplateDiffEntries(
  before: BatchFailureReasonTeamTemplate | null,
  after: BatchFailureReasonTeamTemplate,
): BatchFailureReasonTeamTemplateDiffEntry[] {
  const fields: BatchFailureReasonTeamTemplateFieldKey[] = ['preset', 'handlingGroupKey', 'owner', 'deadline', 'channel', 'extra', 'snippetKeys']
  const entries: BatchFailureReasonTeamTemplateDiffEntry[] = []

  for (const field of fields) {
    const afterValue = batchFailureReasonTeamTemplateFieldValue(after, field)
    if (!before) {
      if (afterValue === '未设置') {
        continue
      }
      entries.push({
        key: field,
        label: batchFailureReasonTeamTemplateFieldLabel(field),
        before: '未设置',
        after: afterValue,
        mode: 'added',
      })
      continue
    }

    const beforeValue = batchFailureReasonTeamTemplateFieldValue(before, field)
    if (beforeValue === afterValue) {
      continue
    }
    entries.push({
      key: field,
      label: batchFailureReasonTeamTemplateFieldLabel(field),
      before: beforeValue,
      after: afterValue,
      mode: beforeValue === '未设置' ? 'added' : afterValue === '未设置' ? 'removed' : 'changed',
    })
  }

  return entries
}

function buildBatchFailureReasonTeamTemplateDiffSummary(
  before: BatchFailureReasonTeamTemplate | null,
  after: BatchFailureReasonTeamTemplate,
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[] = [],
): string {
  const entries = buildBatchFailureReasonTeamTemplateDiffEntries(before, after)
  const ignoredCount = ignoredFieldKeys.length
  if (entries.length === 0) {
    return ignoredCount > 0 ? `与导入前一致，已忽略 ${ignoredCount} 项` : '与导入前一致'
  }
  if (!before) {
    return ignoredCount > 0 ? `将新增 ${entries.length} 个字段，已忽略 ${ignoredCount} 项` : `将新增 ${entries.length} 个字段`
  }
  return ignoredCount > 0 ? `变更字段 ${entries.length} 项，已忽略 ${ignoredCount} 项` : `变更字段 ${entries.length} 项`
}

function getStoredBatchFailureReasonNotePreference(
  outputMode: BatchFailureReasonNoteOutputModeKey,
): BatchFailureReasonNotePreference | null {
  return batchFailureReasonNotePreferences.value.byOutputMode[outputMode] || null
}

function preferredBatchFailureReasonNotePreset(
  group: BatchFailureReasonGroup,
  outputMode: BatchFailureReasonNoteOutputModeKey = activeBatchFailureReasonNoteOutputMode.value,
): BatchFailureReasonNotePresetKey {
  return getStoredBatchFailureReasonNotePreference(outputMode)?.preset
    || batchFailureReasonTeamTemplates.value[outputMode]?.preset
    || defaultBatchFailureReasonNotePreset(group)
}

function rememberActiveBatchFailureReasonNotePreference(options?: {
  outputMode?: BatchFailureReasonNoteOutputModeKey
  snippetKeys?: BatchFailureReasonNoteSnippetKey[]
}): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return
  }
  const outputMode = options?.outputMode || activeBatchFailureReasonNoteOutputMode.value
  const existingPreference = getStoredBatchFailureReasonNotePreference(outputMode)

  batchFailureReasonNotePreferences.value = {
    lastOutputMode: outputMode,
    byOutputMode: {
      ...batchFailureReasonNotePreferences.value.byOutputMode,
      [outputMode]: {
        preset: activeBatchFailureReasonNotePreset.value,
        owner: activeBatchFailureReasonNoteContext.value.owner,
        deadline: activeBatchFailureReasonNoteContext.value.deadline,
        channel: activeBatchFailureReasonNoteContext.value.channel,
        snippetKeys: options?.snippetKeys || existingPreference?.snippetKeys || [],
      },
    },
  }
  persistBatchFailureReasonNotePreferences()
}

function createBatchFailureReasonNoteContext(group: BatchFailureReasonGroup): BatchFailureReasonNoteContext {
  return {
    owner: defaultBatchFailureReasonNoteOwner(group),
    deadline: defaultBatchFailureReasonNoteDeadline(group),
    channel: defaultBatchFailureReasonNoteChannel(group),
    extra: defaultBatchFailureReasonNoteExtra(group),
  }
}

function createPreferredBatchFailureReasonNoteContext(group: BatchFailureReasonGroup): BatchFailureReasonNoteContext {
  const storedPreference = getStoredBatchFailureReasonNotePreference(activeBatchFailureReasonNoteOutputMode.value)
  return {
    owner: storedPreference?.owner || defaultBatchFailureReasonNoteOwner(group),
    deadline: storedPreference?.deadline || defaultBatchFailureReasonNoteDeadline(group),
    channel: storedPreference?.channel || defaultBatchFailureReasonNoteChannel(group),
    extra: applyBatchFailureReasonNoteSnippets(
      defaultBatchFailureReasonNoteExtra(group),
      storedPreference?.snippetKeys || [],
    ),
  }
}

function resetBatchFailureReasonNoteContext(): void {
  batchFailureReasonNoteDrafts.value = {}
  batchFailureReasonNoteSnippetDrafts.value = {}
  batchFailureReasonHandlingGroupDrafts.value = {}
}

function resetBatchFailureReasonNoteOutputMode(): void {
  activeBatchFailureReasonNoteOutputMode.value = batchFailureReasonNotePreferences.value.lastOutputMode
}

function resetBatchFailureReasonNotePreset(): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    activeBatchFailureReasonNotePreset.value = 'full'
    return
  }
  activeBatchFailureReasonNotePreset.value = preferredBatchFailureReasonNotePreset(group)
}

function updateActiveBatchFailureReasonNoteContext(
  key: keyof BatchFailureReasonNoteContext,
  value: string,
): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return
  }

  const current = batchFailureReasonNoteDrafts.value[group.message] || createPreferredBatchFailureReasonNoteContext(group)
  batchFailureReasonNoteDrafts.value = {
    ...batchFailureReasonNoteDrafts.value,
    [group.message]: {
      ...current,
      [key]: value,
    },
  }
  if (key !== 'extra') {
    rememberActiveBatchFailureReasonNotePreference()
  }
}

function restoreActiveBatchFailureReasonNoteContext(): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  const defaultHandlingGroupKey = defaultBatchFailureReasonHandlingGroup(group)
  const defaultHandlingGroup = resolveBatchFailureReasonHandlingGroup(group, defaultHandlingGroupKey)

  batchFailureReasonNoteDrafts.value = {
    ...batchFailureReasonNoteDrafts.value,
    [group.message]: defaultHandlingGroup.context,
  }
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: defaultHandlingGroup.snippetKeys,
  }
  batchFailureReasonHandlingGroupDrafts.value = {
    ...batchFailureReasonHandlingGroupDrafts.value,
    [group.message]: defaultHandlingGroupKey,
  }
  setStatus(`已恢复失败原因“${group.message}”的推荐备注字段`)
}

function restoreRememberedBatchFailureReasonNoteContext(): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  const storedPreference = getStoredBatchFailureReasonNotePreference(activeBatchFailureReasonNoteOutputMode.value)
  if (!storedPreference) {
    setStatus(`当前输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”还没有已记住的上次偏好。`, 'error')
    return
  }

  activeBatchFailureReasonNotePreset.value = storedPreference.preset
  batchFailureReasonNoteDrafts.value = {
    ...batchFailureReasonNoteDrafts.value,
    [group.message]: createPreferredBatchFailureReasonNoteContext(group),
  }
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: storedPreference.snippetKeys,
  }
  batchFailureReasonHandlingGroupDrafts.value = {
    ...batchFailureReasonHandlingGroupDrafts.value,
    [group.message]: batchFailureReasonHandlingGroupDrafts.value[group.message] || defaultBatchFailureReasonHandlingGroup(group),
  }
  setStatus(`已恢复输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”的上次偏好`)
}

function restoreRememberedBatchFailureReasonNoteSnippets(): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  const storedPreference = getStoredBatchFailureReasonNotePreference(activeBatchFailureReasonNoteOutputMode.value)
  const snippetKeys = storedPreference?.snippetKeys || []
  if (snippetKeys.length === 0) {
    setStatus(`当前输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”还没有已记住的快捷补充语。`, 'error')
    return
  }

  updateActiveBatchFailureReasonNoteContext(
    'extra',
    applyBatchFailureReasonNoteSnippets(defaultBatchFailureReasonNoteExtra(group), snippetKeys),
  )
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: snippetKeys,
  }
  setStatus(`已恢复输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”的上次快捷补充语`)
}

function clearActiveBatchFailureReasonNoteExtra(): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  updateActiveBatchFailureReasonNoteContext('extra', '')
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: [],
  }
  setStatus(`已清空失败原因“${group.message}”的补充说明`)
}

function clearBatchResult(): void {
  latestBatchResult.value = null
  batchFailureFilterActive.value = false
  batchFailureReasonFilter.value = ''
  resetBatchFailureReasonNoteOutputMode()
  resetBatchFailureReasonNotePreset()
  resetBatchFailureReasonNoteContext()
}

function clearBatchHistory(): void {
  batchResultHistory.value = []
  batchHistoryFilter.value = 'all'
  setStatus('最近批量处理记录已清空')
}

function restoreBatchResult(result: BatchOperationResult): void {
  latestBatchResult.value = {
    ...result,
    failures: result.failures.map((failure) => ({ ...failure })),
  }
  batchFailureFilterActive.value = false
  batchFailureReasonFilter.value = ''
  resetBatchFailureReasonNoteOutputMode()
  resetBatchFailureReasonNotePreset()
  resetBatchFailureReasonNoteContext()
}

function toggleBatchFailureFilter(): void {
  if (!latestBatchResult.value || latestBatchResult.value.failures.length === 0) {
    return
  }

  if (batchFailureFilterActive.value) {
    batchFailureFilterActive.value = false
    batchFailureReasonFilter.value = ''
    resetBatchFailureReasonNotePreset()
    setStatus('已恢复全部成员列表')
    return
  }

  const failureIds = new Set(latestBatchResult.value.failures.map((item) => item.accountId))
  const visibleFailureIds = accounts.value
    .filter((item) => failureIds.has(item.id))
    .map((item) => item.id)
  batchFailureFilterActive.value = true
  batchFailureReasonFilter.value = ''
  resetBatchFailureReasonNotePreset()
  selectedAccountIds.value = visibleFailureIds
  selectedAccountId.value = visibleFailureIds[0] || ''
  setStatus(`已切换为失败成员视图（${visibleFailureIds.length} 项）`)
}

function toggleBatchFailureReasonFilter(message: string): void {
  const target = batchFailureReasonGroups.value.find((item) => item.message === message)
  if (!target) {
    return
  }

  if (batchFailureReasonFilter.value === message) {
    batchFailureFilterActive.value = true
    batchFailureReasonFilter.value = ''
    resetBatchFailureReasonNotePreset()
    const failureIds = accounts.value
      .filter((item) => latestBatchFailureAccountIds.value.has(item.id))
      .map((item) => item.id)
    selectedAccountIds.value = failureIds
    selectedAccountId.value = failureIds[0] || ''
    setStatus(`已恢复全部失败成员（${failureIds.length} 项）`)
    return
  }

  batchFailureFilterActive.value = true
  batchFailureReasonFilter.value = message
  activeBatchFailureReasonNotePreset.value = preferredBatchFailureReasonNotePreset(target)
  const accountIds = accounts.value
    .filter((item) => target.accountIds.includes(item.id))
    .map((item) => item.id)
  selectedAccountIds.value = accountIds
  selectedAccountId.value = accountIds[0] || ''
  setStatus(`已切换到失败原因“${message}”的成员（${accountIds.length} 项）`)
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!/[",\n]/.test(normalized)) {
    return normalized
  }
  return `"${normalized.replace(/"/g, '""')}"`
}

function buildBatchFailuresText(result: BatchOperationResult): string {
  const lines = [
    `操作,${result.label}`,
    `完成时间,${result.completedAt}`,
    `总数,${result.total}`,
    `成功,${result.successCount}`,
    `失败,${result.failureCount}`,
    '',
    '成员,失败原因',
  ]
  for (const failure of result.failures) {
    lines.push(`${failure.accountName},${failure.message}`)
  }
  return lines.join('\n')
}

function accountNoteReference(account: DirectoryAccount | null, fallbackName: string): string {
  const reference = account?.email || account?.mobile || account?.externalUserId || '无可用联系方式'
  const department = account?.departmentNames[0] || ''
  return department ? `${fallbackName}（${reference} · ${department}）` : `${fallbackName}（${reference}）`
}

function batchFailureReasonActionText(group: BatchFailureReasonGroup): string {
  return group.recommendations.length > 0
    ? group.recommendations.map((label) => label.replace(/^推荐：/, '')).join(' / ')
    : '人工处理'
}

function defaultBatchFailureReasonNotePreset(group: BatchFailureReasonGroup): BatchFailureReasonNotePresetKey {
  const actionText = batchFailureReasonActionText(group)
  if (actionText.includes('按邮箱批量关联')) {
    return 'admin'
  }
  if (actionText.includes('批量开通并授权')) {
    return 'ops'
  }
  if (actionText.includes('批量授权钉钉')) {
    return 'brief'
  }
  if (actionText === '人工处理') {
    return 'admin'
  }
  return 'full'
}

function defaultBatchFailureReasonNoteOwner(group: BatchFailureReasonGroup): string {
  const actionText = batchFailureReasonActionText(group)
  if (actionText.includes('按邮箱批量关联')) {
    return '平台管理员'
  }
  if (actionText.includes('批量开通并授权')) {
    return '运营/客服'
  }
  if (actionText.includes('批量授权钉钉')) {
    return '目录管理员'
  }
  return '平台管理员'
}

function defaultBatchFailureReasonNoteDeadline(group: BatchFailureReasonGroup): string {
  const actionText = batchFailureReasonActionText(group)
  if (actionText.includes('批量授权钉钉')) {
    return '立即处理'
  }
  if (actionText.includes('按邮箱批量关联')) {
    return '今天 18:00 前'
  }
  if (actionText.includes('批量开通并授权')) {
    return '今天内'
  }
  return '下个同步前'
}

function defaultBatchFailureReasonNoteChannel(group: BatchFailureReasonGroup): string {
  const actionText = batchFailureReasonActionText(group)
  if (actionText.includes('按邮箱批量关联')) {
    return '管理员处理群 / 工单'
  }
  if (actionText.includes('批量开通并授权')) {
    return '运营群 / 客服工单'
  }
  if (actionText.includes('批量授权钉钉')) {
    return '账号支持群'
  }
  return '管理员处理群'
}

function defaultBatchFailureReasonNoteExtra(group: BatchFailureReasonGroup): string {
  if (group.message.includes('邮箱不能为空')) {
    return '请先补齐邮箱或确认允许使用钉钉占位邮箱，再继续开户。'
  }
  if (group.message.includes('多个 MetaSheet 账号')) {
    return '请先确认应关联的本地账号，再执行关联或忽略。'
  }
  if (group.message.includes('未关联 MetaSheet 账号')) {
    return '请核对邮箱归属后执行关联，完成后通知用户重新尝试。'
  }
  if (group.message.includes('钉钉')) {
    return '处理完成后请通知用户重新扫码登录。'
  }
  return '若按建议动作后仍失败，请升级平台管理员继续核对。'
}

function defaultBatchFailureReasonHandlingGroup(_group: BatchFailureReasonGroup): BatchFailureReasonHandlingGroupKey {
  return 'recommended'
}

function resolveBatchFailureReasonHandlingGroup(
  group: BatchFailureReasonGroup,
  key: BatchFailureReasonHandlingGroupKey,
): {
  context: BatchFailureReasonNoteContext
  snippetKeys: BatchFailureReasonNoteSnippetKey[]
} {
  if (key === 'recommended') {
    return {
      context: createBatchFailureReasonNoteContext(group),
      snippetKeys: [],
    }
  }

  if (key === 'ticket-duty') {
    const snippetKeys: BatchFailureReasonNoteSnippetKey[] = ['fill-result']
    return {
      context: {
        owner: '工单值班',
        deadline: '今天 18:00 前',
        channel: '工单系统 / Jira',
        extra: applyBatchFailureReasonNoteSnippets(defaultBatchFailureReasonNoteExtra(group), snippetKeys),
      },
      snippetKeys,
    }
  }

  if (key === 'ops-handoff') {
    const snippetKeys: BatchFailureReasonNoteSnippetKey[] = ['notify-retry', 'fill-result']
    return {
      context: {
        owner: '运营/客服',
        deadline: '今天内',
        channel: '运营群 / 客服工单',
        extra: applyBatchFailureReasonNoteSnippets(defaultBatchFailureReasonNoteExtra(group), snippetKeys),
      },
      snippetKeys,
    }
  }

  if (key === 'admin-escalation') {
    const snippetKeys: BatchFailureReasonNoteSnippetKey[] = ['escalate-admin']
    return {
      context: {
        owner: '平台管理员',
        deadline: '立即处理',
        channel: '管理员处理群 / 工单',
        extra: applyBatchFailureReasonNoteSnippets(defaultBatchFailureReasonNoteExtra(group), snippetKeys),
      },
      snippetKeys,
    }
  }

  const snippetKeys: BatchFailureReasonNoteSnippetKey[] = ['notify-retry']
  return {
    context: {
      owner: '目录管理员',
      deadline: '立即处理',
      channel: '钉钉群 / IM',
      extra: applyBatchFailureReasonNoteSnippets(defaultBatchFailureReasonNoteExtra(group), snippetKeys),
    },
    snippetKeys,
  }
}

function selectBatchFailureReasonHandlingGroup(key: BatchFailureReasonHandlingGroupKey): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  const resolved = resolveBatchFailureReasonHandlingGroup(group, key)
  batchFailureReasonNoteDrafts.value = {
    ...batchFailureReasonNoteDrafts.value,
    [group.message]: resolved.context,
  }
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: resolved.snippetKeys,
  }
  batchFailureReasonHandlingGroupDrafts.value = {
    ...batchFailureReasonHandlingGroupDrafts.value,
    [group.message]: key,
  }
  rememberActiveBatchFailureReasonNotePreference({
    snippetKeys: resolved.snippetKeys,
  })
  const label = batchFailureReasonHandlingGroups.find((item) => item.key === key)?.label || key
  setStatus(`已应用处理组“${label}”`)
}

function selectBatchFailureReasonNotePreset(preset: BatchFailureReasonNotePresetKey): void {
  activeBatchFailureReasonNotePreset.value = preset
  rememberActiveBatchFailureReasonNotePreference()
}

function selectBatchFailureReasonNoteOutputMode(outputMode: BatchFailureReasonNoteOutputModeKey): void {
  activeBatchFailureReasonNoteOutputMode.value = outputMode
  batchFailureReasonNotePreferences.value = {
    ...batchFailureReasonNotePreferences.value,
    lastOutputMode: outputMode,
  }
  persistBatchFailureReasonNotePreferences()

  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return
  }

  const storedPreference = getStoredBatchFailureReasonNotePreference(outputMode)
  const teamTemplate = batchFailureReasonTeamTemplates.value[outputMode] || null
  if (storedPreference) {
    batchFailureReasonNoteDrafts.value = {
      ...batchFailureReasonNoteDrafts.value,
      [group.message]: createPreferredBatchFailureReasonNoteContext(group),
    }
    batchFailureReasonNoteSnippetDrafts.value = {
      ...batchFailureReasonNoteSnippetDrafts.value,
      [group.message]: storedPreference.snippetKeys,
    }
    activeBatchFailureReasonNotePreset.value = storedPreference.preset
    return
  }

  if (teamTemplate) {
    activeBatchFailureReasonNotePreset.value = teamTemplate.preset
    batchFailureReasonHandlingGroupDrafts.value = {
      ...batchFailureReasonHandlingGroupDrafts.value,
      [group.message]: teamTemplate.handlingGroupKey,
    }
    batchFailureReasonNoteDrafts.value = {
      ...batchFailureReasonNoteDrafts.value,
      [group.message]: {
        owner: teamTemplate.owner,
        deadline: teamTemplate.deadline,
        channel: teamTemplate.channel,
        extra: teamTemplate.extra,
      },
    }
    batchFailureReasonNoteSnippetDrafts.value = {
      ...batchFailureReasonNoteSnippetDrafts.value,
      [group.message]: [...teamTemplate.snippetKeys],
    }
    return
  }

  rememberActiveBatchFailureReasonNotePreference({
    outputMode,
    snippetKeys: batchFailureReasonNoteSnippetDrafts.value[group.message] || [],
  })
}

function buildBatchFailureReasonMemberLines(group: BatchFailureReasonGroup): string[] {
  return group.accountIds.map((accountId) => {
    const account = accounts.value.find((item) => item.id === accountId) || null
    const name = account ? accountDisplayName(account) : accountId
    return `- ${accountNoteReference(account, name)}`
  })
}

function batchFailureReasonNoteExtraLines(extra: string): string[] {
  return extra
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function applyBatchFailureReasonNoteSnippets(
  extra: string,
  snippetKeys: BatchFailureReasonNoteSnippetKey[],
): string {
  const lines = batchFailureReasonNoteExtraLines(extra)
  const next = [...lines]
  for (const key of snippetKeys) {
    const snippet = batchFailureReasonNoteSnippets.find((item) => item.key === key)
    if (!snippet || next.includes(snippet.text)) {
      continue
    }
    next.push(snippet.text)
  }
  return next.join('\n')
}

function buildBatchFailureReasonNoteContextLines(context: BatchFailureReasonNoteContext): string[] {
  const lines: string[] = []
  if (context.owner) {
    lines.push(`处理负责人：${context.owner}`)
  }
  if (context.deadline) {
    lines.push(`截止时间：${context.deadline}`)
  }
  if (context.channel) {
    lines.push(`同步渠道：${context.channel}`)
  }
  if (context.extra) {
    lines.push(`补充说明：${batchFailureReasonNoteExtraLines(context.extra).join('；')}`)
  }
  return lines
}

function buildBatchFailureReasonNoteContextSegments(context: BatchFailureReasonNoteContext): string[] {
  const segments: string[] = []
  if (context.owner) {
    segments.push(`负责人：${context.owner}`)
  }
  if (context.deadline) {
    segments.push(`截止：${context.deadline}`)
  }
  if (context.channel) {
    segments.push(`渠道：${context.channel}`)
  }
  if (context.extra) {
    segments.push(`补充：${batchFailureReasonNoteExtraLines(context.extra).join('；')}`)
  }
  return segments
}

function buildBatchFailureReasonNote(
  group: BatchFailureReasonGroup,
  preset: BatchFailureReasonNotePresetKey,
  context: BatchFailureReasonNoteContext,
): string {
  const actionText = group.recommendations.length > 0
    ? group.recommendations.map((label) => label.replace(/^推荐：/, '')).join(' / ')
    : '人工处理'
  const operationLabel = latestBatchResult.value?.label || '批量处理'
  const completedAt = latestBatchResult.value?.completedAt || formatDateTime(new Date().toISOString())
  const memberLines = buildBatchFailureReasonMemberLines(group)
  const memberInlineSummary = memberLines
    .map((line) => line.replace(/^- /, ''))
    .slice(0, 3)
    .join('、')
  const extraCount = Math.max(0, memberLines.length - 3)
  const handlingHint = group.recommendations.length > 0
    ? '可先按建议动作处理；若仍失败，再人工核对账号资料或绑定关系。'
    : '请人工核对账号资料、钉钉组织信息或授权状态后再处理。'
  const contextLines = buildBatchFailureReasonNoteContextLines(context)
  const contextSegments = buildBatchFailureReasonNoteContextSegments(context)

  if (preset === 'brief') {
    return `【目录失败】${group.message}；成员 ${group.count} 项；建议：${actionText}；请处理：${memberInlineSummary}${extraCount > 0 ? ` 等 ${group.count} 人` : ''}${contextSegments.length > 0 ? `；${contextSegments.join('；')}` : ''}。`
  }

  if (preset === 'admin') {
    return [
      '请管理员处理以下目录失败：',
      `失败原因：${group.message}`,
      `建议动作：${actionText}`,
      ...contextLines,
      '成员清单：',
      ...memberLines,
      '处理要求：完成后请通知相关用户重新尝试。',
    ].join('\n')
  }

  if (preset === 'ops') {
    return [
      '运营/客服跟进模板：',
      `本次操作：${operationLabel}`,
      `完成时间：${completedAt}`,
      `失败原因：${group.message}`,
      `建议动作：${actionText}`,
      `涉及成员：${group.count} 项`,
      ...contextLines,
      `成员摘要：${memberInlineSummary}${extraCount > 0 ? ` 等 ${group.count} 人` : ''}`,
      '处理说明：请先按建议动作跟进，处理后回填结果；若仍失败，再升级管理员。',
    ].join('\n')
  }

  return [
    `操作：${operationLabel}`,
    `完成时间：${completedAt}`,
    `失败原因：${group.message}`,
    `涉及成员：${group.count} 项`,
    `建议动作：${actionText}`,
    ...contextLines,
    '成员清单：',
    ...memberLines,
    `处理说明：${handlingHint}`,
  ].join('\n')
}

function formatBatchFailureReasonNoteOutput(
  note: string,
  group: BatchFailureReasonGroup,
  presetLabel: string,
  outputMode: BatchFailureReasonNoteOutputModeKey,
): string {
  if (!note) {
    return ''
  }

  const actionText = batchFailureReasonActionText(group)
  if (outputMode === 'ticket') {
    return [
      '# 目录失败处理',
      `- 失败原因：${group.message}`,
      `- 建议动作：${actionText}`,
      `- 涉及成员：${group.count} 项`,
      `- 内容模板：${presetLabel}`,
      `- 完成时间：${latestBatchResult.value?.completedAt || formatDateTime(new Date().toISOString())}`,
      '',
      '## 可直接外发备注',
      note,
    ].join('\n')
  }

  if (outputMode === 'im') {
    const segments = note
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    return `【目录失败跟进】${segments.join('；')}`
  }

  return note
}

function appendBatchFailureReasonSnippet(key: BatchFailureReasonNoteSnippetKey): void {
  const group = activeBatchFailureReasonGroup.value
  const snippet = batchFailureReasonNoteSnippets.find((item) => item.key === key)
  const next = snippet?.text.trim() || ''
  if (!group || !next) {
    return
  }
  const currentLines = batchFailureReasonNoteExtraLines(activeBatchFailureReasonNoteContext.value.extra)
  if (currentLines.includes(next)) {
    return
  }
  const nextExtra = [...currentLines, next].join('\n')
  const currentSnippetKeys = batchFailureReasonNoteSnippetDrafts.value[group.message] || []
  const nextSnippetKeys = currentSnippetKeys.includes(key) ? currentSnippetKeys : [...currentSnippetKeys, key]
  updateActiveBatchFailureReasonNoteContext('extra', nextExtra)
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: nextSnippetKeys,
  }
  rememberActiveBatchFailureReasonNotePreference({
    snippetKeys: nextSnippetKeys,
  })
}

function batchFailuresForReasonGroup(group: BatchFailureReasonGroup): BatchOperationFailure[] {
  if (!latestBatchResult.value) {
    return []
  }

  const accountIds = new Set(group.accountIds)
  return latestBatchResult.value.failures.filter((failure) =>
    failure.message === group.message && accountIds.has(failure.accountId),
  )
}

function buildBatchFailureReasonFailuresText(group: BatchFailureReasonGroup): string {
  const failures = batchFailuresForReasonGroup(group)
  const lines = [
    `操作,${latestBatchResult.value?.label || '批量处理'}`,
    `完成时间,${latestBatchResult.value?.completedAt || formatDateTime(new Date().toISOString())}`,
    `失败原因,${group.message}`,
    `数量,${group.count}`,
    '',
    '成员,失败原因',
  ]
  for (const failure of failures) {
    lines.push(`${failure.accountName},${failure.message}`)
  }
  return lines.join('\n')
}

function buildBatchFailureReasonFailuresCsv(group: BatchFailureReasonGroup): string {
  const failures = batchFailuresForReasonGroup(group)
  const rows = [
    ['operation', latestBatchResult.value?.label || '批量处理'],
    ['completed_at', latestBatchResult.value?.completedAt || formatDateTime(new Date().toISOString())],
    ['reason', group.message],
    ['count', String(group.count)],
    [],
    ['account_name', 'error_message'],
    ...failures.map((failure) => [failure.accountName, failure.message]),
  ]

  return rows
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\n')
}

function buildBatchFailureReasonTeamTemplateExportText(
  template: BatchFailureReasonTeamTemplate,
  outputMode: BatchFailureReasonNoteOutputModeKey,
): string {
  const handlingGroupLabel = batchFailureReasonHandlingGroups.find((item) => item.key === template.handlingGroupKey)?.label || template.handlingGroupKey
  const presetLabel = batchFailureReasonNotePresets.find((item) => item.key === template.preset)?.label || template.preset
  const outputLabel = batchFailureReasonNoteOutputModes.find((item) => item.key === outputMode)?.label || outputMode
  const lines = [
    '团队标准模板：',
    `输出格式：${outputLabel}`,
    `处理组：${handlingGroupLabel}`,
    `内容模板：${presetLabel}`,
  ]
  if (template.owner) {
    lines.push(`处理负责人：${template.owner}`)
  }
  if (template.deadline) {
    lines.push(`截止时间：${template.deadline}`)
  }
  if (template.channel) {
    lines.push(`同步渠道：${template.channel}`)
  }
  if (template.extra) {
    lines.push(`补充说明：${batchFailureReasonNoteExtraLines(template.extra).join('；')}`)
  }
  if (template.snippetKeys.length > 0) {
    const labels = template.snippetKeys
      .map((key) => batchFailureReasonNoteSnippets.find((item) => item.key === key)?.label || key)
      .join(' / ')
    lines.push(`快捷补充语：${labels}`)
  }
  if (template.savedAt) {
    lines.push(`保存时间：${template.savedAt}`)
  }
  return lines.join('\n')
}

function buildActiveBatchFailureReasonTeamTemplateSnapshot(): BatchFailureReasonTeamTemplate {
  return {
    preset: activeBatchFailureReasonNotePreset.value,
    handlingGroupKey: activeBatchFailureReasonHandlingGroupKey.value,
    owner: activeBatchFailureReasonNoteContext.value.owner,
    deadline: activeBatchFailureReasonNoteContext.value.deadline,
    channel: activeBatchFailureReasonNoteContext.value.channel,
    extra: activeBatchFailureReasonNoteContext.value.extra,
    snippetKeys: [...activeBatchFailureReasonNoteSnippetKeys.value],
    savedAt: formatDateTime(new Date().toISOString()),
  }
}

function batchFailureReasonNoteOutputModeLabel(outputMode: BatchFailureReasonNoteOutputModeKey): string {
  return batchFailureReasonNoteOutputModes.find((item) => item.key === outputMode)?.label || outputMode
}

function batchFailureReasonTeamTemplateImportSourceLabel(source: BatchFailureReasonTeamTemplateImportSource): string {
  return source === 'json' ? 'JSON' : '模板码'
}

function isBatchFailureReasonTeamTemplateFieldIgnored(key: BatchFailureReasonTeamTemplateFieldKey): boolean {
  return batchFailureReasonTeamTemplateIgnoredFieldKeys.value.includes(key)
}

function toggleBatchFailureReasonTeamTemplateIgnoredField(key: BatchFailureReasonTeamTemplateFieldKey): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    return
  }
  const previousTemplate = batchFailureReasonTeamTemplates.value[payload.outputMode] || null
  if (!canIgnoreBatchFailureReasonTeamTemplateField(previousTemplate, key)) {
    setStatus(`字段“${batchFailureReasonTeamTemplateFieldLabel(key)}”当前没有旧值可保留，不能忽略。`, 'error')
    return
  }

  const ignored = new Set(batchFailureReasonTeamTemplateIgnoredFieldKeys.value)
  if (ignored.has(key)) {
    ignored.delete(key)
    batchFailureReasonTeamTemplateIgnoredFieldKeys.value = Array.from(ignored)
    setStatus(`已恢复导入字段“${batchFailureReasonTeamTemplateFieldLabel(key)}”`)
    return
  }

  ignored.add(key)
  batchFailureReasonTeamTemplateIgnoredFieldKeys.value = Array.from(ignored)
  setStatus(`导入时将保留字段“${batchFailureReasonTeamTemplateFieldLabel(key)}”的原值`)
}

function applicableBatchFailureReasonTeamTemplateIgnoredFieldKeys(
  outputMode: BatchFailureReasonNoteOutputModeKey,
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[],
): BatchFailureReasonTeamTemplateFieldKey[] {
  const previousTemplate = batchFailureReasonTeamTemplates.value[outputMode] || null
  return ignoredFieldKeys.filter((key) => canIgnoreBatchFailureReasonTeamTemplateField(previousTemplate, key))
}

function applyBatchFailureReasonTeamTemplateImportPreset(
  presetKey: BatchFailureReasonTeamTemplateImportPresetKey,
): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    setStatus('请先粘贴有效的模板码。', 'error')
    return
  }
  const preset = batchFailureReasonTeamTemplateImportPresetOptions.find((item) => item.key === presetKey)
  if (!preset) {
    return
  }
  batchFailureReasonTeamTemplateIgnoredFieldKeys.value = applicableBatchFailureReasonTeamTemplateIgnoredFieldKeys(
    payload.outputMode,
    [...preset.ignoredFieldKeys],
  )
  setStatus(`已应用导入预设“${preset.label}”`)
}

function isActiveBatchFailureReasonTeamTemplateImportPresetOption(
  presetKey: BatchFailureReasonTeamTemplateImportPresetKey,
): boolean {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    return false
  }
  const preset = batchFailureReasonTeamTemplateImportPresetOptions.find((item) => item.key === presetKey)
  if (!preset) {
    return false
  }
  return sameBatchFailureReasonTeamTemplateIgnoredFieldKeys(
    batchFailureReasonTeamTemplateIgnoredFieldKeys.value,
    applicableBatchFailureReasonTeamTemplateIgnoredFieldKeys(payload.outputMode, [...preset.ignoredFieldKeys]),
  )
}

function resolveBatchFailureReasonTeamTemplateImportPresetName(
  name: string,
  ignoredFieldKeys: BatchFailureReasonTeamTemplateFieldKey[],
): string {
  return name.trim() || describeBatchFailureReasonTeamTemplateIgnoredFields(ignoredFieldKeys)
}

function applySavedBatchFailureReasonTeamTemplateImportPreset(presetId?: string): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    setStatus('请先粘贴有效的模板码。', 'error')
    return
  }
  const presets = batchFailureReasonTeamTemplateImportPresets.value[payload.outputMode] || []
  const preset = presetId
    ? presets.find((item) => item.id === presetId) || null
    : activeBatchFailureReasonTeamTemplateImportPreset.value
  if (!preset) {
    setStatus(`输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”还没有已保存的导入预设。`, 'error')
    return
  }
  batchFailureReasonTeamTemplateIgnoredFieldKeys.value = applicableBatchFailureReasonTeamTemplateIgnoredFieldKeys(
    payload.outputMode,
    [...preset.ignoredFieldKeys],
  )
  const lastUsedAt = formatDateTime(new Date().toISOString())
  markDirectoryTemplateCenterChanged('use_import_preset')
  batchFailureReasonTeamTemplateImportPresets.value = {
    ...batchFailureReasonTeamTemplateImportPresets.value,
    [payload.outputMode]: presets.map((item) =>
      item.id === preset.id
        ? {
            ...item,
            useCount: item.useCount + 1,
            lastUsedAt,
          }
        : item,
    ),
  }
  persistBatchFailureReasonTeamTemplateImportPresets()
  selectedBatchFailureReasonTeamTemplateImportPresetId.value = preset.id
  batchFailureReasonTeamTemplateImportPresetName.value = preset.name
  batchFailureReasonTeamTemplateImportPresetTagsInput.value = preset.tags.join('、')
  setStatus(`已应用输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”的导入预设“${preset.name}”`)
}

function saveBatchFailureReasonTeamTemplateImportPreset(): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  if (!payload) {
    setStatus('请先粘贴有效的模板码。', 'error')
    return
  }
  const ignoredFieldKeys = applicableBatchFailureReasonTeamTemplateIgnoredFieldKeys(
    payload.outputMode,
    [...batchFailureReasonTeamTemplateIgnoredFieldKeys.value],
  )
  const name = resolveBatchFailureReasonTeamTemplateImportPresetName(
    batchFailureReasonTeamTemplateImportPresetName.value,
    ignoredFieldKeys,
  )
  const tags = parseBatchFailureReasonTeamTemplateImportPresetTagsInput(
    batchFailureReasonTeamTemplateImportPresetTagsInput.value,
  )
  const existingPresets = batchFailureReasonTeamTemplateImportPresets.value[payload.outputMode] || []
  if (existingPresets.some((item) => item.name === name)) {
    setStatus(`输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”里已存在同名导入预设“${name}”。`, 'error')
    return
  }
  const timestamp = formatDateTime(new Date().toISOString())
  const preset: BatchFailureReasonTeamTemplateImportPreset = {
    id: createBatchFailureReasonTeamTemplateImportPresetId(),
    name,
    tags,
    favorite: false,
    pinned: false,
    lockedOrder: existingPresets.length,
    useCount: 0,
    ignoredFieldKeys,
    savedAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: '',
  }
  markDirectoryTemplateCenterChanged('save_import_preset')
  batchFailureReasonTeamTemplateImportPresets.value = {
    ...batchFailureReasonTeamTemplateImportPresets.value,
    [payload.outputMode]: [preset, ...existingPresets].slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_LIMIT),
  }
  selectedBatchFailureReasonTeamTemplateImportPresetId.value = preset.id
  batchFailureReasonTeamTemplateImportPresetName.value = preset.name
  batchFailureReasonTeamTemplateImportPresetTagsInput.value = preset.tags.join('、')
  persistBatchFailureReasonTeamTemplateImportPresets()
  setStatus(`已保存输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”的导入预设“${preset.name}”`)
}

function overwriteBatchFailureReasonTeamTemplateImportPreset(): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  const activePreset = activeBatchFailureReasonTeamTemplateImportPreset.value
  if (!payload) {
    setStatus('请先粘贴有效的模板码。', 'error')
    return
  }
  if (!activePreset) {
    setStatus(`输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”还没有可覆盖的导入预设。`, 'error')
    return
  }
  const ignoredFieldKeys = applicableBatchFailureReasonTeamTemplateIgnoredFieldKeys(
    payload.outputMode,
    [...batchFailureReasonTeamTemplateIgnoredFieldKeys.value],
  )
  const name = resolveBatchFailureReasonTeamTemplateImportPresetName(
    batchFailureReasonTeamTemplateImportPresetName.value,
    ignoredFieldKeys,
  )
  const tags = parseBatchFailureReasonTeamTemplateImportPresetTagsInput(
    batchFailureReasonTeamTemplateImportPresetTagsInput.value,
  )
  const existingPresets = batchFailureReasonTeamTemplateImportPresets.value[payload.outputMode] || []
  if (existingPresets.some((item) => item.id !== activePreset.id && item.name === name)) {
    setStatus(`输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”里已存在同名导入预设“${name}”。`, 'error')
    return
  }
  const updatedAt = formatDateTime(new Date().toISOString())
  markDirectoryTemplateCenterChanged('overwrite_import_preset')
  batchFailureReasonTeamTemplateImportPresets.value = {
    ...batchFailureReasonTeamTemplateImportPresets.value,
    [payload.outputMode]: existingPresets.map((item) =>
      item.id === activePreset.id
        ? {
            ...item,
            name,
            tags,
            ignoredFieldKeys,
            updatedAt,
          }
        : item,
    ),
  }
  selectedBatchFailureReasonTeamTemplateImportPresetId.value = activePreset.id
  batchFailureReasonTeamTemplateImportPresetName.value = name
  batchFailureReasonTeamTemplateImportPresetTagsInput.value = tags.join('、')
  persistBatchFailureReasonTeamTemplateImportPresets()
  setStatus(`已覆盖输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”的导入预设“${name}”`)
}

function removeBatchFailureReasonTeamTemplateImportPreset(): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  const activePreset = activeBatchFailureReasonTeamTemplateImportPreset.value
  if (!payload) {
    setStatus('请先粘贴有效的模板码。', 'error')
    return
  }
  if (!activePreset) {
    setStatus(`输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”还没有可删除的导入预设。`, 'error')
    return
  }
  const existingPresets = batchFailureReasonTeamTemplateImportPresets.value[payload.outputMode] || []
  const nextPresets = existingPresets.filter((item) => item.id !== activePreset.id)
  const nextStore = { ...batchFailureReasonTeamTemplateImportPresets.value }
  if (nextPresets.length > 0) {
    nextStore[payload.outputMode] = nextPresets
  } else {
    delete nextStore[payload.outputMode]
  }
  markDirectoryTemplateCenterChanged('remove_import_preset')
  batchFailureReasonTeamTemplateImportPresets.value = nextStore
  selectedBatchFailureReasonTeamTemplateImportPresetId.value = nextPresets[0]?.id || ''
  batchFailureReasonTeamTemplateImportPresetName.value = nextPresets[0]?.name || ''
  batchFailureReasonTeamTemplateImportPresetTagsInput.value = (nextPresets[0]?.tags || []).join('、')
  persistBatchFailureReasonTeamTemplateImportPresets()
  setStatus(`已删除输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”的导入预设“${activePreset.name}”`)
}

function toggleFavoriteBatchFailureReasonTeamTemplateImportPreset(): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  const activePreset = activeBatchFailureReasonTeamTemplateImportPreset.value
  if (!payload || !activePreset) {
    setStatus('当前没有可收藏的导入预设。', 'error')
    return
  }
  const nextFavorite = !activePreset.favorite
  markDirectoryTemplateCenterChanged(nextFavorite ? 'favorite_import_preset' : 'unfavorite_import_preset')
  batchFailureReasonTeamTemplateImportPresets.value = {
    ...batchFailureReasonTeamTemplateImportPresets.value,
    [payload.outputMode]: (batchFailureReasonTeamTemplateImportPresets.value[payload.outputMode] || []).map((item) =>
      item.id === activePreset.id
        ? {
            ...item,
            favorite: nextFavorite,
          }
        : item,
    ),
  }
  persistBatchFailureReasonTeamTemplateImportPresets()
  setStatus(`${nextFavorite ? '已收藏' : '已取消收藏'}输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”的导入预设“${activePreset.name}”`)
}

function togglePinBatchFailureReasonTeamTemplateImportPreset(): void {
  const payload = batchFailureReasonTeamTemplateImportPreview.value
  const activePreset = activeBatchFailureReasonTeamTemplateImportPreset.value
  if (!payload || !activePreset) {
    setStatus('当前没有可置顶的导入预设。', 'error')
    return
  }
  const nextPinned = !activePreset.pinned
  markDirectoryTemplateCenterChanged(nextPinned ? 'pin_import_preset' : 'unpin_import_preset')
  batchFailureReasonTeamTemplateImportPresets.value = {
    ...batchFailureReasonTeamTemplateImportPresets.value,
    [payload.outputMode]: (batchFailureReasonTeamTemplateImportPresets.value[payload.outputMode] || []).map((item) =>
      item.id === activePreset.id
        ? {
            ...item,
            pinned: nextPinned,
          }
        : item,
    ),
  }
  persistBatchFailureReasonTeamTemplateImportPresets()
  setStatus(`${nextPinned ? '已置顶' : '已取消置顶'}输出“${batchFailureReasonNoteOutputModeLabel(payload.outputMode)}”的导入预设“${activePreset.name}”`)
}

function toggleBatchFailureReasonTeamTemplateImportPresetRecentOrderLock(): void {
  const nextLocked = !batchFailureReasonTeamTemplateImportPresetPreference.value.lockRecentUsageOrder
  if (nextLocked) {
    markDirectoryTemplateCenterChanged('lock_import_preset_order')
    batchFailureReasonTeamTemplateImportPresets.value = Object.fromEntries(
      Object.entries(batchFailureReasonTeamTemplateImportPresets.value).map(([outputMode, presets]) => [
        outputMode,
        assignBatchFailureReasonTeamTemplateImportPresetLockedOrder(presets),
      ]),
    )
    persistBatchFailureReasonTeamTemplateImportPresets()
  }
  batchFailureReasonTeamTemplateImportPresetPreference.value = {
    ...batchFailureReasonTeamTemplateImportPresetPreference.value,
    lockRecentUsageOrder: nextLocked,
  }
  persistBatchFailureReasonTeamTemplateImportPresetPreference()
  setStatus(batchFailureReasonTeamTemplateImportPresetPreference.value.lockRecentUsageOrder
    ? '已锁定最近使用排序'
    : '已解除最近使用排序锁定')
}

function clearLowFrequencyBatchFailureReasonTeamTemplateImportPresets(): void {
  const outputMode = activeBatchFailureReasonTeamTemplateImportPresetOutputMode.value
  const currentPresets = batchFailureReasonTeamTemplateImportPresets.value[outputMode] || []
  const removableIds = new Set(lowFrequencyBatchFailureReasonTeamTemplateImportPresets.value.map((preset) => preset.id))
  if (removableIds.size === 0) {
    setStatus('当前范围内没有可清理的低频导入预设。', 'error')
    return
  }
  const nextPresets = currentPresets.filter((preset) => !removableIds.has(preset.id))
  const nextStore = { ...batchFailureReasonTeamTemplateImportPresets.value }
  if (nextPresets.length > 0) {
    nextStore[outputMode] = batchFailureReasonTeamTemplateImportPresetPreference.value.lockRecentUsageOrder
      ? assignBatchFailureReasonTeamTemplateImportPresetLockedOrder(nextPresets)
      : nextPresets
  } else {
    delete nextStore[outputMode]
  }
  markDirectoryTemplateCenterChanged('cleanup_low_frequency_presets')
  batchFailureReasonTeamTemplateImportPresets.value = nextStore
  persistBatchFailureReasonTeamTemplateImportPresets()
  setStatus(`已清理输出“${batchFailureReasonNoteOutputModeLabel(outputMode)}”当前范围内的 ${removableIds.size} 条低频导入预设`)
}

function applyBatchFailureReasonTeamTemplateToActiveState(template: BatchFailureReasonTeamTemplate): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    return
  }

  activeBatchFailureReasonNotePreset.value = template.preset
  batchFailureReasonHandlingGroupDrafts.value = {
    ...batchFailureReasonHandlingGroupDrafts.value,
    [group.message]: template.handlingGroupKey,
  }
  batchFailureReasonNoteDrafts.value = {
    ...batchFailureReasonNoteDrafts.value,
    [group.message]: {
      owner: template.owner,
      deadline: template.deadline,
      channel: template.channel,
      extra: template.extra,
    },
  }
  batchFailureReasonNoteSnippetDrafts.value = {
    ...batchFailureReasonNoteSnippetDrafts.value,
    [group.message]: [...template.snippetKeys],
  }
  rememberActiveBatchFailureReasonNotePreference({
    snippetKeys: template.snippetKeys,
  })
}

function setBatchFailureReasonNotePreference(
  outputMode: BatchFailureReasonNoteOutputModeKey,
  preference: BatchFailureReasonNotePreference | null,
): void {
  const nextPreferences = {
    ...batchFailureReasonNotePreferences.value.byOutputMode,
  }
  if (preference) {
    nextPreferences[outputMode] = {
      preset: preference.preset,
      owner: preference.owner,
      deadline: preference.deadline,
      channel: preference.channel,
      snippetKeys: [...preference.snippetKeys],
    }
  } else {
    delete nextPreferences[outputMode]
  }
  batchFailureReasonNotePreferences.value = {
    ...batchFailureReasonNotePreferences.value,
    byOutputMode: nextPreferences,
  }
  persistBatchFailureReasonNotePreferences()
}

function recordBatchFailureReasonTeamTemplateImport(
  payload: BatchFailureReasonTeamTemplateCodePayload,
  importedTemplate: BatchFailureReasonTeamTemplate,
  source: BatchFailureReasonTeamTemplateImportSource,
): void {
  const previousTemplate = batchFailureReasonTeamTemplates.value[payload.outputMode] || null
  const previousPreference = getStoredBatchFailureReasonNotePreference(payload.outputMode)
  const previousActiveTemplate = payload.outputMode === activeBatchFailureReasonNoteOutputMode.value && activeBatchFailureReasonGroup.value
    ? buildActiveBatchFailureReasonTeamTemplateSnapshot()
    : null

  const nextItem: BatchFailureReasonTeamTemplateImportHistoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    importedAt: formatDateTime(new Date().toISOString()),
    outputMode: payload.outputMode,
    source,
    appliedImmediately: payload.outputMode === activeBatchFailureReasonNoteOutputMode.value && Boolean(activeBatchFailureReasonGroup.value),
    importedTemplate,
    previousTemplate: previousTemplate
      ? {
          ...previousTemplate,
          snippetKeys: [...previousTemplate.snippetKeys],
        }
      : null,
    previousPreference: previousPreference
      ? {
          ...previousPreference,
          snippetKeys: [...previousPreference.snippetKeys],
        }
      : null,
    previousActiveTemplate: previousActiveTemplate
      ? {
          ...previousActiveTemplate,
          snippetKeys: [...previousActiveTemplate.snippetKeys],
        }
      : null,
    ignoredFieldKeys: [...batchFailureReasonTeamTemplateIgnoredFieldKeys.value],
    rolledBackAt: '',
  }

  markDirectoryTemplateCenterChanged('record_import_history')
  batchFailureReasonTeamTemplateImportHistory.value = [
    nextItem,
    ...batchFailureReasonTeamTemplateImportHistory.value,
  ].slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_LIMIT)
  persistBatchFailureReasonTeamTemplateImportHistory()
}

function applyBatchFailureReasonTeamTemplateImportHistoryItem(item: BatchFailureReasonTeamTemplateImportHistoryItem): void {
  markDirectoryTemplateCenterChanged('reapply_import_history')
  batchFailureReasonTeamTemplates.value = {
    ...batchFailureReasonTeamTemplates.value,
    [item.outputMode]: {
      ...item.importedTemplate,
      snippetKeys: [...item.importedTemplate.snippetKeys],
    },
  }
  persistBatchFailureReasonTeamTemplates()
  setBatchFailureReasonNotePreference(item.outputMode, {
    preset: item.importedTemplate.preset,
    owner: item.importedTemplate.owner,
    deadline: item.importedTemplate.deadline,
    channel: item.importedTemplate.channel,
    snippetKeys: [...item.importedTemplate.snippetKeys],
  })

  if (item.outputMode !== activeBatchFailureReasonNoteOutputMode.value) {
    selectBatchFailureReasonNoteOutputMode(item.outputMode)
  }

  if (activeBatchFailureReasonGroup.value) {
    applyBatchFailureReasonTeamTemplateToActiveState(item.importedTemplate)
  }

  setStatus(`已重新应用 ${batchFailureReasonNoteOutputModeLabel(item.outputMode)} 的模板导入记录`)
}

function rollbackBatchFailureReasonTeamTemplateImport(item: BatchFailureReasonTeamTemplateImportHistoryItem): void {
  const nextTemplates = { ...batchFailureReasonTeamTemplates.value }
  if (item.previousTemplate) {
    nextTemplates[item.outputMode] = {
      ...item.previousTemplate,
      snippetKeys: [...item.previousTemplate.snippetKeys],
    }
  } else {
    delete nextTemplates[item.outputMode]
  }
  batchFailureReasonTeamTemplates.value = nextTemplates
  persistBatchFailureReasonTeamTemplates()
  setBatchFailureReasonNotePreference(
    item.outputMode,
    item.previousPreference
      ? {
          ...item.previousPreference,
          snippetKeys: [...item.previousPreference.snippetKeys],
        }
      : null,
  )

  batchFailureReasonTeamTemplateImportHistory.value = batchFailureReasonTeamTemplateImportHistory.value.map((entry) =>
    entry.id === item.id
      ? {
          ...entry,
          rolledBackAt: formatDateTime(new Date().toISOString()),
        }
      : entry,
  )
  markDirectoryTemplateCenterChanged('rollback_import_history')
  persistBatchFailureReasonTeamTemplateImportHistory()

  if (item.outputMode === activeBatchFailureReasonNoteOutputMode.value && activeBatchFailureReasonGroup.value) {
    if (item.previousActiveTemplate) {
      applyBatchFailureReasonTeamTemplateToActiveState(item.previousActiveTemplate)
    } else if (item.previousTemplate) {
      applyBatchFailureReasonTeamTemplateToActiveState(item.previousTemplate)
    } else if (item.previousPreference) {
      activeBatchFailureReasonNotePreset.value = item.previousPreference.preset
      batchFailureReasonNoteDrafts.value = {
        ...batchFailureReasonNoteDrafts.value,
        [activeBatchFailureReasonGroup.value.message]: {
          owner: item.previousPreference.owner,
          deadline: item.previousPreference.deadline,
          channel: item.previousPreference.channel,
          extra: batchFailureReasonNoteDrafts.value[activeBatchFailureReasonGroup.value.message]?.extra || '',
        },
      }
      batchFailureReasonNoteSnippetDrafts.value = {
        ...batchFailureReasonNoteSnippetDrafts.value,
        [activeBatchFailureReasonGroup.value.message]: [...item.previousPreference.snippetKeys],
      }
    } else {
      const defaultHandlingGroupKey = defaultBatchFailureReasonHandlingGroup(activeBatchFailureReasonGroup.value)
      const defaultHandlingGroup = resolveBatchFailureReasonHandlingGroup(activeBatchFailureReasonGroup.value, defaultHandlingGroupKey)
      activeBatchFailureReasonNotePreset.value = defaultBatchFailureReasonNotePreset(activeBatchFailureReasonGroup.value)
      batchFailureReasonHandlingGroupDrafts.value = {
        ...batchFailureReasonHandlingGroupDrafts.value,
        [activeBatchFailureReasonGroup.value.message]: defaultHandlingGroupKey,
      }
      batchFailureReasonNoteDrafts.value = {
        ...batchFailureReasonNoteDrafts.value,
        [activeBatchFailureReasonGroup.value.message]: defaultHandlingGroup.context,
      }
      batchFailureReasonNoteSnippetDrafts.value = {
        ...batchFailureReasonNoteSnippetDrafts.value,
        [activeBatchFailureReasonGroup.value.message]: defaultHandlingGroup.snippetKeys,
      }
    }
  }

  setStatus(`已回滚输出“${batchFailureReasonNoteOutputModeLabel(item.outputMode)}”的模板导入`)
}

function saveActiveBatchFailureReasonTeamTemplate(): void {
  const group = activeBatchFailureReasonGroup.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  markDirectoryTemplateCenterChanged('save_team_template')
  batchFailureReasonTeamTemplates.value = {
    ...batchFailureReasonTeamTemplates.value,
    [activeBatchFailureReasonNoteOutputMode.value]: buildActiveBatchFailureReasonTeamTemplateSnapshot(),
  }
  persistBatchFailureReasonTeamTemplates()
  setStatus(`已将当前设置保存为输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”的团队标准模板`)
}

function applyActiveBatchFailureReasonTeamTemplate(): void {
  const group = activeBatchFailureReasonGroup.value
  const template = activeBatchFailureReasonTeamTemplate.value
  if (!group) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }
  if (!template) {
    setStatus(`当前输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”还没有团队标准模板。`, 'error')
    return
  }

  applyBatchFailureReasonTeamTemplateToActiveState(template)
  setStatus(`已应用输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”的团队标准模板`)
}

async function copyActiveBatchFailureReasonTeamTemplate(): Promise<void> {
  const template = activeBatchFailureReasonTeamTemplate.value
  if (!template) {
    setStatus(`当前输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”还没有团队标准模板。`, 'error')
    return
  }
  if (!globalThis.navigator?.clipboard?.writeText) {
    setStatus('当前环境不支持剪贴板复制，请改用手动复制。', 'error')
    return
  }

  try {
    await globalThis.navigator.clipboard.writeText(
      buildBatchFailureReasonTeamTemplateExportText(template, activeBatchFailureReasonNoteOutputMode.value),
    )
    setStatus(`团队标准模板已复制（${activeBatchFailureReasonNoteOutputModeOption.value.label}）`)
  } catch (error) {
    setStatus(readErrorMessage(error, '复制团队标准模板失败'), 'error')
  }
}

async function copyActiveBatchFailureReasonTeamTemplateCode(): Promise<void> {
  const template = activeBatchFailureReasonTeamTemplate.value
  if (!template) {
    setStatus(`当前输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”还没有团队标准模板。`, 'error')
    return
  }
  if (!globalThis.navigator?.clipboard?.writeText) {
    setStatus('当前环境不支持剪贴板复制，请改用手动复制。', 'error')
    return
  }

  try {
    await globalThis.navigator.clipboard.writeText(
      encodeBatchFailureReasonTeamTemplateCode({
        version: 1,
        outputMode: activeBatchFailureReasonNoteOutputMode.value,
        template,
      }),
    )
    setStatus(`团队模板码已复制（${activeBatchFailureReasonNoteOutputModeOption.value.label}）`)
  } catch (error) {
    setStatus(readErrorMessage(error, '复制团队模板码失败'), 'error')
  }
}

function toggleBatchFailureReasonTeamTemplateImport(): void {
  showBatchFailureReasonTeamTemplateImport.value = !showBatchFailureReasonTeamTemplateImport.value
  if (!showBatchFailureReasonTeamTemplateImport.value) {
    batchFailureReasonTeamTemplateCodeInput.value = ''
    batchFailureReasonTeamTemplateIgnoredFieldKeys.value = []
    batchFailureReasonTeamTemplateImportPresetSearch.value = ''
    selectedBatchFailureReasonTeamTemplateImportPresetTag.value = ''
  }
}

function importBatchFailureReasonTeamTemplateCode(): void {
  const payload = decodeBatchFailureReasonTeamTemplateCode(batchFailureReasonTeamTemplateCodeInput.value)
  if (!payload) {
    setStatus('模板码无效，请粘贴通过“复制模板码”生成的内容或合法 JSON。', 'error')
    return
  }
  const source: BatchFailureReasonTeamTemplateImportSource = batchFailureReasonTeamTemplateCodeInput.value.trim().startsWith(BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX)
    ? 'code'
    : 'json'
  const effectivePreviewTemplate = batchFailureReasonTeamTemplateAppliedImportPreview.value
  if (!effectivePreviewTemplate) {
    setStatus('当前模板码预览无效，请重新粘贴后再试。', 'error')
    return
  }

  const importedTemplate: BatchFailureReasonTeamTemplate = {
    ...effectivePreviewTemplate,
    savedAt: formatDateTime(new Date().toISOString()),
  }
  markDirectoryTemplateCenterChanged('import_template_code')
  recordBatchFailureReasonTeamTemplateImport(payload, importedTemplate, source)

  batchFailureReasonTeamTemplates.value = {
    ...batchFailureReasonTeamTemplates.value,
    [payload.outputMode]: importedTemplate,
  }
  persistBatchFailureReasonTeamTemplates()
  batchFailureReasonTeamTemplateCodeInput.value = ''
  batchFailureReasonTeamTemplateIgnoredFieldKeys.value = []
  batchFailureReasonTeamTemplateImportPresetSearch.value = ''
  selectedBatchFailureReasonTeamTemplateImportPresetTag.value = ''
  showBatchFailureReasonTeamTemplateImport.value = false

  if (payload.outputMode === activeBatchFailureReasonNoteOutputMode.value && activeBatchFailureReasonGroup.value) {
    applyActiveBatchFailureReasonTeamTemplate()
    setStatus(`模板码已导入，并已应用到输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”`)
    return
  }

  const outputLabel = batchFailureReasonNoteOutputModes.find((item) => item.key === payload.outputMode)?.label || payload.outputMode
  setStatus(`模板码已导入到输出“${outputLabel}”`)
}

function clearActiveBatchFailureReasonTeamTemplate(): void {
  if (!activeBatchFailureReasonTeamTemplate.value) {
    setStatus(`当前输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”没有可清空的团队标准模板。`, 'error')
    return
  }

  const nextTemplates = { ...batchFailureReasonTeamTemplates.value }
  delete nextTemplates[activeBatchFailureReasonNoteOutputMode.value]
  markDirectoryTemplateCenterChanged('clear_team_template')
  batchFailureReasonTeamTemplates.value = nextTemplates
  persistBatchFailureReasonTeamTemplates()
  setStatus(`已清空输出“${activeBatchFailureReasonNoteOutputModeOption.value.label}”的团队标准模板`)
}

function batchFailureReasonTeamTemplateImportPreviewText(
  payload: BatchFailureReasonTeamTemplateCodePayload,
): string {
  const outputLabel = batchFailureReasonNoteOutputModeLabel(payload.outputMode)
  const handlingGroupLabel = batchFailureReasonHandlingGroups.find((item) => item.key === payload.template.handlingGroupKey)?.label || payload.template.handlingGroupKey
  const presetLabel = batchFailureReasonNotePresets.find((item) => item.key === payload.template.preset)?.label || payload.template.preset
  return `将导入到 ${outputLabel} / ${handlingGroupLabel} / ${presetLabel}`
}

function buildBatchFailuresCsv(result: BatchOperationResult): string {
  const rows = [
    ['operation', result.label],
    ['completed_at', result.completedAt],
    ['total', String(result.total)],
    ['success_count', String(result.successCount)],
    ['failure_count', String(result.failureCount)],
    [],
    ['account_name', 'error_message'],
    ...result.failures.map((failure) => [failure.accountName, failure.message]),
  ]

  return rows
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\n')
}

async function copyBatchFailures(): Promise<void> {
  if (!latestBatchResult.value || latestBatchResult.value.failures.length === 0) {
    setStatus('当前没有可复制的失败清单。', 'error')
    return
  }

  if (!globalThis.navigator?.clipboard?.writeText) {
    setStatus('当前环境不支持剪贴板复制，请改用导出 CSV。', 'error')
    return
  }

  try {
    await globalThis.navigator.clipboard.writeText(buildBatchFailuresText(latestBatchResult.value))
    setStatus(`失败清单已复制（${latestBatchResult.value.failureCount} 项）`)
  } catch (error) {
    setStatus(readErrorMessage(error, '复制失败清单失败'), 'error')
  }
}

async function copyActiveBatchFailureReasonNote(): Promise<void> {
  if (!activeBatchFailureReasonGroup.value) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  if (!globalThis.navigator?.clipboard?.writeText) {
    setStatus('当前环境不支持剪贴板复制，请改用手动复制备注模板。', 'error')
    return
  }

  try {
    await globalThis.navigator.clipboard.writeText(activeBatchFailureReasonNotePreview.value)
    setStatus(`处理备注已复制（${activeBatchFailureReasonGroup.value.count} 项）`)
  } catch (error) {
    setStatus(readErrorMessage(error, '复制处理备注失败'), 'error')
  }
}

async function copyActiveBatchFailureReasonFailures(): Promise<void> {
  if (!activeBatchFailureReasonGroup.value) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  if (!globalThis.navigator?.clipboard?.writeText) {
    setStatus('当前环境不支持剪贴板复制，请改用导出 CSV。', 'error')
    return
  }

  try {
    await globalThis.navigator.clipboard.writeText(buildBatchFailureReasonFailuresText(activeBatchFailureReasonGroup.value))
    setStatus(`该类失败清单已复制（${activeBatchFailureReasonGroup.value.count} 项）`)
  } catch (error) {
    setStatus(readErrorMessage(error, '复制该类失败清单失败'), 'error')
  }
}

function exportBatchFailuresCsv(): void {
  if (!latestBatchResult.value || latestBatchResult.value.failures.length === 0) {
    setStatus('当前没有可导出的失败清单。', 'error')
    return
  }

  const blob = new Blob([buildBatchFailuresCsv(latestBatchResult.value)], {
    type: 'text/csv;charset=utf-8',
  })
  downloadBlob('directory-batch-failures.csv', blob)
  setStatus(`失败清单 CSV 已导出（${latestBatchResult.value.failureCount} 项）`)
}

function exportActiveBatchFailureReasonFailuresCsv(): void {
  if (!activeBatchFailureReasonGroup.value) {
    setStatus('请先选择一个失败原因。', 'error')
    return
  }

  const blob = new Blob([buildBatchFailureReasonFailuresCsv(activeBatchFailureReasonGroup.value)], {
    type: 'text/csv;charset=utf-8',
  })
  downloadBlob('directory-batch-failures-reason.csv', blob)
  setStatus(`该类失败 CSV 已导出（${activeBatchFailureReasonGroup.value.count} 项）`)
}

function normalizeHintText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseHintScopes(text: string): string[] {
  if (!text) return []
  return Array.from(new Set(text.match(/qyapi_[a-z0-9_]+/gi) || []))
}

function parseHintApplyUrl(text: string): string {
  const match = text.match(/(https:\/\/open-dev\.dingtalk\.com\/appscope\/apply\?[^,\]\s]+)/i)
  return match?.[1]?.trim() || ''
}

function parseHintSubcode(text: string): string {
  const match = text.match(/subcode\s*=\s*([0-9]+)/i)
  return match?.[1]?.trim() || ''
}

function parseDingTalkPermissionHint(source: unknown): DingTalkPermissionHint | null {
  const record = toRecord(source)
  const errorRecord = toRecord(record.error)
  const detailRecord = toRecord(errorRecord.details || record.details)
  const candidates = [
    normalizeHintText(detailRecord.message),
    normalizeHintText(errorRecord.message),
    normalizeHintText(record.message),
    normalizeHintText(record.errmsg),
    normalizeHintText(record.sub_msg),
    normalizeHintText(record.submsg),
    normalizeHintText(typeof source === 'string' ? source : ''),
  ].filter((value) => value.length > 0)

  const requiredScopes = Array.isArray(detailRecord.requiredScopes)
    ? detailRecord.requiredScopes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : parseHintScopes(candidates.join(' '))
  const applyUrl = normalizeHintText(detailRecord.applyUrl || detailRecord.apply_url) || parseHintApplyUrl(candidates.join(' '))
  const subcode = normalizeHintText(detailRecord.subcode || detailRecord.subCode) || parseHintSubcode(candidates.join(' '))
  const message = normalizeHintText(detailRecord.message) || candidates[0] || ''
  const provider = normalizeHintText(detailRecord.provider) || 'dingtalk'
  const looksLikePermissionHint = provider === 'dingtalk'
    && (
      requiredScopes.length > 0
      || applyUrl.length > 0
      || subcode === '60011'
      || candidates.join(' ').includes('应用尚未开通所需的权限')
      || candidates.join(' ').includes('requiredScopes')
    )

  if (!looksLikePermissionHint) {
    return null
  }

  return {
    provider: 'dingtalk',
    message,
    subcode,
    requiredScopes,
    applyUrl,
  }
}

function buildAccountQueryParams(): string {
  const params = new URLSearchParams({
    page: String(accountsPage.value),
    pageSize: String(accountsPageSize.value),
  })
  if (accountStatusFilter.value !== 'all') {
    if (accountStatusFilter.value === 'inactive') {
      params.set('isActive', 'false')
    } else {
      params.set('linkStatus', accountStatusFilter.value)
    }
  }
  if (accountMatchStrategyFilter.value) {
    params.set('matchStrategy', accountMatchStrategyFilter.value)
  }
  if (accountDingtalkAuthFilter.value === 'enabled') {
    params.set('dingtalkAuthEnabled', 'true')
  } else if (accountDingtalkAuthFilter.value === 'disabled') {
    params.set('dingtalkAuthEnabled', 'false')
  }
  if (accountBindingFilter.value === 'bound') {
    params.set('isBound', 'true')
  } else if (accountBindingFilter.value === 'unbound') {
    params.set('isBound', 'false')
  }
  if (accountDepartmentFilter.value) {
    params.set('departmentId', accountDepartmentFilter.value)
  }
  if (accountSearch.value.trim()) {
    params.set('q', accountSearch.value.trim())
  }
  return params.toString()
}

function buildAccountExportQueryParams(): string {
  const params = new URLSearchParams()
  if (accountStatusFilter.value !== 'all') {
    if (accountStatusFilter.value === 'inactive') {
      params.set('isActive', 'false')
    } else {
      params.set('linkStatus', accountStatusFilter.value)
    }
  }
  if (accountMatchStrategyFilter.value) {
    params.set('matchStrategy', accountMatchStrategyFilter.value)
  }
  if (accountDingtalkAuthFilter.value === 'enabled') {
    params.set('dingtalkAuthEnabled', 'true')
  } else if (accountDingtalkAuthFilter.value === 'disabled') {
    params.set('dingtalkAuthEnabled', 'false')
  }
  if (accountBindingFilter.value === 'bound') {
    params.set('isBound', 'true')
  } else if (accountBindingFilter.value === 'unbound') {
    params.set('isBound', 'false')
  }
  if (accountDepartmentFilter.value) {
    params.set('departmentId', accountDepartmentFilter.value)
  }
  if (accountSearch.value.trim()) {
    params.set('q', accountSearch.value.trim())
  }
  return params.toString()
}

function downloadBlob(filename: string, blob: Blob): void {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function persistSharedTemplateCenterLocally(): void {
  persistBatchFailureReasonTeamTemplates()
  persistBatchFailureReasonTeamTemplateImportHistory()
  persistBatchFailureReasonTeamTemplateImportPresets()
}

function hasSharedTemplateCenterLocalState(): boolean {
  return Object.keys(batchFailureReasonTeamTemplates.value).length > 0
    || batchFailureReasonTeamTemplateImportHistory.value.length > 0
    || Object.keys(batchFailureReasonTeamTemplateImportPresets.value).length > 0
}

function markDirectoryTemplateCenterChanged(reason = 'ui_edit'): void {
  pendingDirectoryTemplateCenterChangeReason = reason
}

function applyDirectoryTemplateCenter(center: DirectoryTemplateCenter): void {
  directoryTemplateCenterHydrating.value = true
  directoryTemplateCenter.value = center
  batchFailureReasonTeamTemplates.value = center.teamTemplates
  batchFailureReasonTeamTemplateImportHistory.value = center.importHistory
  batchFailureReasonTeamTemplateImportPresets.value = center.importPresets
  persistSharedTemplateCenterLocally()
  directoryTemplateCenterLoaded.value = true
  directoryTemplateCenterSyncError.value = ''
  directoryTemplateCenterHydrating.value = false
}

async function loadDirectoryTemplateCenterAuxiliaryResources(integrationId: string): Promise<void> {
  const [versionsResponse, reportResponse] = await Promise.all([
    apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/template-center/versions?limit=8`),
    apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/template-center/report`),
  ])
  const [versionsPayload, reportPayload] = await Promise.all([
    readJson(versionsResponse),
    readJson(reportResponse),
  ])
  if (!versionsResponse.ok || !isOkEnvelope(versionsPayload)) {
    throw new Error(readErrorMessage(versionsPayload, '加载模板中心版本失败'))
  }
  if (!reportResponse.ok || !isOkEnvelope(reportPayload)) {
    throw new Error(readErrorMessage(reportPayload, '加载模板治理报表失败'))
  }
  directoryTemplateCenterVersions.value = extractListItems(versionsPayload).map((item) => normalizeDirectoryTemplateCenterVersion(item))
  directoryTemplateGovernanceReport.value = normalizeDirectoryTemplateGovernanceReport(extractSingleItem(reportPayload))
}

async function loadDirectoryTemplateCenterResources(integrationId: string): Promise<void> {
  directoryTemplateCenterLoading.value = true
  try {
    const localCenterBeforeLoad = hasSharedTemplateCenterLocalState()
      ? {
          integrationId,
          teamTemplates: batchFailureReasonTeamTemplates.value,
          importHistory: batchFailureReasonTeamTemplateImportHistory.value,
          importPresets: batchFailureReasonTeamTemplateImportPresets.value,
          createdBy: directoryTemplateCenter.value?.createdBy || '',
          updatedBy: directoryTemplateCenter.value?.updatedBy || '',
          createdAt: directoryTemplateCenter.value?.createdAt || '',
          updatedAt: directoryTemplateCenter.value?.updatedAt || '',
        } satisfies DirectoryTemplateCenter
      : null

    const response = await apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/template-center`)
    const payload = await readJson(response)
    if (!response.ok || !isOkEnvelope(payload)) {
      throw new Error(readErrorMessage(payload, '加载模板中心失败'))
    }
    const center = normalizeDirectoryTemplateCenter(extractSingleItem(payload))
    const centerIsEmpty = Object.keys(center.teamTemplates).length === 0
      && center.importHistory.length === 0
      && Object.keys(center.importPresets).length === 0
    if (centerIsEmpty && localCenterBeforeLoad && !migratedTemplateCenterIntegrations.has(integrationId)) {
      applyDirectoryTemplateCenter(localCenterBeforeLoad)
      migratedTemplateCenterIntegrations.add(integrationId)
      await saveDirectoryTemplateCenter(integrationId, 'migrate_local_cache', true)
      return
    }

    applyDirectoryTemplateCenter(center)
    await loadDirectoryTemplateCenterAuxiliaryResources(integrationId)
  } finally {
    directoryTemplateCenterLoading.value = false
  }
}

async function loadDirectoryOperationsResources(integrationId: string): Promise<void> {
  const [statusResponse, alertsResponse] = await Promise.all([
    apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/schedule-status`),
    apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/alerts?limit=8`),
  ])
  const [statusPayload, alertsPayload] = await Promise.all([
    readJson(statusResponse),
    readJson(alertsResponse),
  ])
  if (!statusResponse.ok || !isOkEnvelope(statusPayload)) {
    throw new Error(readErrorMessage(statusPayload, '加载计划同步状态失败'))
  }
  if (!alertsResponse.ok || !isOkEnvelope(alertsPayload)) {
    throw new Error(readErrorMessage(alertsPayload, '加载同步告警失败'))
  }
  directoryScheduleStatus.value = normalizeDirectoryScheduleStatus(extractSingleItem(statusPayload))
  directorySyncAlerts.value = extractListItems(alertsPayload).map((item) => normalizeDirectorySyncAlert(item))
}

function buildDirectoryActivityQueryParams(includePagination = true): string {
  const params = new URLSearchParams()
  if (includePagination) {
    params.set('page', String(directoryActivityPage.value))
    params.set('pageSize', String(directoryActivityPageSize.value))
  }
  if (directoryActivitySearch.value.trim()) {
    params.set('q', directoryActivitySearch.value.trim())
  }
  if (directoryActivityActionFilter.value) {
    params.set('action', directoryActivityActionFilter.value)
  }
  if (directoryActivityResourceTypeFilter.value) {
    params.set('resourceType', directoryActivityResourceTypeFilter.value)
  }
  if (directoryActivityFromDate.value) {
    params.set('from', directoryActivityFromDate.value)
  }
  if (directoryActivityToDate.value) {
    params.set('to', directoryActivityToDate.value)
  }
  if (directoryActivityScopeFilter.value === 'selected-account' && selectedAccountId.value) {
    params.set('accountId', selectedAccountId.value)
  }
  return params.toString()
}

async function loadDirectoryActivity(integrationId: string): Promise<void> {
  if (!integrationId) {
    directoryActivityItems.value = []
    directoryActivityTotal.value = 0
    directoryActivityPageCount.value = 1
    directoryActivityHasNextPage.value = false
    directoryActivityHasPreviousPage.value = false
    directoryActivitySummary.value = {
      total: 0,
      integrationActions: 0,
      accountActions: 0,
      syncActions: 0,
      alertActions: 0,
      templateActions: 0,
    }
    return
  }

  directoryActivityLoading.value = true
  try {
    const query = buildDirectoryActivityQueryParams()
    const url = query
      ? `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/activity?${query}`
      : `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/activity`
    const response = await apiFetch(url)
    const payload = await readJson(response)
    if (!response.ok || !isOkEnvelope(payload)) {
      throw new Error(readErrorMessage(payload, '加载目录操作历史失败'))
    }

    const meta = extractBodyData(payload)
    const summary = toRecord(meta.summary)
    directoryActivityItems.value = extractListItems(payload).map((item) => normalizeDirectoryActivity(item))
    directoryActivityTotal.value = typeof meta.total === 'number' ? meta.total : directoryActivityItems.value.length
    directoryActivityPage.value = typeof meta.page === 'number' ? meta.page : 1
    directoryActivityPageSize.value = typeof meta.pageSize === 'number' ? meta.pageSize : directoryActivityPageSize.value
    directoryActivityPageCount.value = typeof meta.pageCount === 'number'
      ? Math.max(1, meta.pageCount)
      : Math.max(1, Math.ceil(directoryActivityTotal.value / directoryActivityPageSize.value))
    directoryActivityHasNextPage.value = meta.hasNextPage === true
    directoryActivityHasPreviousPage.value = meta.hasPreviousPage === true
    directoryActivitySummary.value = {
      total: typeof summary.total === 'number' ? summary.total : directoryActivityTotal.value,
      integrationActions: typeof summary.integrationActions === 'number' ? summary.integrationActions : 0,
      accountActions: typeof summary.accountActions === 'number' ? summary.accountActions : 0,
      syncActions: typeof summary.syncActions === 'number' ? summary.syncActions : 0,
      alertActions: typeof summary.alertActions === 'number' ? summary.alertActions : 0,
      templateActions: typeof summary.templateActions === 'number' ? summary.templateActions : 0,
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '加载目录操作历史失败'), 'error')
    directoryActivityItems.value = []
    directoryActivityTotal.value = 0
    directoryActivityPageCount.value = 1
    directoryActivityHasNextPage.value = false
    directoryActivityHasPreviousPage.value = false
  } finally {
    directoryActivityLoading.value = false
  }
}

function handleDirectoryActivityFilterChange(): void {
  directoryActivityPage.value = 1
  void loadDirectoryActivity(selectedIntegrationId.value)
}

function toggleSelectedAccountActivityFilter(): void {
  if (!selectedAccount.value) {
    return
  }
  directoryActivityScopeFilter.value = directoryActivityScopeFilter.value === 'selected-account' ? 'all' : 'selected-account'
  handleDirectoryActivityFilterChange()
}

function prevDirectoryActivityPage(): void {
  if (!directoryActivityHasPreviousPage.value) return
  directoryActivityPage.value -= 1
  void loadDirectoryActivity(selectedIntegrationId.value)
}

function nextDirectoryActivityPage(): void {
  if (!directoryActivityHasNextPage.value) return
  directoryActivityPage.value += 1
  void loadDirectoryActivity(selectedIntegrationId.value)
}

async function saveDirectoryTemplateCenter(
  integrationId: string,
  changeReason = 'ui_edit',
  refreshAuxiliary = true,
): Promise<void> {
  if (!integrationId) {
    return
  }

  directoryTemplateCenterSaving.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/template-center`, {
      method: 'PATCH',
      body: JSON.stringify({
        teamTemplates: batchFailureReasonTeamTemplates.value,
        importHistory: batchFailureReasonTeamTemplateImportHistory.value,
        importPresets: batchFailureReasonTeamTemplateImportPresets.value,
        changeReason,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || !isOkEnvelope(payload)) {
      throw new Error(readErrorMessage(payload, '同步模板中心失败'))
    }

    const center = normalizeDirectoryTemplateCenter(extractSingleItem(payload))
    if (selectedIntegrationId.value === integrationId) {
      applyDirectoryTemplateCenter(center)
      if (refreshAuxiliary) {
        await loadDirectoryTemplateCenterAuxiliaryResources(integrationId)
      }
      directoryTemplateCenterLastSavedAt.value = formatDateTime(new Date().toISOString())
      directoryTemplateCenterSyncError.value = ''
    }
  } catch (error) {
    directoryTemplateCenterSyncError.value = readErrorMessage(error, '同步模板中心失败')
  } finally {
    directoryTemplateCenterSaving.value = false
  }
}

function queueDirectoryTemplateCenterSave(reason = 'ui_edit'): void {
  if (!selectedIntegrationId.value || !directoryTemplateCenterLoaded.value || directoryTemplateCenterHydrating.value) {
    return
  }
  pendingDirectoryTemplateCenterChangeReason = reason
  if (directoryTemplateCenterSaveTimer) {
    clearTimeout(directoryTemplateCenterSaveTimer)
  }
  directoryTemplateCenterSaveTimer = setTimeout(() => {
    const integrationId = selectedIntegrationId.value
    const nextReason = pendingDirectoryTemplateCenterChangeReason
    directoryTemplateCenterSaveTimer = null
    void saveDirectoryTemplateCenter(integrationId, nextReason, true)
  }, 450)
}

function resolveExportFilename(response: Response): string {
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/i)
  return match?.[1] || 'directory-accounts.csv'
}

async function loadAccounts(integrationId: string): Promise<void> {
  if (!integrationId) {
    accounts.value = []
    selectedAccountIds.value = []
    accountsTotal.value = 0
    selectedAccountId.value = ''
    return
  }

  const query = buildAccountQueryParams()
  const url = query
    ? `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/accounts?${query}`
    : `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/accounts`

  try {
    const response = await apiFetch(url)
    const body = await readJson(response)
    if (!response.ok || !isOkEnvelope(body)) {
      throw new Error(readErrorMessage(body, '加载成员目录失败'))
    }
    const meta = extractBodyData(body)
    const summary = toRecord(meta.summary)
    accountsTotal.value = typeof meta.total === 'number' ? meta.total : 0
    accountsPage.value = typeof meta.page === 'number' ? meta.page : 1
    accountsPageSize.value = typeof meta.pageSize === 'number' ? meta.pageSize : accountsPageSize.value
    accountsPageCount.value = typeof meta.pageCount === 'number' ? Math.max(1, meta.pageCount) : Math.max(1, Math.ceil(accountsTotal.value / accountsPageSize.value))
    accountsHasNextPage.value = meta.hasNextPage === true
    accountsHasPreviousPage.value = meta.hasPreviousPage === true
    accountSummary.value = {
      total: accountsTotal.value,
      linked: typeof summary.linked === 'number' ? summary.linked : 0,
      pending: typeof summary.pending === 'number' ? summary.pending : 0,
      conflict: typeof summary.conflict === 'number' ? summary.conflict : 0,
      ignored: typeof summary.ignored === 'number' ? summary.ignored : 0,
      active: typeof summary.active === 'number' ? summary.active : 0,
      inactive: typeof summary.inactive === 'number' ? summary.inactive : 0,
      dingtalkAuthEnabled: typeof summary.dingtalkAuthEnabled === 'number' ? summary.dingtalkAuthEnabled : 0,
      dingtalkAuthDisabled: typeof summary.dingtalkAuthDisabled === 'number' ? summary.dingtalkAuthDisabled : 0,
      bound: typeof summary.bound === 'number' ? summary.bound : 0,
      unbound: typeof summary.unbound === 'number' ? summary.unbound : 0,
    }
    accounts.value = extractListItems(body).map((item) => normalizeAccount(item))
    selectedAccountIds.value = selectedAccountIds.value.filter((id) => accounts.value.some((account) => account.id === id))

    const nextSelectedAccount = accounts.value.find((account) => account.id === selectedAccountId.value) || accounts.value[0] || null
    selectedAccountId.value = nextSelectedAccount?.id || ''
    if (nextSelectedAccount) {
      await loadAccountDetail(integrationId, nextSelectedAccount.id)
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '加载成员目录失败'), 'error')
    accounts.value = []
    selectedAccountIds.value = []
    accountsTotal.value = 0
    accountsPageCount.value = 1
    accountsHasNextPage.value = false
    accountsHasPreviousPage.value = false
    selectedAccountId.value = ''
  }
}

function handleAccountFilterChange(): void {
  accountsPage.value = 1
  void loadAccounts(selectedIntegrationId.value)
}

function nextPage(): void {
  if (accountsHasNextPage.value) {
    accountsPage.value += 1
    void loadAccounts(selectedIntegrationId.value)
  }
}

function prevPage(): void {
  if (accountsHasPreviousPage.value) {
    accountsPage.value -= 1
    void loadAccounts(selectedIntegrationId.value)
  }
}

async function testIntegration(): Promise<void> {
  if (!selectedIntegrationId.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/test`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok || !isOkEnvelope(body)) {
      statusPermissionHint.value = parseDingTalkPermissionHint(body)
      throw new Error(readErrorMessage(body, '测试连接失败'))
    }
    setStatus('连接测试成功')
  } catch (error) {
    if (!statusPermissionHint.value) {
      statusPermissionHint.value = parseDingTalkPermissionHint(error)
    }
    setStatus(readErrorMessage(error, '测试连接失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function exportAccountsCsv(): Promise<void> {
  if (!selectedIntegrationId.value) return
  exportingAccounts.value = true
  try {
    const query = buildAccountExportQueryParams()
    const url = query
      ? `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/accounts/export.csv?${query}`
      : `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/accounts/export.csv`
    const response = await apiFetch(url, {
      headers: {
        Accept: 'text/csv',
      },
    })
    if (!response.ok) {
      const body = await readJson(response)
      throw new Error(readErrorMessage(body, '导出目录成员失败'))
    }

    downloadBlob(resolveExportFilename(response), await response.blob())
    const returned = Number(response.headers.get('x-export-returned') || '0')
    const total = Number(response.headers.get('x-export-total') || '0')
    const truncated = response.headers.get('x-export-truncated') === 'true'
    if (truncated && total > returned && returned > 0) {
      setStatus(`目录成员 CSV 已导出（${returned}/${total}）`)
    } else {
      setStatus('目录成员 CSV 已导出')
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '导出目录成员失败'), 'error')
  } finally {
    exportingAccounts.value = false
  }
}

async function exportDirectoryActivityCsv(): Promise<void> {
  if (!selectedIntegrationId.value) return
  exportingDirectoryActivity.value = true
  try {
    const query = buildDirectoryActivityQueryParams(false)
    const url = query
      ? `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/activity/export.csv?${query}`
      : `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/activity/export.csv`
    const response = await apiFetch(url, {
      headers: {
        Accept: 'text/csv',
      },
    })
    if (!response.ok) {
      const body = await readJson(response)
      throw new Error(readErrorMessage(body, '导出目录操作历史失败'))
    }

    downloadBlob(resolveExportFilename(response), await response.blob())
    const returned = Number(response.headers.get('x-export-returned') || '0')
    const total = Number(response.headers.get('x-export-total') || '0')
    const truncated = response.headers.get('x-export-truncated') === 'true'
    if (truncated && total > returned && returned > 0) {
      setStatus(`目录操作历史 CSV 已导出（${returned}/${total}）`)
    } else {
      setStatus('目录操作历史 CSV 已导出')
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '导出目录操作历史失败'), 'error')
  } finally {
    exportingDirectoryActivity.value = false
  }
}

async function refreshDirectoryTemplateCenterFromServer(): Promise<void> {
  if (!selectedIntegrationId.value) return
  try {
    await Promise.all([
      loadDirectoryTemplateCenterResources(selectedIntegrationId.value),
      loadDirectoryOperationsResources(selectedIntegrationId.value),
    ])
    setStatus('服务端模板中心已刷新')
  } catch (error) {
    setStatus(readErrorMessage(error, '刷新服务端模板中心失败'), 'error')
  }
}

async function exportDirectoryTemplateGovernanceCsv(): Promise<void> {
  if (!selectedIntegrationId.value) return
  exportingAccounts.value = true
  try {
    const response = await apiFetch(
      `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/template-center/report.csv`,
      {
        headers: {
          Accept: 'text/csv',
        },
      },
    )
    if (!response.ok) {
      const body = await readJson(response)
      throw new Error(readErrorMessage(body, '导出模板治理 CSV 失败'))
    }
    downloadBlob(resolveExportFilename(response), await response.blob())
    setStatus('模板治理 CSV 已导出')
  } catch (error) {
    setStatus(readErrorMessage(error, '导出模板治理 CSV 失败'), 'error')
  } finally {
    exportingAccounts.value = false
  }
}

async function copyDirectoryTemplateGovernanceJson(): Promise<void> {
  if (!directoryTemplateGovernanceReport.value) {
    setStatus('当前还没有可复制的模板治理报表。', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(directoryTemplateGovernanceReport.value, null, 2))
    setStatus('模板治理 JSON 已复制')
  } catch (error) {
    setStatus(readErrorMessage(error, '复制模板治理 JSON 失败'), 'error')
  }
}

async function restoreDirectoryTemplateCenterVersion(versionId: string): Promise<void> {
  if (!selectedIntegrationId.value || !versionId) return
  busy.value = true
  try {
    const response = await apiFetch(
      `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/template-center/versions/${encodeURIComponent(versionId)}/restore`,
      {
        method: 'POST',
      },
    )
    const payload = await readJson(response)
    if (!response.ok || !isOkEnvelope(payload)) {
      throw new Error(readErrorMessage(payload, '回滚模板中心版本失败'))
    }
    applyDirectoryTemplateCenter(normalizeDirectoryTemplateCenter(extractSingleItem(payload)))
    await Promise.all([
      loadDirectoryTemplateCenterAuxiliaryResources(selectedIntegrationId.value),
      loadDirectoryOperationsResources(selectedIntegrationId.value),
    ])
    setStatus('模板中心已回滚到指定版本')
  } catch (error) {
    setStatus(readErrorMessage(error, '回滚模板中心版本失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function acknowledgeDirectorySyncAlert(alertId: string): Promise<void> {
  if (!selectedIntegrationId.value || !alertId) return
  busy.value = true
  try {
    const response = await apiFetch(
      `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/alerts/${encodeURIComponent(alertId)}/ack`,
      {
        method: 'POST',
      },
    )
    const payload = await readJson(response)
    if (!response.ok || !isOkEnvelope(payload)) {
      throw new Error(readErrorMessage(payload, '确认同步告警失败'))
    }
    await loadDirectoryOperationsResources(selectedIntegrationId.value)
    setStatus('同步告警已确认')
  } catch (error) {
    setStatus(readErrorMessage(error, '确认同步告警失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return fallback
}

function readBoolean(record: Record<string, unknown>, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return fallback
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function readPolicies(record: Record<string, unknown>, keys: string[], fallback: DeprovisionPolicy = DEFAULT_DEPROVISION_POLICY): DeprovisionPolicy {
  for (const key of keys) {
    if (!(key in record)) continue
    const parsed = normalizePolicies(record[key])
    if (parsed !== null) return parsed
  }
  return [...fallback]
}

function readNullablePolicies(record: Record<string, unknown>, keys: string[]): DeprovisionPolicy | null {
  for (const key of keys) {
    if (!(key in record)) continue
    return normalizePolicies(record[key])
  }
  return null
}

function extractBodyData(payload: unknown): Record<string, unknown> {
  const record = toRecord(payload)
  const data = record.data
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  return record
}

function extractListItems(payload: unknown): Record<string, unknown>[] {
  const body = extractBodyData(payload)
  const data = body.data
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>
    if (Array.isArray(nested.items)) {
      return nested.items.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    }
    if (Array.isArray(nested.list)) {
      return nested.list.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    }
  }
  if (Array.isArray(body.items)) {
    return body.items.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
  }
  if (Array.isArray(body.list)) {
    return body.list.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
  }
  return []
}

function extractSingleItem(payload: unknown): Record<string, unknown> {
  return extractBodyData(payload)
}

function isOkEnvelope(payload: unknown): boolean {
  const record = toRecord(payload)
  if (!('ok' in record)) return true
  return record.ok === true
}

function formatDateTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function accountDisplayName(account: DirectoryAccount): string {
  return account.name || account.nick || account.email || account.mobile || account.externalUserId || account.id
}

function recordBatchResult(
  label: string,
  accountsToProcess: DirectoryAccount[],
  results: PromiseSettledResult<void>[],
  fallbackMessage: string,
): void {
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return []
    }

    const account = accountsToProcess[index]
    return [{
      accountId: account?.id || `unknown-${index}`,
      accountName: account ? accountDisplayName(account) : `成员 ${index + 1}`,
      message: readErrorMessage(result.reason, fallbackMessage),
    }]
  })

  const nextResult: BatchOperationResult = {
    label,
    total: accountsToProcess.length,
    successCount: results.length - failures.length,
    failureCount: failures.length,
    completedAt: formatDateTime(new Date().toISOString()),
    failures,
  }
  latestBatchResult.value = nextResult
  batchFailureFilterActive.value = false
  batchFailureReasonFilter.value = ''
  resetBatchFailureReasonNoteOutputMode()
  resetBatchFailureReasonNotePreset()
  resetBatchFailureReasonNoteContext()
  batchResultHistory.value = [
    nextResult,
    ...batchResultHistory.value.filter((item) => !(item.label === nextResult.label && item.completedAt === nextResult.completedAt)),
  ].slice(0, 5)
}

function policyLabel(value: DeprovisionPolicy | string | null | undefined): string {
  const policies = normalizePolicies(value) ?? []
  if (policies.length === 0) return '无额外动作'
  return policies.map((policy) => {
    const option = policyOptions.find((item) => item.value === policy)
    return option?.label || policy
  }).join(' + ')
}

function policyOverrideLabel(value: DeprovisionPolicy | string | null | undefined): string {
  if (value === null) return '沿用集成默认策略'
  return policyLabel(value)
}

function statusLabel(value: string): string {
  switch (value) {
    case 'active':
    case 'enabled':
      return '启用'
    case 'inactive':
    case 'disabled':
      return '停用'
    case 'running':
      return '运行中'
    case 'success':
      return '成功'
    case 'error':
      return '失败'
    case 'linked':
      return '已绑定'
    case 'pending':
      return '待审核'
    case 'conflict':
      return '冲突待处理'
    case 'ignored':
      return '已忽略'
    default:
      return value || '未知'
  }
}

function normalizeIntegration(item: Record<string, unknown>): DirectoryIntegration {
  const config = toRecord(item.config)
  const scheduleCron = readString(item, ['scheduleCron', 'schedule_cron'])
  const corpId = readString(item, ['corpId', 'corp_id'])
  return {
    id: readString(item, ['id']),
    name: readString(item, ['name']),
    provider: readString(item, ['provider'], 'dingtalk'),
    corpId,
    status: readString(item, ['status'], 'inactive'),
    statusLabel: statusLabel(readString(item, ['status'], 'inactive')),
    scheduleCron,
    syncEnabled: readBoolean(item, ['syncEnabled', 'sync_enabled'], true),
    rootDepartmentId: readString(config, ['rootDepartmentId', 'root_department_id', 'rootDepartment']),
    appKey: readString(config, ['appKey', 'app_key', 'clientId', 'client_id']),
    appSecret: readString(config, ['appSecret', 'app_secret', 'clientSecret', 'client_secret']),
    hasAppSecret: readBoolean(config, ['hasAppSecret', 'has_app_secret'], readString(config, ['appSecret', 'app_secret', 'clientSecret', 'client_secret']).length > 0),
    captureUnboundLogins: readBoolean(config, ['captureUnboundLogins', 'capture_unbound_logins'], true),
    defaultDeprovisionPolicy: readPolicies(item, ['defaultDeprovisionPolicy', 'default_deprovision_policy']),
    lastSyncAt: readString(item, ['lastSyncAt', 'last_sync_at']),
    lastSuccessAt: readString(item, ['lastSuccessAt', 'last_success_at']),
    lastCursor: readString(item, ['lastCursor', 'last_cursor']),
    lastError: readString(item, ['lastError', 'last_error']),
  }
}

function matchStrategyLabel(value: string): string {
  switch (value) {
    case 'external_identity':
      return '已绑定外部身份'
    case 'email_exact':
      return '邮箱精确匹配'
    case 'mobile_exact':
      return '手机号精确匹配'
    case 'manual':
      return '人工关联'
    default:
      return value || '未匹配'
  }
}

function normalizeRun(item: Record<string, unknown>): DirectoryRun {
  const stats = toRecord(item.stats)
  const errorMessage = readString(item, ['errorMessage', 'error_message'])
  return {
    id: readString(item, ['id']),
    status: readString(item, ['status'], 'unknown'),
    statusLabel: statusLabel(readString(item, ['status'], 'unknown')),
    startedAt: readString(item, ['startedAt', 'started_at']),
    finishedAt: readString(item, ['finishedAt', 'finished_at']),
    cursorBefore: readString(item, ['cursorBefore', 'cursor_before']),
    cursorAfter: readString(item, ['cursorAfter', 'cursor_after']),
    errorMessage,
    departmentsFetched: readNumber(stats, ['departmentsFetched', 'departments_fetched']) ?? 0,
    accountsFetched: readNumber(stats, ['accountsFetched', 'accounts_fetched']) ?? 0,
    accountsInserted: readNumber(stats, ['accountsInserted', 'accounts_inserted']) ?? 0,
    accountsUpdated: readNumber(stats, ['accountsUpdated', 'accounts_updated']) ?? 0,
    linksMatched: readNumber(stats, ['linksMatched', 'links_matched']) ?? 0,
    linksConflicted: readNumber(stats, ['linksConflicted', 'links_conflicted']) ?? 0,
    accountsDeactivated: readNumber(stats, ['accountsDeactivated', 'accounts_deactivated']) ?? 0,
    permissionHint: parseDingTalkPermissionHint(errorMessage),
  }
}

function normalizeTeamTemplateStore(value: unknown): BatchFailureReasonTeamTemplateStore {
  const parsed = toRecord(value)
  const result: BatchFailureReasonTeamTemplateStore = {}
  for (const outputMode of batchFailureReasonNoteOutputModes.map((entry) => entry.key)) {
    const normalized = normalizeBatchFailureReasonTeamTemplate(parsed[outputMode])
    if (normalized) {
      result[outputMode] = normalized
    }
  }
  return result
}

function normalizeImportHistory(value: unknown): BatchFailureReasonTeamTemplateImportHistory {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => normalizeBatchFailureReasonTeamTemplateImportHistoryItem(item))
    .filter((item): item is BatchFailureReasonTeamTemplateImportHistoryItem => Boolean(item))
    .slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_LIMIT)
}

function normalizeImportPresetStore(value: unknown): BatchFailureReasonTeamTemplateImportPresetStore {
  const parsed = toRecord(value)
  const result: BatchFailureReasonTeamTemplateImportPresetStore = {}
  for (const outputMode of batchFailureReasonNoteOutputModes.map((entry) => entry.key)) {
    const raw = parsed[outputMode]
    const normalized = Array.isArray(raw)
      ? raw
          .map((item) => normalizeBatchFailureReasonTeamTemplateImportPreset(item))
          .filter((item): item is BatchFailureReasonTeamTemplateImportPreset => Boolean(item))
          .slice(0, BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_LIMIT)
      : []
    if (normalized.length > 0) {
      result[outputMode] = normalized
    }
  }
  return result
}

function normalizeDirectoryTemplateCenter(item: Record<string, unknown>): DirectoryTemplateCenter {
  return {
    integrationId: readString(item, ['integrationId', 'integration_id']),
    teamTemplates: normalizeTeamTemplateStore(item.teamTemplates || item.team_templates),
    importHistory: normalizeImportHistory(item.importHistory || item.import_history),
    importPresets: normalizeImportPresetStore(item.importPresets || item.import_presets),
    createdBy: readString(item, ['createdBy', 'created_by']),
    updatedBy: readString(item, ['updatedBy', 'updated_by']),
    createdAt: readString(item, ['createdAt', 'created_at']),
    updatedAt: readString(item, ['updatedAt', 'updated_at']),
  }
}

function normalizeDirectoryTemplateCenterVersion(item: Record<string, unknown>): DirectoryTemplateCenterVersion {
  const summary = toRecord(item.snapshotSummary || item.snapshot_summary)
  const outputModes = Array.isArray(summary.outputModes)
    ? summary.outputModes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : Array.isArray(summary.output_modes)
      ? summary.output_modes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
  return {
    id: readString(item, ['id']),
    centerId: readString(item, ['centerId', 'center_id']),
    integrationId: readString(item, ['integrationId', 'integration_id']),
    changeReason: readString(item, ['changeReason', 'change_reason']),
    createdBy: readString(item, ['createdBy', 'created_by']),
    createdAt: readString(item, ['createdAt', 'created_at']),
    snapshotSummary: {
      outputModes,
      teamTemplateCount: readNumber(summary, ['teamTemplateCount', 'team_template_count']) ?? 0,
      importPresetCount: readNumber(summary, ['importPresetCount', 'import_preset_count']) ?? 0,
      importHistoryCount: readNumber(summary, ['importHistoryCount', 'import_history_count']) ?? 0,
    },
  }
}

function normalizeDirectoryTemplateGovernanceReport(item: Record<string, unknown>): DirectoryTemplateGovernanceReport {
  const totals = toRecord(item.totals)
  const tagSummary = Array.isArray(item.tagSummary)
    ? item.tagSummary
        .map((entry) => toRecord(entry))
        .map((entry) => ({
          tag: readString(entry, ['tag']),
          count: readNumber(entry, ['count']) ?? 0,
        }))
        .filter((entry) => entry.tag.length > 0)
    : []
  const presets = Array.isArray(item.presets)
    ? item.presets
        .map((entry) => toRecord(entry))
        .map((entry) => ({
          outputMode: readString(entry, ['outputMode', 'output_mode']),
          id: readString(entry, ['id']),
          name: readString(entry, ['name']),
          tags: Array.isArray(entry.tags)
            ? entry.tags.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : [],
          favorite: readBoolean(entry, ['favorite']),
          pinned: readBoolean(entry, ['pinned']),
          useCount: readNumber(entry, ['useCount', 'use_count']) ?? 0,
          lastUsedAt: readString(entry, ['lastUsedAt', 'last_used_at']),
          ignoredFieldCount: readNumber(entry, ['ignoredFieldCount', 'ignored_field_count']) ?? 0,
          usageBucket: readString(entry, ['usageBucket', 'usage_bucket']) as DirectoryTemplateGovernancePreset['usageBucket'],
        }))
        .filter((entry) => entry.id.length > 0)
    : []

  return {
    integrationId: readString(item, ['integrationId', 'integration_id']),
    generatedAt: readString(item, ['generatedAt', 'generated_at']),
    totals: {
      outputModes: readNumber(totals, ['outputModes', 'output_modes']) ?? 0,
      teamTemplates: readNumber(totals, ['teamTemplates', 'team_templates']) ?? 0,
      importPresets: readNumber(totals, ['importPresets', 'import_presets']) ?? 0,
      favorites: readNumber(totals, ['favorites']) ?? 0,
      pinned: readNumber(totals, ['pinned']) ?? 0,
      highFrequency: readNumber(totals, ['highFrequency', 'high_frequency']) ?? 0,
      lowFrequency: readNumber(totals, ['lowFrequency', 'low_frequency']) ?? 0,
      unused: readNumber(totals, ['unused']) ?? 0,
      distinctTags: readNumber(totals, ['distinctTags', 'distinct_tags']) ?? 0,
    },
    tagSummary,
    presets,
  }
}

function normalizeDirectoryScheduleStatus(item: Record<string, unknown>): DirectoryScheduleStatus {
  return {
    integrationId: readString(item, ['integrationId', 'integration_id']),
    syncEnabled: readBoolean(item, ['syncEnabled', 'sync_enabled'], false),
    scheduleCron: readString(item, ['scheduleCron', 'schedule_cron']),
    nextRunAt: readString(item, ['nextRunAt', 'next_run_at']),
    lastRunStatus: readString(item, ['lastRunStatus', 'last_run_status']),
    lastRunStartedAt: readString(item, ['lastRunStartedAt', 'last_run_started_at']),
    lastRunFinishedAt: readString(item, ['lastRunFinishedAt', 'last_run_finished_at']),
    lastSuccessAt: readString(item, ['lastSuccessAt', 'last_success_at']),
    lastError: readString(item, ['lastError', 'last_error']),
    alertCount: readNumber(item, ['alertCount', 'alert_count']) ?? 0,
    unacknowledgedAlertCount: readNumber(item, ['unacknowledgedAlertCount', 'unacknowledged_alert_count']) ?? 0,
    lastAlertAt: readString(item, ['lastAlertAt', 'last_alert_at']),
  }
}

function normalizeDirectorySyncAlert(item: Record<string, unknown>): DirectorySyncAlert {
  return {
    id: readString(item, ['id']),
    integrationId: readString(item, ['integrationId', 'integration_id']),
    runId: readString(item, ['runId', 'run_id']),
    level: readString(item, ['level'], 'error'),
    code: readString(item, ['code']),
    message: readString(item, ['message']),
    details: toRecord(item.details),
    sentToWebhook: readBoolean(item, ['sentToWebhook', 'sent_to_webhook']),
    acknowledgedAt: readString(item, ['acknowledgedAt', 'acknowledged_at']),
    acknowledgedBy: readString(item, ['acknowledgedBy', 'acknowledged_by']),
    createdAt: readString(item, ['createdAt', 'created_at']),
    updatedAt: readString(item, ['updatedAt', 'updated_at']),
  }
}

function normalizeDirectoryActivity(item: Record<string, unknown>): DirectoryActivityItem {
  return {
    id: readString(item, ['id']),
    createdAt: readString(item, ['createdAt', 'created_at']),
    eventType: readString(item, ['eventType', 'event_type']),
    eventCategory: readString(item, ['eventCategory', 'event_category']),
    eventSeverity: readString(item, ['eventSeverity', 'event_severity']),
    action: readString(item, ['action']),
    resourceType: readString(item, ['resourceType', 'resource_type'], 'directory-account') as DirectoryActivityResourceType,
    resourceId: readString(item, ['resourceId', 'resource_id']),
    actorUserId: readString(item, ['actorUserId', 'actor_user_id', 'userId', 'user_id']),
    actorName: readString(item, ['actorName', 'actor_name', 'userName', 'user_name']),
    actorEmail: readString(item, ['actorEmail', 'actor_email', 'userEmail', 'user_email']),
    actionDetails: toRecord(item.actionDetails || item.action_details),
    errorCode: readString(item, ['errorCode', 'error_code']),
    integrationId: readString(item, ['integrationId', 'integration_id']),
    integrationName: readString(item, ['integrationName', 'integration_name']),
    accountId: readString(item, ['accountId', 'account_id']),
    accountName: readString(item, ['accountName', 'account_name']),
    accountEmail: readString(item, ['accountEmail', 'account_email']),
    accountExternalUserId: readString(item, ['accountExternalUserId', 'account_external_user_id']),
  }
}

function directoryActivityActionLabel(value: string): string {
  return directoryActivityActionOptions.find((item) => item.value === value)?.label || value || '未命名动作'
}

function directoryActivityResourceTypeLabel(value: DirectoryActivityResourceType | string): string {
  return directoryActivityResourceTypeOptions.find((item) => item.value === value)?.label || value || '未知资源'
}

function directoryActivitySubjectLabel(item: DirectoryActivityItem): string {
  if (item.resourceType === 'directory-account') {
    return item.accountName || item.accountEmail || item.accountExternalUserId || item.resourceId || '目录成员'
  }
  if (item.resourceType === 'directory-integration') {
    return item.integrationName || item.resourceId || '目录集成'
  }
  if (item.resourceType === 'directory-sync-alert') {
    return readString(item.actionDetails, ['code'], item.resourceId || '同步告警')
  }
  if (item.resourceType === 'directory-template-center') {
    return item.integrationName ? `${item.integrationName} 模板中心` : '模板中心'
  }
  return item.resourceId || '目录对象'
}

function directoryActivityActorLabel(item: DirectoryActivityItem): string {
  if (item.actorEmail || item.actorName) {
    return item.actorName || item.actorEmail
  }
  const actorType = readString(item.actionDetails, ['actorType', 'actor_type'])
  if (actorType === 'system') {
    return '系统'
  }
  return item.actorUserId || '未记录'
}

function summarizeDirectoryActivity(item: DirectoryActivityItem): string {
  const fragments: string[] = []
  const append = (label: string, value: unknown) => {
    if (value == null) return
    if (Array.isArray(value)) {
      if (value.length > 0) {
        fragments.push(`${label}：${value.join('、')}`)
      }
      return
    }
    if (typeof value === 'object') return
    const text = String(value).trim()
    if (text) {
      fragments.push(`${label}：${text}`)
    }
  }

  append('对象', directoryActivitySubjectLabel(item))
  append('来源', readString(item.actionDetails, ['source']))
  append('匹配方式', readString(item.actionDetails, ['strategy']))
  append('本地账号', readString(item.actionDetails, ['localUserId', 'local_user_id']))
  append('变更原因', readString(item.actionDetails, ['changeReason', 'change_reason', 'reason']))
  append('统计', item.action === 'sync' || item.action === 'schedule'
    ? JSON.stringify(toRecord(item.actionDetails.stats))
    : '')

  return fragments.join(' · ') || '无补充摘要'
}

function normalizeDepartment(item: Record<string, unknown>): DirectoryDepartment {
  return {
    id: readString(item, ['id']),
    externalDepartmentId: readString(item, ['externalDepartmentId', 'external_department_id']),
    name: readString(item, ['name']),
    fullPath: readString(item, ['fullPath', 'full_path']),
    isActive: readBoolean(item, ['isActive', 'is_active'], true),
    orderIndex: readNumber(item, ['orderIndex', 'order_index']),
    lastSeenAt: readString(item, ['lastSeenAt', 'last_seen_at']),
  }
}

function normalizeLinkedUser(item: unknown): DirectoryLinkedUser | null {
  const record = toRecord(item)
  if (!record.id && !record.email) return null
  return {
    id: readString(record, ['id']),
    email: readString(record, ['email']),
    name: readString(record, ['name']),
    isActive: readBoolean(record, ['isActive', 'is_active'], true),
  }
}

function normalizeAccount(item: Record<string, unknown>): DirectoryAccount {
  const linkedUser = normalizeLinkedUser(item.linkedUser || item.linked_user)
  const departments = Array.isArray(item.departmentNames)
    ? item.departmentNames.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : Array.isArray(item.departments)
      ? item.departments
          .map((department) => {
            const record = toRecord(department)
            return readString(record, ['name', 'fullPath', 'full_path'])
          })
          .filter((value): value is string => value.length > 0)
      : []

  return {
    id: readString(item, ['id']),
    externalUserId: readString(item, ['externalUserId', 'external_user_id']),
    name: readString(item, ['name']),
    nick: readString(item, ['nick', 'nickname']),
    email: readString(item, ['email']),
    mobile: readString(item, ['mobile']),
    jobNumber: readString(item, ['jobNumber', 'job_number']),
    title: readString(item, ['title']),
    avatarUrl: readString(item, ['avatarUrl', 'avatar_url']),
    isActive: readBoolean(item, ['isActive', 'is_active'], true),
    matchStatus: readString(item, ['matchStatus', 'match_status', 'linkStatus', 'link_status'], 'pending'),
    matchStatusLabel: statusLabel(readString(item, ['matchStatus', 'match_status', 'linkStatus', 'link_status'], 'pending')),
    matchStrategy: readString(item, ['matchStrategy', 'match_strategy']),
    matchStrategyLabel: readString(item, ['matchStrategyLabel', 'match_strategy_label']) || matchStrategyLabel(readString(item, ['matchStrategy', 'match_strategy'])),
    linkStatus: readString(item, ['linkStatus', 'link_status'], 'pending'),
    linkStatusLabel: statusLabel(readString(item, ['linkStatus', 'link_status'], 'pending')),
    dingtalkAuthEnabled: readBoolean(item, ['dingtalkAuthEnabled', 'dingtalk_auth_enabled']),
    isBound: readBoolean(item, ['isBound', 'is_bound']),
    deprovisionPolicyOverride: readNullablePolicies(item, ['deprovisionPolicyOverride', 'deprovision_policy_override']),
    effectiveDeprovisionPolicy: readPolicies(item, ['effectiveDeprovisionPolicy', 'effective_deprovision_policy'], []),
    departmentNames: departments,
    linkedUser,
  }
}

function applyIntegrationDraft(integration: DirectoryIntegration | null): void {
  selectedIntegrationId.value = integration?.id || ''
  draft.name = integration?.name || ''
  draft.corpId = integration?.corpId || ''
  draft.appKey = integration?.appKey || ''
  draft.appSecret = integration?.appSecret || ''
  draft.rootDepartmentId = integration?.rootDepartmentId || ''
  draft.scheduleCron = integration?.scheduleCron || ''
  draft.syncEnabled = integration?.syncEnabled ?? true
  draft.captureUnboundLogins = integration?.captureUnboundLogins ?? true
  draft.defaultDeprovisionPolicy = copyPolicies(integration?.defaultDeprovisionPolicy, DEFAULT_DEPROVISION_POLICY)
  selectedDeprovisionPolicy.value = copyPolicies(integration?.defaultDeprovisionPolicy, DEFAULT_DEPROVISION_POLICY)
  useDefaultDeprovisionPolicy.value = true
}

function resetDraft(): void {
  applyIntegrationDraft(selectedIntegration.value)
}

function updateDraftDeprovisionPolicy(policy: DeprovisionPolicyAction, enabled: boolean): void {
  draft.defaultDeprovisionPolicy = togglePolicy(draft.defaultDeprovisionPolicy, policy, enabled)
}

function updateSelectedDeprovisionPolicy(policy: DeprovisionPolicyAction, enabled: boolean): void {
  selectedDeprovisionPolicy.value = togglePolicy(selectedDeprovisionPolicy.value, policy, enabled)
}

function applyDraftPreset(policies: DeprovisionPolicy): void {
  draft.defaultDeprovisionPolicy = copyPolicies(policies, [])
}

function applySelectedPreset(policies: DeprovisionPolicy): void {
  useDefaultDeprovisionPolicy.value = false
  selectedDeprovisionPolicy.value = copyPolicies(policies, [])
}

function resetAccountFilters(): void {
  accountSearch.value = ''
  accountStatusFilter.value = 'all'
  accountMatchStrategyFilter.value = ''
  accountDingtalkAuthFilter.value = 'all'
  accountBindingFilter.value = 'all'
  accountDepartmentFilter.value = ''
}

function applyQuickFilter(filter: AccountQuickFilter): void {
  resetAccountFilters()
  if (filter === 'pending') {
    accountStatusFilter.value = 'pending'
  } else if (filter === 'bound') {
    accountBindingFilter.value = 'bound'
  } else if (filter === 'dingtalk-disabled') {
    accountDingtalkAuthFilter.value = 'disabled'
  }
  handleAccountFilterChange()
}

function isAccountSelected(accountId: string): boolean {
  return selectedAccountIds.value.includes(accountId)
}

function toggleSelectedAccount(accountId: string, enabled: boolean): void {
  if (enabled) {
    if (!selectedAccountIds.value.includes(accountId)) {
      selectedAccountIds.value = [...selectedAccountIds.value, accountId]
    }
    return
  }

  selectedAccountIds.value = selectedAccountIds.value.filter((value) => value !== accountId)
}

function toggleSelectAllVisible(enabled: boolean): void {
  if (!enabled) {
    selectedAccountIds.value = selectedAccountIds.value.filter((id) =>
      !filteredAccounts.value.some((account) => account.id === id),
    )
    return
  }

  const merged = new Set(selectedAccountIds.value)
  for (const account of filteredAccounts.value) {
    merged.add(account.id)
  }
  selectedAccountIds.value = Array.from(merged)
}

function clearSelectedAccounts(): void {
  selectedAccountIds.value = []
}

function setUseDefaultDeprovisionPolicy(enabled: boolean): void {
  useDefaultDeprovisionPolicy.value = enabled
  if (enabled) {
    selectedDeprovisionPolicy.value = copyPolicies(selectedIntegration.value?.defaultDeprovisionPolicy, DEFAULT_DEPROVISION_POLICY)
  }
}

function startCreateIntegration(): void {
  if (directoryTemplateCenterSaveTimer) {
    clearTimeout(directoryTemplateCenterSaveTimer)
    directoryTemplateCenterSaveTimer = null
  }
  selectedIntegrationId.value = ''
  applyIntegrationDraft(null)
  runs.value = []
  departments.value = []
  accounts.value = []
  directoryTemplateCenter.value = null
  directoryTemplateCenterVersions.value = []
  directoryTemplateGovernanceReport.value = null
  directoryScheduleStatus.value = null
  directorySyncAlerts.value = []
  directoryActivityItems.value = []
  directoryActivityTotal.value = 0
  directoryActivityPage.value = 1
  directoryActivityPageCount.value = 1
  directoryActivityHasNextPage.value = false
  directoryActivityHasPreviousPage.value = false
  directoryActivitySummary.value = {
    total: 0,
    integrationActions: 0,
    accountActions: 0,
    syncActions: 0,
    alertActions: 0,
    templateActions: 0,
  }
  directoryTemplateCenterLoaded.value = false
  directoryTemplateCenterSyncError.value = ''
  selectedAccountIds.value = []
  selectedAccountId.value = ''
  manualLinkUserId.value = ''
  provisionEmail.value = ''
  provisionName.value = ''
  provisionAuthorizeDingtalk.value = true
  provisionedTemporaryPassword.value = ''
  provisionedUserEmail.value = ''
  selectedDeprovisionPolicy.value = [...DEFAULT_DEPROVISION_POLICY]
  useDefaultDeprovisionPolicy.value = true
  batchFailureFilterActive.value = false
  batchFailureReasonFilter.value = ''
  resetBatchFailureReasonNoteOutputMode()
  resetBatchFailureReasonNotePreset()
  resetBatchFailureReasonNoteContext()
  accountsPage.value = 1
  accountsTotal.value = 0
  accountsPageCount.value = 1
  accountsHasNextPage.value = false
  accountsHasPreviousPage.value = false
  accountSummary.value = {
    total: 0,
    linked: 0,
    pending: 0,
    conflict: 0,
    ignored: 0,
    active: 0,
    inactive: 0,
    dingtalkAuthEnabled: 0,
    dingtalkAuthDisabled: 0,
    bound: 0,
    unbound: 0,
  }
}

async function loadIntegrationResources(integrationId: string): Promise<void> {
  if (!integrationId) {
    runs.value = []
    departments.value = []
    accounts.value = []
    directoryTemplateCenter.value = null
    directoryTemplateCenterVersions.value = []
    directoryTemplateGovernanceReport.value = null
    directoryScheduleStatus.value = null
    directorySyncAlerts.value = []
    directoryActivityItems.value = []
    directoryActivityTotal.value = 0
    directoryActivityPageCount.value = 1
    directoryActivityHasNextPage.value = false
    directoryActivityHasPreviousPage.value = false
    directoryActivitySummary.value = {
      total: 0,
      integrationActions: 0,
      accountActions: 0,
      syncActions: 0,
      alertActions: 0,
      templateActions: 0,
    }
    directoryTemplateCenterLoaded.value = false
    directoryTemplateCenterSyncError.value = ''
    selectedAccountIds.value = []
    selectedAccountId.value = ''
    return
  }

  const [runsResponse, departmentsResponse] = await Promise.all([
    apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/runs`),
    apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/departments`),
  ])

  const [runsPayload, departmentsPayload] = await Promise.all([
    readJson(runsResponse),
    readJson(departmentsResponse),
  ])

  if (!runsResponse.ok || !isOkEnvelope(runsPayload)) {
    throw new Error(readErrorMessage(runsPayload, '加载同步运行失败'))
  }
  if (!departmentsResponse.ok || !isOkEnvelope(departmentsPayload)) {
    throw new Error(readErrorMessage(departmentsPayload, '加载部门目录失败'))
  }

  runs.value = extractListItems(runsPayload).map((item) => normalizeRun(item))
  departments.value = extractListItems(departmentsPayload).map((item) => normalizeDepartment(item))
  await loadAccounts(integrationId)

  const [templateCenterResult, operationsResult, activityResult] = await Promise.allSettled([
    loadDirectoryTemplateCenterResources(integrationId),
    loadDirectoryOperationsResources(integrationId),
    loadDirectoryActivity(integrationId),
  ])

  if (templateCenterResult.status === 'rejected') {
    directoryTemplateCenter.value = null
    directoryTemplateCenterVersions.value = []
    directoryTemplateGovernanceReport.value = null
    directoryTemplateCenterLoaded.value = false
    directoryTemplateCenterSyncError.value = readErrorMessage(templateCenterResult.reason, '加载模板中心失败')
  }

  if (operationsResult.status === 'rejected') {
    directoryScheduleStatus.value = null
    directorySyncAlerts.value = []
  }

  if (activityResult.status === 'rejected') {
    directoryActivityItems.value = []
    directoryActivityTotal.value = 0
    directoryActivityPageCount.value = 1
    directoryActivityHasNextPage.value = false
    directoryActivityHasPreviousPage.value = false
    directoryActivitySummary.value = {
      total: 0,
      integrationActions: 0,
      accountActions: 0,
      syncActions: 0,
      alertActions: 0,
      templateActions: 0,
    }
  }
}

async function loadIntegrations(): Promise<void> {
  loadingIntegrations.value = true
  try {
    const response = await apiFetch('/api/admin/directory/integrations')
    const payload = await readJson(response)
    if (!response.ok || !isOkEnvelope(payload)) {
      throw new Error(readErrorMessage(payload, '加载目录集成失败'))
    }

    integrations.value = extractListItems(payload).map((item) => normalizeIntegration(item))

    const nextSelected = integrations.value.find((item) => item.id === selectedIntegrationId.value) || integrations.value[0] || null
    applyIntegrationDraft(nextSelected)

    if (nextSelected) {
      await loadIntegrationResources(nextSelected.id)
    } else {
      runs.value = []
      departments.value = []
      accounts.value = []
      directoryTemplateCenter.value = null
      directoryTemplateCenterVersions.value = []
      directoryTemplateGovernanceReport.value = null
      directoryScheduleStatus.value = null
      directorySyncAlerts.value = []
      directoryActivityItems.value = []
      directoryActivityTotal.value = 0
      directoryActivityPageCount.value = 1
      directoryActivityHasNextPage.value = false
      directoryActivityHasPreviousPage.value = false
      directoryActivitySummary.value = {
        total: 0,
        integrationActions: 0,
        accountActions: 0,
        syncActions: 0,
        alertActions: 0,
        templateActions: 0,
      }
      directoryTemplateCenterLoaded.value = false
      directoryTemplateCenterSyncError.value = ''
      selectedAccountIds.value = []
      accountsTotal.value = 0
      accountsPageCount.value = 1
      accountsHasNextPage.value = false
      accountsHasPreviousPage.value = false
      selectedAccountId.value = ''
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '加载目录集成失败'), 'error')
  } finally {
    loadingIntegrations.value = false
  }
}

async function selectIntegration(integration: DirectoryIntegration): Promise<void> {
  if (directoryTemplateCenterSaveTimer) {
    clearTimeout(directoryTemplateCenterSaveTimer)
    directoryTemplateCenterSaveTimer = null
  }
  applyIntegrationDraft(integration)
  selectedAccountIds.value = []
  selectedAccountId.value = ''
  manualLinkUserId.value = ''
  provisionEmail.value = ''
  provisionName.value = ''
  provisionAuthorizeDingtalk.value = true
  provisionedTemporaryPassword.value = ''
  provisionedUserEmail.value = ''
  selectedDeprovisionPolicy.value = copyPolicies(integration.defaultDeprovisionPolicy, DEFAULT_DEPROVISION_POLICY)
  useDefaultDeprovisionPolicy.value = true
  batchFailureFilterActive.value = false
  batchFailureReasonFilter.value = ''
  resetBatchFailureReasonNoteOutputMode()
  resetBatchFailureReasonNotePreset()
  resetBatchFailureReasonNoteContext()
  accountsPage.value = 1
  directoryActivityPage.value = 1
  await loadIntegrationResources(integration.id)
}

async function saveIntegration(): Promise<void> {
  if (!canSaveIntegration.value) {
    setStatus('请先补全集成名称、CorpID、AppKey 和 AppSecret。', 'error')
    return
  }

  busy.value = true
  try {
    const isEditing = selectedIntegrationId.value.length > 0
    const payload = {
      name: draft.name.trim(),
      corpId: draft.corpId.trim(),
      appKey: draft.appKey.trim(),
      appSecret: draft.appSecret.trim(),
      rootDepartmentId: draft.rootDepartmentId.trim(),
      scheduleCron: draft.scheduleCron.trim(),
      syncEnabled: draft.syncEnabled,
      captureUnboundLogins: draft.captureUnboundLogins,
      defaultDeprovisionPolicy: draft.defaultDeprovisionPolicy,
    }

    const response = await apiFetch(
      isEditing
        ? `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}`
        : '/api/admin/directory/integrations',
      {
        method: isEditing ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      },
    )
    const body = await readJson(response)
    if (!response.ok || !isOkEnvelope(body)) {
      throw new Error(readErrorMessage(body, '保存集成失败'))
    }

    const nextId = readString(extractSingleItem(body), ['id']) || selectedIntegrationId.value
    if (nextId) {
      selectedIntegrationId.value = nextId
    }
    setStatus(isEditing ? '集成已更新' : '集成已创建')
    await loadIntegrations()
    const latest = integrations.value.find((item) => item.id === (nextId || selectedIntegrationId.value)) || integrations.value[0] || null
    if (latest) {
      applyIntegrationDraft(latest)
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '保存集成失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function syncIntegration(): Promise<void> {
  if (!selectedIntegrationId.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/sync`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok || !isOkEnvelope(body)) {
      statusPermissionHint.value = parseDingTalkPermissionHint(body)
      throw new Error(readErrorMessage(body, '手动同步失败'))
    }

    setStatus('已触发手动同步')
    await loadIntegrationResources(selectedIntegrationId.value)
  } catch (error) {
    if (!statusPermissionHint.value) {
      statusPermissionHint.value = parseDingTalkPermissionHint(error)
    }
    setStatus(readErrorMessage(error, '手动同步失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function loadAccountDetail(integrationId: string, accountId: string): Promise<void> {
  if (!integrationId || !accountId) return
  const response = await apiFetch(
    `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/accounts/${encodeURIComponent(accountId)}`,
  )
  const body = await readJson(response)
  if (!response.ok || !isOkEnvelope(body)) {
    throw new Error(readErrorMessage(body, '加载成员详情失败'))
  }

  const detail = normalizeAccount(extractSingleItem(body))
  const index = accounts.value.findIndex((item) => item.id === accountId)
  if (index >= 0) {
    accounts.value[index] = { ...accounts.value[index], ...detail }
  }
  if (selectedAccountId.value === accountId) {
    useDefaultDeprovisionPolicy.value = detail.deprovisionPolicyOverride === null
    selectedDeprovisionPolicy.value = copyPolicies(
      detail.deprovisionPolicyOverride ?? detail.effectiveDeprovisionPolicy,
      DEFAULT_DEPROVISION_POLICY,
    )
  }
}

async function selectAccount(account: DirectoryAccount): Promise<void> {
  selectedAccountId.value = account.id
  manualLinkUserId.value = account.linkedUser?.id || ''
  provisionEmail.value = account.email || ''
  provisionName.value = account.name || account.nick || ''
  provisionAuthorizeDingtalk.value = !account.dingtalkAuthEnabled
  provisionedTemporaryPassword.value = ''
  provisionedUserEmail.value = ''
  useDefaultDeprovisionPolicy.value = account.deprovisionPolicyOverride === null
  selectedDeprovisionPolicy.value = copyPolicies(
    account.deprovisionPolicyOverride ?? selectedIntegration.value?.defaultDeprovisionPolicy,
    DEFAULT_DEPROVISION_POLICY,
  )

  try {
    await loadAccountDetail(selectedIntegrationId.value, account.id)
    if (directoryActivityScopeFilter.value === 'selected-account') {
      directoryActivityPage.value = 1
      await loadDirectoryActivity(selectedIntegrationId.value)
    }
  } catch (error) {
    setStatus(readErrorMessage(error, '加载成员详情失败'), 'error')
  }
}

async function performAccountMutation(
  integrationId: string,
  accountId: string,
  actionPath: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const response = await apiFetch(
    `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/accounts/${encodeURIComponent(accountId)}/${actionPath}`,
    {
      method: 'POST',
      body: payload ? JSON.stringify(payload) : undefined,
    },
  )
  const body = await readJson(response)
  if (!response.ok || !isOkEnvelope(body)) {
    throw new Error(readErrorMessage(body, '成员操作失败'))
  }
}

async function mutateAccount(actionPath: string, payload?: Record<string, unknown>, successMessage = '成员操作已完成'): Promise<void> {
  if (!selectedIntegrationId.value || !selectedAccountId.value) return
  busy.value = true
  try {
    await performAccountMutation(selectedIntegrationId.value, selectedAccountId.value, actionPath, payload)
    setStatus(successMessage)
    await loadIntegrationResources(selectedIntegrationId.value)
  } catch (error) {
    setStatus(readErrorMessage(error, '成员操作失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function mutateSelectedAccounts(
  accountsToProcess: DirectoryAccount[],
  actionPath: string,
  payload: Record<string, unknown> | undefined,
  successLabel: string,
): Promise<void> {
  if (!selectedIntegrationId.value) return
  if (accountsToProcess.length === 0) {
    setStatus(`当前选择中没有可执行“${successLabel}”的成员。`, 'error')
    return
  }

  busy.value = true
  try {
    const integrationId = selectedIntegrationId.value
    const results = await Promise.allSettled(
      accountsToProcess.map((account) => performAccountMutation(integrationId, account.id, actionPath, payload)),
    )
    recordBatchResult(successLabel, accountsToProcess, results, '成员操作失败')
    const successCount = results.filter((result) => result.status === 'fulfilled').length
    const failureMessages = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => readErrorMessage(result.reason, '成员操作失败'))

    if (successCount > 0) {
      selectedAccountIds.value = selectedAccountIds.value.filter((id) => !accountsToProcess.some((account) => account.id === id))
      await loadIntegrationResources(integrationId)
    }

    if (failureMessages.length > 0) {
      setStatus(
        successCount > 0
          ? `${successLabel}：成功 ${successCount} 项，失败 ${failureMessages.length} 项；${failureMessages[0]}`
          : `${successLabel}失败：${failureMessages[0]}`,
        'error',
      )
      return
    }

    setStatus(`${successLabel}：已处理 ${successCount} 项`)
  } catch (error) {
    setStatus(readErrorMessage(error, `${successLabel}失败`), 'error')
  } finally {
    busy.value = false
  }
}

async function provisionAccountList(
  accountsToProcess: DirectoryAccount[],
  authorizeDingtalk: boolean,
  successLabel: string,
  emptyMessage: string,
): Promise<void> {
  if (!selectedIntegrationId.value) return
  if (accountsToProcess.length === 0) {
    setStatus(emptyMessage, 'error')
    return
  }

  busy.value = true
  try {
    const integrationId = selectedIntegrationId.value
    const results = await Promise.allSettled(
      accountsToProcess.map((account) =>
        performAccountMutation(integrationId, account.id, 'provision-user', {
          email: account.email || undefined,
          name: account.name || account.nick || undefined,
          authorizeDingTalk: authorizeDingtalk,
        }),
      ),
    )
    recordBatchResult(successLabel, accountsToProcess, results, '目录开户失败')
    const successCount = results.filter((result) => result.status === 'fulfilled').length
    const failureMessages = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => readErrorMessage(result.reason, '目录开户失败'))

    if (successCount > 0) {
      selectedAccountIds.value = selectedAccountIds.value.filter((id) => !accountsToProcess.some((account) => account.id === id))
      await loadIntegrationResources(integrationId)
    }
    if (failureMessages.length > 0) {
      setStatus(
        successCount > 0
          ? `${successLabel}：成功 ${successCount} 项，失败 ${failureMessages.length} 项；${failureMessages[0]}`
          : `${successLabel}失败：${failureMessages[0]}`,
        'error',
      )
      return
    }

    setStatus(`${successLabel}：已处理 ${successCount} 项`)
  } catch (error) {
    setStatus(readErrorMessage(error, `${successLabel}失败`), 'error')
  } finally {
    busy.value = false
  }
}

async function linkExisting(): Promise<void> {
  const userId = manualLinkUserId.value.trim()
  if (!userId) {
    setStatus('请先填写要关联的本地用户 ID。', 'error')
    return
  }
  await mutateAccount('link-existing', { userId }, '账号关联已完成')
}

async function autoLinkByEmail(): Promise<void> {
  if (!selectedAccount.value?.email) {
    setStatus('当前目录成员缺少可用邮箱，无法按邮箱关联。', 'error')
    return
  }
  await mutateAccount('auto-link-by-email', undefined, '已按邮箱关联已有账号')
}

async function provisionUser(): Promise<void> {
  if (!selectedIntegrationId.value || !selectedAccountId.value) return
  const email = provisionEmail.value.trim()

  busy.value = true
  try {
    const response = await apiFetch(
      `/api/admin/directory/integrations/${encodeURIComponent(selectedIntegrationId.value)}/accounts/${encodeURIComponent(selectedAccountId.value)}/provision-user`,
      {
        method: 'POST',
        body: JSON.stringify({
          email: email || undefined,
          name: provisionName.value.trim() || selectedAccount.value?.name || selectedAccount.value?.nick || '',
          authorizeDingTalk: provisionAuthorizeDingtalk.value,
        }),
      },
    )
    const body = await readJson(response)
    if (!response.ok || !isOkEnvelope(body)) {
      throw new Error(readErrorMessage(body, '目录开户失败'))
    }

    const data = extractSingleItem(body)
    provisionedTemporaryPassword.value = readString(data, ['temporaryPassword', 'temporary_password'])
    provisionedUserEmail.value = readString(toRecord(data.user), ['email'], email)
    setStatus(
      provisionedTemporaryPassword.value
        ? (provisionAuthorizeDingtalk.value ? '本地账号已开通并授权钉钉，临时密码已生成' : '本地账号已开通，临时密码已生成')
        : (provisionAuthorizeDingtalk.value ? '本地账号已开通并授权钉钉' : '本地账号已开通'),
    )
    await loadIntegrationResources(selectedIntegrationId.value)
  } catch (error) {
    setStatus(readErrorMessage(error, '目录开户失败'), 'error')
  } finally {
    busy.value = false
  }
}

async function authorizeDingtalk(): Promise<void> {
  await mutateAccount('authorize-dingtalk', {
    enabled: !(selectedAccount.value?.dingtalkAuthEnabled === true),
  }, selectedAccount.value?.dingtalkAuthEnabled ? '钉钉授权已取消' : '钉钉授权已开启')
}

async function ignoreAccount(): Promise<void> {
  await mutateAccount('ignore', undefined, '成员已忽略')
}

async function unlinkAccount(): Promise<void> {
  await mutateAccount('unlink', undefined, '绑定已解除')
}

async function saveDeprovisionPolicy(): Promise<void> {
  await mutateAccount('deprovision-policy', {
    policy: useDefaultDeprovisionPolicy.value ? null : selectedDeprovisionPolicy.value,
  }, '离职策略已保存')
}

async function batchAuthorizeDingtalk(enabled: boolean): Promise<void> {
  await mutateSelectedAccounts(
    enabled ? batchAuthorizeEligible.value : batchRevokeEligible.value,
    'authorize-dingtalk',
    { enabled },
    enabled ? '批量授权钉钉登录' : '批量取消钉钉授权',
  )
}

async function batchIgnoreAccounts(): Promise<void> {
  await mutateSelectedAccounts(batchIgnoreEligible.value, 'ignore', undefined, '批量忽略')
}

async function batchUnlinkAccounts(): Promise<void> {
  await mutateSelectedAccounts(batchUnlinkEligible.value, 'unlink', undefined, '批量解除绑定')
}

async function batchProvisionUsers(authorizeDingtalk: boolean): Promise<void> {
  await provisionAccountList(
    batchProvisionEligible.value,
    authorizeDingtalk,
    authorizeDingtalk ? '批量开通并授权' : '批量开通账号',
    '当前选择中没有可开户的成员。',
  )
}

async function batchAutoLinkByEmail(): Promise<void> {
  await mutateSelectedAccounts(batchAutoLinkByEmailEligible.value, 'auto-link-by-email', undefined, '按邮箱批量关联')
}

async function runBatchRecommendation(key: BatchRecommendationKey): Promise<void> {
  const recommendation = batchRecommendationGroups.value.find((item) => item.key === key)
  if (!recommendation || recommendation.accounts.length === 0) {
    setStatus('当前推荐动作没有可处理的成员。', 'error')
    return
  }

  if (key === 'auto-link') {
    selectedAccountIds.value = recommendation.accounts.map((item) => item.id)
    await mutateSelectedAccounts(recommendation.accounts, 'auto-link-by-email', undefined, recommendation.label)
    return
  }
  if (key === 'provision-authorize') {
    selectedAccountIds.value = recommendation.accounts.map((item) => item.id)
    await provisionAccountList(
      recommendation.accounts,
      true,
      recommendation.label,
      '当前失败成员中没有可直接开通的成员。',
    )
    return
  }

  selectedAccountIds.value = recommendation.accounts.map((item) => item.id)
  await mutateSelectedAccounts(
    recommendation.accounts,
    'authorize-dingtalk',
    { enabled: true },
    recommendation.label,
  )
}

onMounted(() => {
  void loadIntegrations()
})

onBeforeUnmount(() => {
  if (directoryTemplateCenterSaveTimer) {
    clearTimeout(directoryTemplateCenterSaveTimer)
    directoryTemplateCenterSaveTimer = null
  }
})
</script>

<style scoped>
.directory-admin {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 28px;
}

.directory-admin__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.directory-admin__header h1 {
  margin: 0 0 8px;
  font-size: 32px;
}

.directory-admin__header p {
  margin: 0;
  color: #5b6577;
}

.directory-admin__actions,
.directory-admin__footer,
.directory-admin__chip-row,
.directory-admin__filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.directory-admin__button {
  border: 1px solid #1f5eff;
  border-radius: 10px;
  background: #1f5eff;
  color: #fff;
  padding: 10px 16px;
  font-weight: 600;
  cursor: pointer;
}

.directory-admin__button--secondary {
  background: #fff;
  color: #1b2430;
  border-color: #d6dae4;
}

.directory-admin__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.directory-admin__status {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: #eef4ff;
  color: #12306c;
}

.directory-admin__status--error {
  background: #fff0f0;
  color: #b42318;
}

.directory-admin__remediation {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #f3d4a5;
  background: #fff8eb;
  color: #8a4b08;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.directory-admin__remediation--inline {
  margin-top: 10px;
}

.directory-admin__remediation-title {
  margin: 0;
  font-weight: 600;
}

.directory-admin__remediation p {
  margin: 0;
}

.directory-admin__remediation-link {
  color: #9a3412;
  font-weight: 600;
}

.directory-admin__layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 20px;
}

.directory-admin__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.directory-admin__summary-card {
  background: #f8fafc;
  border: 1px solid #e5e7ef;
  border-radius: 14px;
  padding: 14px;
  color: #1f2937;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.04);
}

.directory-admin__summary-card--run {
  background: #eef2ff;
}

.directory-admin__summary-status {
  margin: 6px 0;
  font-weight: 600;
}

.directory-admin__summary-status--success {
  color: #047857;
}

.directory-admin__quick-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.directory-admin__batch-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.directory-admin__batch-result {
  border: 1px solid #d6dae4;
  border-radius: 16px;
  background: #f8fafc;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.directory-admin__batch-history {
  border: 1px solid #e5e7ef;
  border-radius: 16px;
  background: #fff;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.directory-admin__batch-history-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.directory-admin__batch-history-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  align-items: center;
}

.directory-admin__batch-history-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.directory-admin__batch-history-item {
  min-width: 220px;
  text-align: left;
  border: 1px solid #d6dae4;
  border-radius: 12px;
  background: #f8fafc;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.directory-admin__batch-history-item-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.directory-admin__batch-history-item--active {
  border-color: #1f5eff;
  background: #eef4ff;
}

.directory-admin__batch-history-item--failed {
  border-color: #f1c0b8;
  background: #fff6f5;
}

.directory-admin__batch-history-item span,
.directory-admin__batch-history-item small {
  color: #667085;
}

.directory-admin__batch-history-item--import {
  cursor: default;
  min-width: 280px;
  flex: 1 1 280px;
}

.directory-admin__batch-note-import-history {
  margin-top: 6px;
}

.directory-admin__batch-note-import-presets {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.directory-admin__batch-note-import-preset-group {
  border-top: 1px dashed #e5e7ef;
  padding-top: 10px;
}

.directory-admin__batch-note-import-history-actions {
  margin-top: 4px;
}

.directory-admin__batch-note-diff {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-note-diff-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.directory-admin__batch-note-diff-list--history {
  margin-top: 2px;
}

.directory-admin__batch-note-diff-item {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  border-radius: 10px;
  padding: 6px 8px;
  background: #f8fafc;
}

.directory-admin__batch-note-diff-item--added {
  background: #ecfdf3;
}

.directory-admin__batch-note-diff-item--removed {
  background: #fff7ed;
}

.directory-admin__batch-note-diff-item--changed {
  background: #eef4ff;
}

.directory-admin__batch-note-diff-item--ignored {
  opacity: 0.72;
  border: 1px dashed #c7cedb;
}

.directory-admin__batch-history-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #d92d20;
  color: #fff;
  padding: 2px 8px;
  font-size: 12px;
  font-style: normal;
  font-weight: 600;
  line-height: 1.4;
}

.directory-admin__batch-result--success {
  border-color: #b7e4c7;
  background: #f1fbf4;
}

.directory-admin__batch-result--error {
  border-color: #f1c0b8;
  background: #fff6f5;
}

.directory-admin__batch-result-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.directory-admin__batch-result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.directory-admin__batch-result-head strong,
.directory-admin__batch-result-head p,
.directory-admin__batch-result-summary {
  margin: 0;
}

.directory-admin__batch-result-head p {
  color: #667085;
}

.directory-admin__batch-result-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-failure-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-failure-group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-failure-group-list li {
  margin: 0;
}

.directory-admin__batch-failure-group-button {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  border: 1px solid #f1d1cb;
  border-radius: 10px;
  background: #fff;
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
}

.directory-admin__batch-failure-group-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.directory-admin__batch-failure-group-list span {
  color: #667085;
}

.directory-admin__batch-failure-group-copy small {
  color: #98a2b3;
}

.directory-admin__batch-failure-group-button--active {
  border-color: #d92d20;
  background: #fff0f0;
}

.directory-admin__batch-note {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid #f1d1cb;
  border-radius: 12px;
  padding: 12px;
  background: #fffaf9;
}

.directory-admin__batch-note-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.directory-admin__batch-note-head p {
  margin: 4px 0 0;
}

.directory-admin__batch-note-presets {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-note-output {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-note-presets p {
  margin: 0;
}

.directory-admin__batch-note-output p {
  margin: 0;
}

.directory-admin__batch-note-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.directory-admin__batch-note-snippets {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__batch-note-snippets > span {
  font-size: 14px;
  color: #344054;
  font-weight: 600;
}

.directory-admin__batch-note-preview {
  margin: 0;
  white-space: pre-wrap;
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #344054;
}

.directory-admin__batch-result-list li {
  color: #344054;
}

.directory-admin__batch-result-list span {
  color: #667085;
  margin-left: 8px;
}

.directory-admin__filter-row--wrap {
  flex-wrap: wrap;
}

.directory-admin__preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.directory-admin__preset {
  border: 1px solid #d6dae4;
  border-radius: 999px;
  background: #fff;
  color: #334155;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.directory-admin__preset--active {
  border-color: #1f5eff;
  background: #eef4ff;
  color: #12306c;
}

.directory-admin__policy-group {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}

.directory-admin__policy-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #d6dae4;
  border-radius: 12px;
  background: #f8fafc;
  color: #1f2937;
}

.directory-admin__policy-option--inline {
  margin-top: 8px;
}

.directory-admin__policy-option input {
  margin: 0;
}

.directory-admin__pager {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed #e5e7ef;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.directory-admin__pager-actions {
  display: flex;
  gap: 8px;
}

.directory-admin__panel {
  background: #fff;
  border: 1px solid #e5e7ef;
  border-radius: 18px;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.04);
}

.directory-admin__panel--sidebar {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.directory-admin__panel--content {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.directory-admin__section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.directory-admin__section-head,
.directory-admin__detail-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.directory-admin__section-head h2,
.directory-admin__detail-head h3 {
  margin: 0 0 4px;
  font-size: 20px;
}

.directory-admin__section-head p,
.directory-admin__detail-head p,
.directory-admin__hint {
  margin: 0;
  color: #667085;
}

.directory-admin__item,
.directory-admin__account {
  width: 100%;
  text-align: left;
  border: 1px solid #e5e7ef;
  border-radius: 14px;
  background: #fbfcff;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}

.directory-admin__item--active,
.directory-admin__account--active {
  border-color: #1f5eff;
  background: #eef4ff;
}

.directory-admin__item strong,
.directory-admin__account strong {
  font-size: 15px;
}

.directory-admin__item span,
.directory-admin__account span,
.directory-admin__item small,
.directory-admin__account small {
  color: #667085;
}

.directory-admin__department,
.directory-admin__run,
.directory-admin__info-card {
  border: 1px solid #edf0f5;
  border-radius: 14px;
  background: #fafbfe;
  padding: 14px;
}

.directory-admin__department p,
.directory-admin__info-card p,
.directory-admin__run p {
  margin: 6px 0 0;
  color: #667085;
}

.directory-admin__empty {
  padding: 16px;
  border-radius: 12px;
  background: #f7f8fb;
  color: #667085;
}

.directory-admin__empty--panel {
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.directory-admin__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.directory-admin__form-grid--actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.directory-admin__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__field > span {
  font-size: 14px;
  color: #344054;
  font-weight: 600;
}

.directory-admin__field--checkbox {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.directory-admin__input {
  width: 100%;
  border: 1px solid #d6dae4;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fff;
  font: inherit;
}

.directory-admin__input--textarea {
  min-height: 88px;
  resize: vertical;
}

.directory-admin__input--compact {
  min-width: 220px;
}

.directory-admin__footer {
  align-items: center;
}

.directory-admin__footer--wrap {
  justify-content: flex-start;
}

.directory-admin__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 6px 10px;
  background: #eef4ff;
  color: #12306c;
  font-size: 12px;
}

.directory-admin__run-head,
.directory-admin__account-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}

.directory-admin__run-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-top: 10px;
  color: #667085;
  font-size: 13px;
}

.directory-admin__run-error {
  margin-top: 10px;
  color: #b42318;
}

.directory-admin__activity {
  gap: 10px;
}

.directory-admin__activity-summary {
  margin-top: 10px;
}

.directory-admin__split {
  display: grid;
  grid-template-columns: 1fr minmax(340px, 420px);
  gap: 16px;
}

.directory-admin__accounts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__account-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: flex-start;
}

.directory-admin__account-card--active .directory-admin__selection-toggle--account {
  border-color: #1f5eff;
  background: #eef4ff;
  color: #12306c;
}

.directory-admin__selection-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #d6dae4;
  border-radius: 12px;
  background: #fff;
  color: #344054;
  font-weight: 600;
}

.directory-admin__selection-toggle input {
  margin: 0;
}

.directory-admin__selection-toggle--account {
  margin-top: 6px;
}

.directory-admin__detail {
  border: 1px solid #edf0f5;
  border-radius: 16px;
  padding: 16px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.directory-admin__detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1180px) {
  .directory-admin__layout,
  .directory-admin__split,
  .directory-admin__form-grid,
  .directory-admin__batch-note-fields,
  .directory-admin__detail-grid {
    grid-template-columns: 1fr;
  }

  .directory-admin__account-card {
    grid-template-columns: 1fr;
  }

  .directory-admin__input--compact {
    min-width: 0;
    width: 100%;
  }

  .directory-admin__header,
  .directory-admin__section-head,
  .directory-admin__detail-head {
    flex-direction: column;
  }
}
</style>

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

    <article v-if="manualAdmissionResult" class="directory-admin__progress-card">
      <div class="directory-admin__section-head">
        <div>
          <h2>最近创建并绑定结果</h2>
          <p class="directory-admin__hint">
            {{
              manualAdmissionResult.bound
                ? `已为目录成员 ${manualAdmissionResult.accountName} 创建本地用户并完成绑定。`
                : `已为目录成员 ${manualAdmissionResult.accountName} 创建本地用户，但目录绑定仍需继续处理。`
            }}
          </p>
        </div>
        <div class="directory-admin__actions">
          <router-link
            class="directory-admin__button directory-admin__button--secondary"
            :to="buildUserManagementLocation(manualAdmissionResult.userId, { id: manualAdmissionResult.accountId, integrationId: manualAdmissionResult.integrationId })"
          >
            查看本地用户
          </router-link>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearManualAdmissionResult()">
            关闭结果
          </button>
        </div>
      </div>
      <div class="directory-admin__account-grid">
        <div>
          <strong>本地用户</strong>
          <div>{{ manualAdmissionResult.userName || manualAdmissionResult.email || manualAdmissionResult.username || manualAdmissionResult.mobile || manualAdmissionResult.userId }}</div>
        </div>
        <div>
          <strong>登录账号</strong>
          <div>{{ manualAdmissionResult.email || manualAdmissionResult.username || manualAdmissionResult.mobile || manualAdmissionResult.userId }}</div>
        </div>
        <div>
          <strong>用户 ID</strong>
          <div>{{ manualAdmissionResult.userId }}</div>
        </div>
        <div>
          <strong>手机号</strong>
          <div>{{ manualAdmissionResult.mobile || '未填写' }}</div>
        </div>
      </div>
      <p v-if="manualAdmissionResult.temporaryPassword" class="directory-admin__status">
        新用户临时密码：{{ manualAdmissionResult.temporaryPassword }}
      </p>
      <p v-if="manualAdmissionResult.mobileBackfillError" class="directory-admin__status directory-admin__status--error">
        手机号未自动回填：{{ manualAdmissionResult.mobileBackfillError }}
      </p>
      <p v-else-if="manualAdmissionResult.mobile" class="directory-admin__hint">
        {{ manualAdmissionResult.mobileBackfilled ? '目录手机号已回填到新用户资料。' : '目录手机号未回填到新用户资料。' }}
      </p>
      <p v-if="manualAdmissionResult.bindError" class="directory-admin__status directory-admin__status--error">
        目录绑定未完成：{{ manualAdmissionResult.bindError }}
      </p>
      <p v-if="manualAdmissionResult.onboarding?.acceptInviteUrl" class="directory-admin__hint">
        邀请链接：
        <a :href="manualAdmissionResult.onboarding.acceptInviteUrl" target="_blank" rel="noreferrer">
          {{ manualAdmissionResult.onboarding.acceptInviteUrl }}
        </a>
      </p>
      <pre v-if="manualAdmissionResult.onboarding?.inviteMessage" class="directory-admin__invite">
{{ manualAdmissionResult.onboarding.inviteMessage }}
      </pre>
    </article>

    <article v-if="autoAdmissionOnboardingPackets.length > 0" class="directory-admin__progress-card">
      <div class="directory-admin__section-head">
        <div>
          <h2>本次自动准入临时凭据</h2>
          <p class="directory-admin__hint">以下无邮箱目录成员已自动创建本地用户，请通过安全渠道下发登录账号与临时密码。</p>
        </div>
        <div class="directory-admin__actions">
          <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearAutoAdmissionOnboardingPackets()">
            关闭结果
          </button>
        </div>
      </div>

      <article
        v-for="packet in autoAdmissionOnboardingPackets"
        :key="packet.userId"
        class="directory-admin__review-admission"
      >
        <div class="directory-admin__account-grid">
          <div>
            <strong>本地用户</strong>
            <div>{{ packet.name || packet.email || packet.username || packet.mobile || packet.userId }}</div>
          </div>
          <div>
            <strong>登录账号</strong>
            <div>{{ packet.email || packet.username || packet.mobile || packet.userId }}</div>
          </div>
          <div>
            <strong>用户 ID</strong>
            <div>{{ packet.userId }}</div>
          </div>
          <div>
            <strong>手机号</strong>
            <div>{{ packet.mobile || '未填写' }}</div>
          </div>
        </div>
        <p class="directory-admin__status">
          临时密码：{{ packet.temporaryPassword }}
        </p>
        <p v-if="packet.onboarding?.acceptInviteUrl" class="directory-admin__hint">
          邀请链接：
          <a :href="packet.onboarding.acceptInviteUrl" target="_blank" rel="noreferrer">
            {{ packet.onboarding.acceptInviteUrl }}
          </a>
        </p>
        <p v-else class="directory-admin__hint">
          该账号未生成邀请链接，请直接分发登录账号和临时密码。
        </p>
        <pre v-if="packet.onboarding?.inviteMessage" class="directory-admin__invite">
{{ packet.onboarding.inviteMessage }}
        </pre>
      </article>
    </article>

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
          @click="void selectIntegration(integration.id)"
        >
          <strong>{{ integration.name }}</strong>
          <span>{{ integration.corpId }}</span>
          <small>{{ readAdmissionModeLabel(integration) }}</small>
          <small>{{ readMemberGroupSyncLabel(integration) }}</small>
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
          <template v-if="selectedIntegration">
            <label class="directory-admin__field">
              <span>工作通知 Agent ID</span>
              <input v-model.trim="draft.workNotificationAgentId" class="directory-admin__input" type="password" inputmode="numeric" placeholder="不回显已保存值；仅系统管理员填写" />
            </label>
            <label class="directory-admin__field">
              <span>测试接收 DingTalk UserID</span>
              <input v-model.trim="draft.workNotificationTestUserId" class="directory-admin__input" type="text" placeholder="可选；填写后会发送测试工作通知" />
            </label>
          </template>
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
            <span>准入模式</span>
            <select v-model="draft.admissionMode" class="directory-admin__input">
              <option value="manual_only">manual_only</option>
              <option value="auto_for_scoped_departments">auto_for_scoped_departments</option>
            </select>
          </label>
          <label class="directory-admin__field directory-admin__field--wide">
            <span>自动准入部门白名单</span>
            <textarea
              v-model.trim="draft.admissionDepartmentIdsText"
              class="directory-admin__input directory-admin__textarea"
              rows="3"
              placeholder="填写部门 ID，支持逗号或换行分隔；将覆盖所选部门及其子部门"
            />
          </label>
          <label class="directory-admin__field directory-admin__field--wide">
            <span>自动准入排除部门</span>
            <textarea
              v-model.trim="draft.excludeDepartmentIdsText"
              class="directory-admin__input directory-admin__textarea"
              rows="2"
              placeholder="填写需要排除的部门 ID，支持逗号或换行分隔；会覆盖白名单父部门"
            />
          </label>
          <label class="directory-admin__field">
            <span>成员组同步模式</span>
            <select v-model="draft.memberGroupSyncMode" class="directory-admin__input">
              <option value="disabled">disabled</option>
              <option value="sync_scoped_departments">sync_scoped_departments</option>
            </select>
          </label>
          <label class="directory-admin__field directory-admin__field--wide">
            <span>成员组同步部门</span>
            <textarea
              v-model.trim="draft.memberGroupDepartmentIdsText"
              class="directory-admin__input directory-admin__textarea"
              rows="2"
              placeholder="填写需要投影为平台用户组的部门 ID，支持逗号或换行分隔"
            />
          </label>
          <label class="directory-admin__field directory-admin__field--wide">
            <span>成员组默认业务角色</span>
            <textarea
              v-model.trim="draft.memberGroupDefaultRoleIdsText"
              class="directory-admin__input directory-admin__textarea"
              rows="2"
              placeholder="填写 role ID，支持逗号或换行分隔；仅对投影成员组里的已链接用户做单向补齐"
            />
          </label>
          <label class="directory-admin__field directory-admin__field--wide">
            <span>成员组默认插件开通</span>
            <textarea
              v-model.trim="draft.memberGroupDefaultNamespacesText"
              class="directory-admin__input directory-admin__textarea"
              rows="2"
              placeholder="填写命名空间，例如 crm；支持逗号或换行分隔"
            />
          </label>
          <div class="directory-admin__field directory-admin__field--wide">
            <span>组织架构同步说明</span>
            <p class="directory-admin__hint">
              当前方案会把钉钉部门和成员同步到目录镜像，并可将选定部门投影为平台成员组，用于权限、表单和消息治理；不会自动生成第二套可编辑的本地组织树。
            </p>
          </div>
          <div v-if="selectedIntegration" class="directory-admin__field directory-admin__field--wide">
            <span>工作通知配置说明</span>
            <div class="directory-admin__chips">
              <span class="directory-admin__chip" :class="{ 'directory-admin__chip--success': selectedIntegration?.config.workNotificationAgentIdConfigured, 'directory-admin__chip--danger': selectedIntegration && !selectedIntegration.config.workNotificationAgentIdConfigured }">
                {{ selectedIntegration?.config.workNotificationAgentIdConfigured ? 'Agent ID 已保存' : 'Agent ID 未保存' }}
              </span>
              <span class="directory-admin__chip">不回显敏感值</span>
              <span class="directory-admin__chip">保存前先验证 AppKey/AppSecret</span>
            </div>
            <p class="directory-admin__hint">
              Agent ID 来自钉钉开放平台企业内部应用，必须与当前 App Key / App Secret 属于同一个应用；未填写测试接收人时，只做基础连通性验证，不发送真实工作通知。
            </p>
          </div>
          <div v-else class="directory-admin__field directory-admin__field--wide">
            <span>工作通知配置说明</span>
            <p class="directory-admin__hint">
              请先创建并选中钉钉目录集成，再通过专用的“测试工作通知”和“保存 Agent ID”按钮配置工作通知，避免敏感值跟随普通目录保存路径写入。
            </p>
          </div>
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
          <button v-if="selectedIntegration" class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void testWorkNotificationAgentId()">
            测试工作通知
          </button>
          <button v-if="selectedIntegration" class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || draft.workNotificationAgentId.trim().length === 0" @click="void saveWorkNotificationAgentId()">
            保存 Agent ID
          </button>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || !selectedIntegration" @click="void syncIntegration()">
            手动同步
          </button>
        </footer>

        <section v-if="selectedIntegration" ref="accountsSectionRef" class="directory-admin__section">
          <h3>当前概览</h3>
          <div class="directory-admin__chips">
            <span class="directory-admin__chip">部门 {{ selectedIntegration.stats.departmentCount }}</span>
            <span class="directory-admin__chip">账号 {{ selectedIntegration.stats.accountCount }}</span>
            <span class="directory-admin__chip">待确认 {{ selectedIntegration.stats.pendingLinkCount }}</span>
            <span class="directory-admin__chip">已链接 {{ selectedIntegration.stats.linkedCount }}</span>
            <span class="directory-admin__chip">上次成功 {{ formatDateTime(selectedIntegration.lastSuccessAt) }}</span>
            <span class="directory-admin__chip">{{ readAdmissionModeLabel(selectedIntegration) }}</span>
            <span class="directory-admin__chip">{{ readMemberGroupSyncLabel(selectedIntegration) }}</span>
          </div>
          <p v-if="selectedIntegration.lastError" class="directory-admin__status directory-admin__status--error">
            最近错误：{{ selectedIntegration.lastError }}
          </p>
        </section>

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
              <span>当前可见部门 ID 预览</span>
              <textarea
                class="directory-admin__input directory-admin__textarea directory-admin__visible-department-preview"
                :rows="Math.min(visibleDepartmentRows.length, 6)"
                :value="visibleDepartmentIdPreview"
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
              <strong>手动部门 ID</strong>
              <p class="directory-admin__hint">
                适用于钉钉部门暂未同步到本地镜像、但管理员已确认部门 ID 的场景；这里仍只写入当前配置草稿。
              </p>
            </div>
            <div class="directory-admin__manual-department-fields">
              <label class="directory-admin__field">
                <span>部门 ID</span>
                <input
                  v-model.trim="manualDepartmentId"
                  class="directory-admin__input"
                  type="text"
                  placeholder="例如 123456"
                />
              </label>
              <label class="directory-admin__field">
                <span>备注名称（可选）</span>
                <input
                  v-model.trim="manualDepartmentName"
                  class="directory-admin__input"
                  type="text"
                  placeholder="例如 财务共享中心"
                />
              </label>
            </div>
            <div class="directory-admin__department-actions">
              <button
                class="directory-admin__link-button"
                type="button"
                :disabled="manualDepartmentId.trim().length === 0"
                @click="addManualDepartmentToTarget('admission')"
              >
                手动加入准入白名单
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                :disabled="manualDepartmentId.trim().length === 0"
                @click="addManualDepartmentToTarget('exclude')"
              >
                手动加入排除部门
              </button>
              <button
                class="directory-admin__link-button"
                type="button"
                :disabled="manualDepartmentId.trim().length === 0"
                @click="addManualDepartmentToTarget('memberGroup')"
              >
                手动加入成员组同步
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
              部门：{{ item.account.departmentPaths.join('，') || '未分配部门' }}
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
                openId 缺失，当前无法同时开通钉钉登录；请重新同步目录或让用户完成钉钉 OAuth 绑定后再开通。
              </p>
              <p v-if="shouldWarnMissingOpenIdForGrant(item.account)" class="directory-admin__hint">
                修复建议：若该成员刚完成钉钉登录/绑定，先刷新当前成员；若刷新后仍缺失 openId，请检查钉钉目录同步返回值，再决定是否重新同步当前集成。
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
                  <span>用户名（可选）</span>
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
              <p class="directory-admin__hint">姓名必填；邮箱、用户名、手机号至少填写一项。无邮箱用户会走临时密码 + 首登强制改密。</p>
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
              <button
                v-if="focusedVisibleAccount && focusedVisibleAccountBindDraft.length > 0"
                class="directory-admin__button"
                type="button"
                :disabled="bindingAccountId === focusedVisibleAccount.id"
                @click="void bindAccount(focusedVisibleAccount)"
              >
                {{ focusedVisibleAccountBindLabel }}
              </button>
              <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearFocusedAccount()">
                清除定位
              </button>
            </div>
          </article>

          <div v-if="loadingAccounts" class="directory-admin__empty">成员加载中...</div>
          <div v-else-if="accounts.length === 0" class="directory-admin__empty">暂无同步成员</div>
          <article
            v-for="account in accounts"
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
              部门：{{ account.departmentPaths.join('，') || '未分配部门' }}
            </p>
            <div v-if="account.localUser?.id" class="directory-admin__actions">
              <router-link
                class="directory-admin__button directory-admin__button--secondary"
                :to="buildUserManagementLocation(account.localUser.id, account)"
              >
                前往用户管理
              </router-link>
            </div>

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
              <p v-if="shouldWarnMissingOpenIdForGrant(account)" class="directory-admin__status directory-admin__status--error">
                openId 缺失，当前无法同时开通钉钉登录；请重新同步目录或让用户完成钉钉 OAuth 绑定后再开通。
              </p>
              <p v-if="shouldWarnMissingOpenIdForGrant(account)" class="directory-admin__hint">
                修复建议：若该成员刚完成钉钉登录/绑定，先刷新当前成员；若刷新后仍缺失 openId，请检查钉钉目录同步返回值，再决定是否重新同步当前集成。
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
              <p class="directory-admin__hint">从当前钉钉同步成员创建本地用户并立即绑定。邮箱可为空，用户名或手机号可作为登录账号。</p>
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
                  <span>用户名（可选）</span>
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
              <p class="directory-admin__hint">姓名必填；邮箱、用户名、手机号至少填写一项。无邮箱用户会走临时密码 + 首登强制改密。</p>
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
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { apiFetch } from '../utils/api'
import { subscribeToLocationChanges } from '../utils/browserLocation'

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
    workNotificationAgentIdConfigured?: boolean
    rootDepartmentId: string
    baseUrl: string | null
    pageSize: number
    admissionMode: 'manual_only' | 'auto_for_scoped_departments'
    admissionDepartmentIds: string[]
    excludeDepartmentIds: string[]
    memberGroupSyncMode: 'disabled' | 'sync_scoped_departments'
    memberGroupDepartmentIds: string[]
    memberGroupDefaultRoleIds: string[]
    memberGroupDefaultNamespaces: string[]
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

type DirectoryObservationStatus =
  | 'disabled'
  | 'missing_cron'
  | 'invalid_cron'
  | 'awaiting_first_run'
  | 'scheduler_observed'
  | 'configured_no_runs'
  | 'manual_only'
  | 'auto_observed'

type DirectoryScheduleRun = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats: Record<string, unknown>
  errorMessage: string | null
  triggeredBy: string | null
  triggerSource: string
  createdAt: string
  updatedAt: string
}

type DirectoryScheduleSnapshot = {
  integrationId: string
  syncEnabled: boolean
  scheduleCron: string | null
  cronValid: boolean
  nextExpectedRunAt: string | null
  lastRun: DirectoryScheduleRun | null
  lastManualRun: DirectoryScheduleRun | null
  lastAutomaticRun: DirectoryScheduleRun | null
  observationStatus: DirectoryObservationStatus
  observationMessage: string
}

type DirectoryAlertFilter = 'all' | 'pending' | 'acknowledged'
type DirectoryDepartmentScopeFilter = 'all' | 'configured' | 'issues' | 'inactive' | 'unlinked' | 'staleBatch' | DirectoryDepartmentTargetField

type DirectorySyncAlert = {
  id: string
  integrationId: string
  runId: string | null
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  details: Record<string, unknown> | null
  createdAt: string
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

type DirectoryReviewItemFilter = 'all' | 'pending_binding' | 'inactive_linked' | 'missing_identifier'

type DirectoryReviewItem = {
  kind: DirectoryReviewItemFilter
  reason: string
  account: DirectoryAccount
  recommendations: DirectoryBindingRecommendation[]
  recommendationStatus: DirectoryBindingRecommendationStatus | null
  flags: {
    missingUnionId: boolean
    missingOpenId: boolean
  }
  actionable: {
    canBatchUnbind: boolean
    canConfirmRecommendation: boolean
  }
}

type DirectoryBindingRecommendationReason = 'pending_link' | 'email' | 'mobile'
type DirectoryBindingRecommendationStatusCode =
  | 'recommended'
  | 'no_exact_match'
  | 'ambiguous_exact_match'
  | 'pending_link_conflict'
  | 'linked_user_conflict'
  | 'external_identity_conflict'

type PendingBindingView = 'all' | 'recommended' | 'manual'
type PendingBindingManualReasonFilter = 'all' | 'no_exact_match' | 'conflict'
type ReviewBatchProgressKind = 'bind' | 'recommend' | 'unbind'
type ReviewBatchProgressPhase = 'submitting' | 'refreshing' | 'completed' | 'failed'

type ReviewBatchProgress = {
  kind: ReviewBatchProgressKind
  phase: ReviewBatchProgressPhase
  total: number
  applied: number
  message: string
}

type DirectoryBindingRecommendation = {
  localUser: LocalUserOption
  reasons: DirectoryBindingRecommendationReason[]
}

type DirectoryBindingRecommendationStatus = {
  code: DirectoryBindingRecommendationStatusCode
  message: string
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
    username?: string | null
    name: string | null
  } | null
  departmentPaths: string[]
}

type DirectoryDepartment = {
  id: string
  integrationId: string
  provider: string
  externalDepartmentId: string
  parentExternalDepartmentId: string | null
  name: string
  fullPath: string | null
  orderIndex: number
  isActive: boolean
  lastSeenAt: string
  updatedAt: string
  accountCount: number
  linkedAccountCount: number
  childCount: number
}

type DirectoryDepartmentTreeRow = DirectoryDepartment & {
  depth: number
}

type DirectoryDepartmentTargetField = 'admission' | 'exclude' | 'memberGroup'

type DirectoryDepartmentReferenceIssue = {
  key: string
  field: DirectoryDepartmentTargetField
  fieldLabel: string
  kind: 'missing' | 'inactive'
  departmentId: string
  departmentName: string
}

type DirectoryDepartmentScopeChange = {
  field: DirectoryDepartmentTargetField
  fieldLabel: string
  added: string[]
  removed: string[]
}

type LocalUserOption = {
  id: string
  email: string | null
  username?: string | null
  name: string | null
  mobile?: string | null
  role: string
  is_active: boolean
}

type OnboardingPacket = {
  accountLabel?: string
  acceptInviteUrl?: string
  inviteMessage?: string
}

type ManualAdmissionDraft = {
  name: string
  email: string
  username: string
  mobile: string
}

type ManualAdmissionResult = {
  accountId: string
  accountName: string
  integrationId: string
  userId: string
  userName: string
  email: string | null
  username: string | null
  mobile: string
  temporaryPassword: string
  onboarding: OnboardingPacket | null
  bound: boolean
  bindError: string
  mobileBackfilled: boolean
  mobileBackfillError: string
}

type AutoAdmissionOnboardingPacket = {
  userId: string
  name: string
  email: string | null
  username: string | null
  mobile: string | null
  temporaryPassword: string
  onboarding: OnboardingPacket | null
}

type InitialDirectoryNavigation = {
  integrationId: string
  accountId: string
  source: string
  userId: string
}

type DirectoryRouteNavigationFailureNotice = {
  kind: 'missing_integration' | 'missing_account'
  message: string
  targetIntegrationId: string
  targetAccountId: string
  currentIntegrationName: string
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
  summary?: {
    code: string
    title: string
    nextAction: string
  }
  warnings: string[]
}

type DirectoryDraft = {
  name: string
  corpId: string
  appKey: string
  appSecret: string
  workNotificationAgentId: string
  workNotificationTestUserId: string
  rootDepartmentId: string
  baseUrl: string
  pageSize: number
  admissionMode: 'manual_only' | 'auto_for_scoped_departments'
  admissionDepartmentIdsText: string
  excludeDepartmentIdsText: string
  memberGroupSyncMode: 'disabled' | 'sync_scoped_departments'
  memberGroupDepartmentIdsText: string
  memberGroupDefaultRoleIdsText: string
  memberGroupDefaultNamespacesText: string
  status: string
  scheduleCron: string
  defaultDeprovisionPolicy: string
  syncEnabled: boolean
}

const integrations = ref<DirectoryIntegration[]>([])
const runs = ref<DirectoryRun[]>([])
const accounts = ref<DirectoryAccount[]>([])
const departments = ref<DirectoryDepartment[]>([])
const scheduleSnapshot = ref<DirectoryScheduleSnapshot | null>(null)
const alerts = ref<DirectorySyncAlert[]>([])
const reviewItems = ref<DirectoryReviewItem[]>([])
const accountsSectionRef = ref<HTMLElement | null>(null)
const accountPageSizeOptions = [25, 50, 100]
const accountPage = ref(1)
const accountPageSize = ref(25)
const accountTotal = ref(0)
const focusedAccountId = ref('')
const pendingFocusedAccountScroll = ref(false)
const selectedIntegrationId = ref('')
const loading = ref(false)
const loadingRuns = ref(false)
const loadingSchedule = ref(false)
const loadingAlerts = ref(false)
const loadingReviewItems = ref(false)
const loadingMoreReviewItems = ref(false)
const loadingAccounts = ref(false)
const loadingDepartments = ref(false)
const busy = ref(false)
const bindingAccountId = ref('')
const unbindingAccountId = ref('')
const acknowledgingAlertId = ref('')
const reviewProcessingAccountId = ref('')
const reviewBatchProcessing = ref(false)
const reviewBatchProgress = ref<ReviewBatchProgress | null>(null)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const routeNavigationFailureNotice = ref<DirectoryRouteNavigationFailureNotice | null>(null)
const routeNavigationFailureAction = ref<'retry' | 'clear' | ''>('')
const testResult = ref<TestResult | null>(null)
const departmentsLoaded = ref(false)
const departmentLoadError = ref('')
const departmentQuery = ref('')
const departmentScopeFilter = ref<DirectoryDepartmentScopeFilter>('all')
const manualDepartmentId = ref('')
const manualDepartmentName = ref('')
const accountQuery = ref('')
const alertFilter = ref<DirectoryAlertFilter>('all')
const reviewFilter = ref<DirectoryReviewItemFilter>('all')
const pendingBindingView = ref<PendingBindingView>('recommended')
const pendingBindingViewTouched = ref(false)
const pendingBindingManualReason = ref<PendingBindingManualReasonFilter>('all')
const bindingDrafts = reactive<Record<string, string>>({})
const selectedBindingUsers = reactive<Record<string, LocalUserOption>>({})
const mobileOverrideConfirmations = reactive<Record<string, boolean>>({})
const mobileConflictHints = reactive<Record<string, string>>({})
const userSearchResults = reactive<Record<string, LocalUserOption[]>>({})
const userSearchLoading = reactive<Record<string, boolean>>({})
const userSearchError = reactive<Record<string, string>>({})
const manualAdmissionDrafts = reactive<Record<string, ManualAdmissionDraft>>({})
const manualAdmissionExpanded = reactive<Record<string, boolean>>({})
const manualAdmissionResult = ref<ManualAdmissionResult | null>(null)
const autoAdmissionOnboardingPackets = ref<AutoAdmissionOnboardingPacket[]>([])
const grantToggles = reactive<Record<string, boolean>>({})
const selectedReviewIds = reactive<Record<string, boolean>>({})
const reviewDisableDingTalkGrant = ref(true)
const reviewPageSize = 100
const reviewPage = ref(1)
const reviewTotal = ref(0)
const appliedDirectoryNavigationKey = ref('')
const alertFilterOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'pending' as const, label: '待确认' },
  { value: 'acknowledged' as const, label: '已确认' },
]
const reviewFilterOptions = [
  { value: 'all' as const, label: '全部待处理' },
  { value: 'pending_binding' as const, label: '待绑定' },
  { value: 'inactive_linked' as const, label: '停用待停权' },
  { value: 'missing_identifier' as const, label: '缺身份标识' },
]
const pendingBindingViewOptions = [
  { value: 'all' as const, label: '全部待绑定' },
  { value: 'recommended' as const, label: '可推荐处理' },
  { value: 'manual' as const, label: '需人工处理' },
]
const pendingBindingManualReasonOptions = [
  { value: 'all' as const, label: '全部人工' },
  { value: 'no_exact_match' as const, label: '无精确匹配' },
  { value: 'conflict' as const, label: '冲突待复核' },
]
const departmentScopeFilterOptions = [
  { value: 'all' as const, label: '全部部门' },
  { value: 'unlinked' as const, label: '只看未全绑定' },
  { value: 'inactive' as const, label: '只看停用部门' },
  { value: 'staleBatch' as const, label: '只看非最新批次' },
  { value: 'configured' as const, label: '只看已配置' },
  { value: 'issues' as const, label: '只看异常' },
  { value: 'admission' as const, label: '只看准入' },
  { value: 'exclude' as const, label: '只看排除' },
  { value: 'memberGroup' as const, label: '只看成员组同步' },
]
const departmentTargetFields: DirectoryDepartmentTargetField[] = ['admission', 'exclude', 'memberGroup']
const directoryNavigation = ref(readInitialDirectoryNavigation())

const draft = reactive<DirectoryDraft>({
  name: '',
  corpId: '',
  appKey: '',
  appSecret: '',
  workNotificationAgentId: '',
  workNotificationTestUserId: '',
  rootDepartmentId: '1',
  baseUrl: '',
  pageSize: 50,
  admissionMode: 'manual_only',
  admissionDepartmentIdsText: '',
  excludeDepartmentIdsText: '',
  memberGroupSyncMode: 'disabled',
  memberGroupDepartmentIdsText: '',
  memberGroupDefaultRoleIdsText: '',
  memberGroupDefaultNamespacesText: '',
  status: 'active',
  scheduleCron: '',
  defaultDeprovisionPolicy: 'mark_inactive',
  syncEnabled: false,
})

const selectedIntegration = computed(() =>
  integrations.value.find((integration) => integration.id === selectedIntegrationId.value) ?? null,
)
const routeNavigationFailureUserManagementLocation = computed(() => {
  const navigation = directoryNavigation.value
  if (navigation.source !== 'user-management' || navigation.userId.trim().length === 0) return ''
  const params = new URLSearchParams({
    userId: navigation.userId.trim(),
    source: 'directory-sync',
  })
  const failureKind = routeNavigationFailureNotice.value?.kind?.trim() || ''
  const integrationId = routeNavigationFailureNotice.value?.targetIntegrationId?.trim() || navigation.integrationId.trim()
  const accountId = routeNavigationFailureNotice.value?.targetAccountId?.trim() || navigation.accountId.trim()
  if (failureKind.length > 0) params.set('directoryFailure', failureKind)
  if (integrationId.length > 0) params.set('integrationId', integrationId)
  if (accountId.length > 0) params.set('accountId', accountId)
  return `/admin/users?${params.toString()}`
})
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
const alertCounts = computed<Record<DirectoryAlertFilter, number>>(() => ({
  all: alerts.value.length,
  pending: alerts.value.filter((item) => !item.acknowledgedAt).length,
  acknowledged: alerts.value.filter((item) => Boolean(item.acknowledgedAt)).length,
}))
const filteredAlerts = computed(() => {
  if (alertFilter.value === 'pending') return alerts.value.filter((item) => !item.acknowledgedAt)
  if (alertFilter.value === 'acknowledged') return alerts.value.filter((item) => Boolean(item.acknowledgedAt))
  return alerts.value
})
const reviewCounts = computed<Record<DirectoryReviewItemFilter, number>>(() => ({
  all: reviewItems.value.length,
  pending_binding: reviewItems.value.filter((item) => item.kind === 'pending_binding').length,
  inactive_linked: reviewItems.value.filter((item) => item.kind === 'inactive_linked').length,
  missing_identifier: reviewItems.value.filter((item) => item.kind === 'missing_identifier').length,
}))
const pendingBindingCounts = computed<Record<PendingBindingView, number>>(() => ({
  all: reviewItems.value.filter((item) => item.kind === 'pending_binding').length,
  recommended: reviewItems.value.filter((item) => item.kind === 'pending_binding' && item.actionable.canConfirmRecommendation).length,
  manual: reviewItems.value.filter((item) => item.kind === 'pending_binding' && !item.actionable.canConfirmRecommendation).length,
}))
const pendingBindingManualReasonCounts = computed<Record<PendingBindingManualReasonFilter, number>>(() => {
  const manualItems = reviewItems.value.filter((item) => item.kind === 'pending_binding' && !item.actionable.canConfirmRecommendation)
  return {
    all: manualItems.length,
    no_exact_match: manualItems.filter((item) => readPendingBindingManualReasonCode(item) === 'no_exact_match').length,
    conflict: manualItems.filter((item) => readPendingBindingManualReasonCode(item) === 'conflict').length,
  }
})
const showPendingBindingManualReasonFilters = computed(() => (
  pendingBindingView.value === 'manual'
  && pendingBindingCounts.value.manual > 0
  && (reviewFilter.value === 'all' || reviewFilter.value === 'pending_binding')
))
const focusedVisibleAccount = computed(() => (
  accounts.value.find((account) => account.id === focusedAccountId.value) ?? null
))
const departmentRows = computed(() => buildDirectoryDepartmentTreeRows(departments.value))
const departmentFilterActive = computed(() => departmentQuery.value.trim().length > 0)
const departmentAccountCount = computed(() =>
  departmentRows.value.reduce((sum, department) => sum + department.accountCount, 0),
)
const departmentLinkedAccountCount = computed(() =>
  departmentRows.value.reduce((sum, department) => sum + department.linkedAccountCount, 0),
)
const departmentUnlinkedAccountCount = computed(() =>
  departmentRows.value.reduce((sum, department) => sum + readDepartmentUnlinkedAccountCount(department), 0),
)
const departmentUnlinkedMirrorCount = computed(() =>
  departmentRows.value.filter((department) => readDepartmentUnlinkedAccountCount(department) > 0).length,
)
const inactiveDepartmentCount = computed(() =>
  departmentRows.value.filter((department) => !department.isActive).length,
)
const departmentMirrorLatestSeenAt = computed(() =>
  readLatestDepartmentTimestamp(departmentRows.value, 'lastSeenAt'),
)
const departmentMirrorLatestUpdatedAt = computed(() =>
  readLatestDepartmentTimestamp(departmentRows.value, 'updatedAt'),
)
const departmentMirrorCurrentBatchCount = computed(() => {
  const latestSeenAtMs = readTimestampMs(departmentMirrorLatestSeenAt.value)
  if (latestSeenAtMs === null) return departmentRows.value.length
  return departmentRows.value.filter((department) => readTimestampMs(department.lastSeenAt) === latestSeenAtMs).length
})
const departmentMirrorStaleSeenCount = computed(() =>
  Math.max(0, departmentRows.value.length - departmentMirrorCurrentBatchCount.value),
)
const departmentMirrorObservationHasWarnings = computed(() =>
  departmentMirrorStaleSeenCount.value > 0 || inactiveDepartmentCount.value > 0,
)
const departmentMirrorObservationMessage = computed(() => {
  if (departmentMirrorStaleSeenCount.value > 0) {
    return `有 ${departmentMirrorStaleSeenCount.value} 个部门未出现在最新同步批次，建议复核是否为钉钉侧停用或本地镜像滞后。`
  }
  if (inactiveDepartmentCount.value > 0) {
    return `最新镜像中存在 ${inactiveDepartmentCount.value} 个停用部门，建议复核配置引用后再清理。`
  }
  return '本地组织镜像批次一致，未发现停用或跨批次部门。'
})
const departmentConfigScope = computed<Record<DirectoryDepartmentTargetField, Set<string>>>(() => ({
  admission: new Set(parseAdmissionDepartmentIdsText(draft.admissionDepartmentIdsText)),
  exclude: new Set(parseAdmissionDepartmentIdsText(draft.excludeDepartmentIdsText)),
  memberGroup: new Set(parseAdmissionDepartmentIdsText(draft.memberGroupDepartmentIdsText)),
}))
const departmentSavedConfigScope = computed<Record<DirectoryDepartmentTargetField, Set<string>>>(() => ({
  admission: new Set(readSavedDepartmentTargetIds('admission')),
  exclude: new Set(readSavedDepartmentTargetIds('exclude')),
  memberGroup: new Set(readSavedDepartmentTargetIds('memberGroup')),
}))
const departmentDraftScopeChanges = computed(() =>
  buildDepartmentScopeChanges(departmentConfigScope.value, departmentSavedConfigScope.value),
)
const hasDepartmentDraftScopeChanges = computed(() => departmentDraftScopeChanges.value.length > 0)
const departmentDraftScopeAddedCount = computed(() =>
  departmentDraftScopeChanges.value.reduce((sum, change) => sum + change.added.length, 0),
)
const departmentDraftScopeRemovedCount = computed(() =>
  departmentDraftScopeChanges.value.reduce((sum, change) => sum + change.removed.length, 0),
)
const hasScopedDepartmentConfig = computed(() =>
  departmentTargetFields.some((field) => departmentConfigScope.value[field].size > 0),
)
const departmentConfigReferenceIssues = computed(() =>
  buildDepartmentConfigReferenceIssues(departments.value, departmentConfigScope.value),
)
const configuredDepartmentIds = computed(() => buildConfiguredDepartmentIdSet(departmentConfigScope.value))
const configuredDepartmentCount = computed(() => configuredDepartmentIds.value.size)
const departmentReferenceIssueIds = computed(() => new Set(
  departmentConfigReferenceIssues.value.map((issue) => issue.departmentId),
))
const configuredDepartmentMirrorCount = computed(() => departmentRows.value.filter((department) =>
  configuredDepartmentIds.value.has(department.externalDepartmentId),
).length)
const issueDepartmentMirrorCount = computed(() => departmentRows.value.filter((department) =>
  departmentReferenceIssueIds.value.has(department.externalDepartmentId),
).length)
const scopeFilteredDepartmentRows = computed(() =>
  filterDirectoryDepartmentRowsByScope(
    departmentRows.value,
    departmentScopeFilter.value,
    configuredDepartmentIds.value,
    departmentReferenceIssueIds.value,
    departmentConfigScope.value,
  ),
)
const visibleDepartmentRows = computed(() =>
  filterDirectoryDepartmentRows(scopeFilteredDepartmentRows.value, departmentQuery.value),
)
const visibleDepartmentIdPreview = computed(() =>
  visibleDepartmentRows.value.map((department) => department.externalDepartmentId).join('\n'),
)
const departmentViewFilterActive = computed(() =>
  departmentFilterActive.value || departmentScopeFilter.value !== 'all',
)
const showVisibleDepartmentBulkActions = computed(() =>
  visibleDepartmentRows.value.length > 0
  && departmentViewFilterActive.value,
)
const departmentTreeEmptyMessage = computed(() => {
  const query = departmentQuery.value.trim()
  const hasQuery = query.length > 0
  if (departmentScopeFilter.value === 'configured') {
    return hasQuery
      ? `没有匹配“${query}”的已配置部门；可清空筛选或切回全部部门。`
      : '当前草稿没有可在组织架构镜像中展示的已配置部门；未同步引用请查看配置引用检查。'
  }
  if (departmentScopeFilter.value === 'issues') {
    return hasQuery
      ? `没有匹配“${query}”的异常部门；未同步引用请查看配置引用检查。`
      : '当前没有可在组织架构镜像中展示的异常部门；未同步引用请查看配置引用检查。'
  }
  if (departmentScopeFilter.value === 'unlinked') {
    return hasQuery
      ? `没有匹配“${query}”的未全绑定部门；可清空筛选或切回全部部门。`
      : '当前没有未完全绑定的部门。'
  }
  if (departmentScopeFilter.value === 'inactive') {
    return hasQuery
      ? `没有匹配“${query}”的停用部门；可清空筛选或切回全部部门。`
      : '当前没有停用部门。'
  }
  if (departmentScopeFilter.value === 'staleBatch') {
    return hasQuery
      ? `没有匹配“${query}”的非最新批次部门；可清空筛选或切回全部部门。`
      : '当前没有非最新批次部门。'
  }
  if (departmentTargetFields.includes(departmentScopeFilter.value as DirectoryDepartmentTargetField)) {
    const targetLabel = readDepartmentTargetLabel(departmentScopeFilter.value as DirectoryDepartmentTargetField)
    return hasQuery
      ? `没有匹配“${query}”的${targetLabel}部门；可清空筛选或切回全部部门。`
      : `当前草稿没有可在组织架构镜像中展示的${targetLabel}部门；未同步引用请查看配置引用检查。`
  }
  return hasQuery
    ? `没有匹配“${query}”的部门；可按部门名、部门 ID 或完整路径筛选。`
    : '没有可展示的部门。'
})
const focusedVisibleAccountBindDraft = computed(() => {
  if (!focusedVisibleAccount.value) return ''
  return readBindingDraft(focusedVisibleAccount.value).trim()
})
const focusedVisibleAccountBindLabel = computed(() => {
  if (!focusedVisibleAccount.value) return '绑定当前成员'
  if (bindingAccountId.value === focusedVisibleAccount.value.id) return '绑定中...'
  return focusedVisibleAccount.value.localUser ? '更新当前绑定' : '绑定当前成员'
})
const hasMoreReviewItems = computed(() => reviewItems.value.length < reviewTotal.value)
const filteredReviewItems = computed(() => {
  if (reviewFilter.value === 'all') {
    if (pendingBindingView.value === 'all') return reviewItems.value
    return reviewItems.value.filter((item) => (
      item.kind === 'pending_binding'
      && matchesPendingBindingView(item)
    ))
  }
  if (reviewFilter.value !== 'pending_binding') {
    return reviewItems.value.filter((item) => item.kind === reviewFilter.value)
  }
  if (pendingBindingView.value === 'all') {
    return reviewItems.value.filter((item) => item.kind === 'pending_binding')
  }
  return reviewItems.value.filter((item) => (
    item.kind === 'pending_binding'
    && matchesPendingBindingView(item)
  ))
})
const selectableVisibleReviewIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => item.kind === 'pending_binding' || item.actionable.canBatchUnbind)
    .map((item) => item.account.id)
))
const selectableVisibleRecommendedReviewIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => item.kind === 'pending_binding' && item.actionable.canConfirmRecommendation)
    .map((item) => item.account.id)
))
const selectedRecommendedReviewBindEntries = computed(() => (
  filteredReviewItems.value
    .filter((item) => (
      item.kind === 'pending_binding'
      && selectedReviewIds[item.account.id]
      && item.actionable.canConfirmRecommendation
      && item.recommendations.length > 0
    ))
    .map((item) => ({
      accountId: item.account.id,
      localUserRef: item.recommendations[0].localUser.id,
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }))
))
const selectedReviewBindEntries = computed(() => (
  filteredReviewItems.value
    .filter((item) => item.kind === 'pending_binding' && selectedReviewIds[item.account.id])
    .map((item) => ({
      accountId: item.account.id,
      localUserRef: readBindingDraft(item.account).trim(),
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }))
    .filter((item) => item.localUserRef.length > 0)
))
const selectedReviewBatchIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => item.actionable.canBatchUnbind && selectedReviewIds[item.account.id])
    .map((item) => item.account.id)
))

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

function readInitialDirectoryNavigation(): InitialDirectoryNavigation {
  if (typeof window === 'undefined') {
    return { integrationId: '', accountId: '', source: '', userId: '' }
  }
  const params = new URL(window.location.href).searchParams
  return {
    integrationId: params.get('integrationId')?.trim() || '',
    accountId: params.get('accountId')?.trim() || '',
    source: params.get('source')?.trim() || '',
    userId: params.get('userId')?.trim() || '',
  }
}

function buildDirectoryNavigationKey(navigation: InitialDirectoryNavigation): string {
  return [
    navigation.integrationId.trim(),
    navigation.accountId.trim(),
    navigation.source.trim(),
    navigation.userId.trim(),
  ].join('|')
}

function buildDirectoryLocation(navigation: InitialDirectoryNavigation): string {
  if (typeof window === 'undefined') return '/admin/directory'
  const url = new URL(window.location.href)
  const params = new URLSearchParams(url.search)
  const updateParam = (key: string, value: string) => {
    if (value.trim().length > 0) params.set(key, value.trim())
    else params.delete(key)
  }
  updateParam('integrationId', navigation.integrationId)
  updateParam('accountId', navigation.accountId)
  updateParam('source', navigation.source)
  updateParam('userId', navigation.userId)
  const search = params.toString()
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}

function replaceDirectoryNavigation(navigation: InitialDirectoryNavigation): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', buildDirectoryLocation(navigation))
}

function syncDirectoryNavigationFromLocation(): boolean {
  const next = readInitialDirectoryNavigation()
  const currentKey = buildDirectoryNavigationKey(directoryNavigation.value)
  const nextKey = buildDirectoryNavigationKey(next)
  directoryNavigation.value = next
  return currentKey !== nextKey
}

function resetDraft() {
  selectedIntegrationId.value = ''
  testResult.value = null
  runs.value = []
  accounts.value = []
  departments.value = []
  departmentsLoaded.value = false
  departmentLoadError.value = ''
  departmentQuery.value = ''
  departmentScopeFilter.value = 'all'
  manualDepartmentId.value = ''
  manualDepartmentName.value = ''
  reviewBatchProgress.value = null
  scheduleSnapshot.value = null
  alerts.value = []
  reviewItems.value = []
  reviewPage.value = 1
  reviewTotal.value = 0
  accountPage.value = 1
  accountPageSize.value = accountPageSizeOptions[0]
  accountTotal.value = 0
  accountQuery.value = ''
  alertFilter.value = 'all'
  reviewFilter.value = 'all'
  pendingBindingView.value = 'recommended'
  pendingBindingViewTouched.value = false
  pendingBindingManualReason.value = 'all'
  reviewDisableDingTalkGrant.value = true
  for (const key of Object.keys(bindingDrafts)) delete bindingDrafts[key]
  for (const key of Object.keys(selectedBindingUsers)) delete selectedBindingUsers[key]
  for (const key of Object.keys(mobileOverrideConfirmations)) delete mobileOverrideConfirmations[key]
  for (const key of Object.keys(mobileConflictHints)) delete mobileConflictHints[key]
  for (const key of Object.keys(userSearchResults)) delete userSearchResults[key]
  for (const key of Object.keys(userSearchLoading)) delete userSearchLoading[key]
  for (const key of Object.keys(userSearchError)) delete userSearchError[key]
  for (const key of Object.keys(grantToggles)) delete grantToggles[key]
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
  autoAdmissionOnboardingPackets.value = []
  draft.name = ''
  draft.corpId = ''
  draft.appKey = ''
  draft.appSecret = ''
  draft.workNotificationAgentId = ''
  draft.workNotificationTestUserId = ''
  draft.rootDepartmentId = '1'
  draft.baseUrl = ''
  draft.pageSize = 50
  draft.admissionMode = 'manual_only'
  draft.admissionDepartmentIdsText = ''
  draft.excludeDepartmentIdsText = ''
  draft.memberGroupSyncMode = 'disabled'
  draft.memberGroupDepartmentIdsText = ''
  draft.memberGroupDefaultRoleIdsText = ''
  draft.memberGroupDefaultNamespacesText = ''
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
  draft.workNotificationAgentId = ''
  draft.workNotificationTestUserId = ''
  draft.rootDepartmentId = integration.config.rootDepartmentId
  draft.baseUrl = integration.config.baseUrl ?? ''
  draft.pageSize = integration.config.pageSize
  draft.admissionMode = integration.config.admissionMode
  draft.admissionDepartmentIdsText = integration.config.admissionDepartmentIds.join('\n')
  draft.excludeDepartmentIdsText = integration.config.excludeDepartmentIds.join('\n')
  draft.memberGroupSyncMode = integration.config.memberGroupSyncMode
  draft.memberGroupDepartmentIdsText = integration.config.memberGroupDepartmentIds.join('\n')
  draft.memberGroupDefaultRoleIdsText = integration.config.memberGroupDefaultRoleIds.join('\n')
  draft.memberGroupDefaultNamespacesText = integration.config.memberGroupDefaultNamespaces.join('\n')
  draft.status = integration.status
  draft.scheduleCron = integration.scheduleCron ?? ''
  draft.defaultDeprovisionPolicy = integration.defaultDeprovisionPolicy
  draft.syncEnabled = integration.syncEnabled
}

function parseAdmissionDepartmentIdsText(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ))
}

function readDepartmentTargetText(field: DirectoryDepartmentTargetField): string {
  if (field === 'exclude') return draft.excludeDepartmentIdsText
  if (field === 'memberGroup') return draft.memberGroupDepartmentIdsText
  return draft.admissionDepartmentIdsText
}

function writeDepartmentTargetText(field: DirectoryDepartmentTargetField, ids: string[]): void {
  const nextValue = ids.join('\n')
  if (field === 'exclude') {
    draft.excludeDepartmentIdsText = nextValue
    return
  }
  if (field === 'memberGroup') {
    draft.memberGroupDepartmentIdsText = nextValue
    return
  }
  draft.admissionDepartmentIdsText = nextValue
}

function readDepartmentTargetLabel(field: DirectoryDepartmentTargetField): string {
  if (field === 'exclude') return '排除部门'
  if (field === 'memberGroup') return '成员组同步部门'
  return '准入白名单'
}

function readSavedDepartmentTargetIds(field: DirectoryDepartmentTargetField): string[] {
  const integration = selectedIntegration.value
  if (!integration) return []
  if (field === 'exclude') return integration.config.excludeDepartmentIds
  if (field === 'memberGroup') return integration.config.memberGroupDepartmentIds
  return integration.config.admissionDepartmentIds
}

function buildConfiguredDepartmentIdSet(
  scope: Record<DirectoryDepartmentTargetField, Set<string>>,
): Set<string> {
  const ids = new Set<string>()
  for (const field of departmentTargetFields) {
    for (const departmentId of scope[field]) ids.add(departmentId)
  }
  return ids
}

function buildDepartmentScopeChanges(
  draftScope: Record<DirectoryDepartmentTargetField, Set<string>>,
  savedScope: Record<DirectoryDepartmentTargetField, Set<string>>,
): DirectoryDepartmentScopeChange[] {
  return departmentTargetFields
    .map((field) => {
      const added = Array.from(draftScope[field]).filter((departmentId) => !savedScope[field].has(departmentId))
      const removed = Array.from(savedScope[field]).filter((departmentId) => !draftScope[field].has(departmentId))
      return {
        field,
        fieldLabel: readDepartmentTargetLabel(field),
        added,
        removed,
      }
    })
    .filter((change) => change.added.length > 0 || change.removed.length > 0)
}

function readTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function readLatestDepartmentTimestamp(
  rows: DirectoryDepartment[],
  field: 'lastSeenAt' | 'updatedAt',
): string | null {
  let latestValue: string | null = null
  let latestTimestamp: number | null = null
  for (const department of rows) {
    const timestamp = readTimestampMs(department[field])
    if (timestamp === null) continue
    if (latestTimestamp === null || timestamp > latestTimestamp) {
      latestTimestamp = timestamp
      latestValue = department[field]
    }
  }
  return latestValue
}

function isDepartmentInLatestMirrorBatch(department: DirectoryDepartment): boolean {
  const latestSeenAtMs = readTimestampMs(departmentMirrorLatestSeenAt.value)
  if (latestSeenAtMs === null) return true
  return readTimestampMs(department.lastSeenAt) === latestSeenAtMs
}

function readDepartmentUnlinkedAccountCount(department: DirectoryDepartment): number {
  return Math.max(0, department.accountCount - department.linkedAccountCount)
}

function filterDirectoryDepartmentRowsByScope(
  rows: DirectoryDepartmentTreeRow[],
  filter: DirectoryDepartmentScopeFilter,
  configuredIds: Set<string>,
  issueIds: Set<string>,
  scope: Record<DirectoryDepartmentTargetField, Set<string>>,
): DirectoryDepartmentTreeRow[] {
  if (filter === 'unlinked') {
    return rows.filter((department) => readDepartmentUnlinkedAccountCount(department) > 0)
  }
  if (filter === 'inactive') {
    return rows.filter((department) => !department.isActive)
  }
  if (filter === 'staleBatch') {
    return rows.filter((department) => !isDepartmentInLatestMirrorBatch(department))
  }
  if (filter === 'configured') {
    return rows.filter((department) => configuredIds.has(department.externalDepartmentId))
  }
  if (filter === 'issues') {
    return rows.filter((department) => issueIds.has(department.externalDepartmentId))
  }
  if (departmentTargetFields.includes(filter as DirectoryDepartmentTargetField)) {
    const field = filter as DirectoryDepartmentTargetField
    return rows.filter((department) => scope[field].has(department.externalDepartmentId))
  }
  return rows
}

function readDepartmentScopeFilterCount(filter: DirectoryDepartmentScopeFilter): string {
  if (filter === 'unlinked') return departmentUnlinkedMirrorCount.value > 0 ? ` (${departmentUnlinkedMirrorCount.value})` : ''
  if (filter === 'inactive') return inactiveDepartmentCount.value > 0 ? ` (${inactiveDepartmentCount.value})` : ''
  if (filter === 'staleBatch') return departmentMirrorStaleSeenCount.value > 0 ? ` (${departmentMirrorStaleSeenCount.value})` : ''
  if (filter === 'configured') return configuredDepartmentMirrorCount.value > 0 ? ` (${configuredDepartmentMirrorCount.value})` : ''
  if (filter === 'issues') return issueDepartmentMirrorCount.value > 0 ? ` (${issueDepartmentMirrorCount.value})` : ''
  if (departmentTargetFields.includes(filter as DirectoryDepartmentTargetField)) {
    const field = filter as DirectoryDepartmentTargetField
    const count = departmentRows.value.filter((department) =>
      departmentConfigScope.value[field].has(department.externalDepartmentId),
    ).length
    return count > 0 ? ` (${count})` : ''
  }
  return ''
}

function readDepartmentScopeFilterLabel(filter: DirectoryDepartmentScopeFilter): string {
  return departmentScopeFilterOptions.find((option) => option.value === filter)?.label ?? '全部部门'
}

function resetDepartmentViewFilters(): void {
  departmentQuery.value = ''
  departmentScopeFilter.value = 'all'
}

function focusDepartmentScopeFilter(filter: DirectoryDepartmentScopeFilter): void {
  departmentQuery.value = ''
  departmentScopeFilter.value = filter
}

function restoreDepartmentScopeDraftsToSavedConfig(): void {
  draft.admissionDepartmentIdsText = readSavedDepartmentTargetIds('admission').join('\n')
  draft.excludeDepartmentIdsText = readSavedDepartmentTargetIds('exclude').join('\n')
  draft.memberGroupDepartmentIdsText = readSavedDepartmentTargetIds('memberGroup').join('\n')
  setStatus('已还原部门范围草稿为已保存配置')
}

function restoreDepartmentScopeDraftToSavedConfig(field: DirectoryDepartmentTargetField): void {
  writeDepartmentTargetText(field, readSavedDepartmentTargetIds(field))
  setStatus(`已还原${readDepartmentTargetLabel(field)}为已保存配置`)
}

async function writeClipboardText(
  value: string,
  successMessage: string,
  options: {
    emptyMessage?: string
    unsupportedMessage?: string
    failureMessage?: string
  } = {},
): Promise<void> {
  const text = value.trim()
  if (text.length === 0) {
    setStatus(options.emptyMessage ?? '没有可复制的部门 ID', 'error')
    return
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    setStatus(options.unsupportedMessage ?? '当前浏览器不支持自动复制，请从预览框手动复制部门 ID', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    setStatus(successMessage)
  } catch {
    setStatus(options.failureMessage ?? '复制部门 ID 失败，请从预览框手动复制', 'error')
  }
}

async function copyVisibleDepartmentIds(): Promise<void> {
  await writeClipboardText(
    visibleDepartmentIdPreview.value,
    `已复制 ${visibleDepartmentRows.value.length} 个当前可见部门 ID`,
  )
}

function buildVisibleDepartmentReport(): string {
  if (visibleDepartmentRows.value.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const query = departmentQuery.value.trim()
  const lines = [
    'DingTalk organization visible department report',
    `Integration: ${integrationName}`,
    `Scope filter: ${readDepartmentScopeFilterLabel(departmentScopeFilter.value)}`,
    `Search query: ${query.length > 0 ? query : 'none'}`,
    `Visible department count: ${visibleDepartmentRows.value.length}`,
    `Latest mirror batch: ${departmentMirrorLatestSeenAt.value ?? 'not_recorded'}`,
    '',
    ...visibleDepartmentRows.value.map((department, index) => {
      const name = department.fullPath || department.name
      const activeStatus = department.isActive ? 'active_department' : 'inactive_department'
      const batchStatus = isDepartmentInLatestMirrorBatch(department) ? 'latest_batch' : 'not_latest_batch'
      const gapCount = readDepartmentUnlinkedAccountCount(department)
      return `${index + 1}. [${activeStatus}; ${batchStatus}] ${department.externalDepartmentId} · ${name} · members=${department.accountCount} · linked=${department.linkedAccountCount} · unlinked=${gapCount}`
    }),
  ]
  return lines.join('\n')
}

async function copyVisibleDepartmentReport(): Promise<void> {
  await writeClipboardText(
    buildVisibleDepartmentReport(),
    `已复制 ${visibleDepartmentRows.value.length} 个当前可见部门报告`,
    {
      emptyMessage: '当前没有可复制的可见部门',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制当前可见部门内容',
      failureMessage: '复制当前可见部门报告失败，请手动复制当前可见部门内容',
    },
  )
}

async function copyDepartmentId(department: DirectoryDepartment): Promise<void> {
  await writeClipboardText(
    department.externalDepartmentId,
    `已复制部门 ${department.name} (${department.externalDepartmentId}) 的 ID`,
  )
}

function buildDepartmentReferenceIssueReport(): string {
  const issues = departmentConfigReferenceIssues.value
  if (issues.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization reference issue report',
    `Integration: ${integrationName}`,
    `Issue count: ${issues.length}`,
    '',
    ...issues.map((issue, index) => {
      const status = issue.kind === 'missing' ? 'missing_from_mirror' : 'inactive_department'
      return `${index + 1}. [${status}] ${readDepartmentReferenceIssueLabel(issue)}`
    }),
  ]
  return lines.join('\n')
}

function describeDepartmentConfigReference(
  departmentId: string,
  departmentByExternalId: Map<string, DirectoryDepartment>,
): string {
  const department = departmentByExternalId.get(departmentId)
  if (!department) return `${departmentId} · missing_from_mirror`
  const status = department.isActive ? 'active_department' : 'inactive_department'
  const name = department.fullPath || department.name
  return `${departmentId} · ${status} · ${name}`
}

function buildDepartmentConfigReferenceReport(): string {
  const departmentByExternalId = new Map(departments.value.map((department) => [department.externalDepartmentId, department]))
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization configuration reference report',
    `Integration: ${integrationName}`,
    `Configured unique department IDs: ${configuredDepartmentCount.value}`,
    `Mirror departments loaded: ${departments.value.length}`,
    `Reference issue count: ${departmentConfigReferenceIssues.value.length}`,
  ]
  for (const field of departmentTargetFields) {
    const ids = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
    lines.push('', `[${readDepartmentTargetLabel(field)}]`)
    if (ids.length === 0) {
      lines.push('- none')
      continue
    }
    for (const departmentId of ids) {
      lines.push(`- ${describeDepartmentConfigReference(departmentId, departmentByExternalId)}`)
    }
  }
  return lines.join('\n')
}

function buildDepartmentBindingGapReport(): string {
  const gapDepartments = departmentRows.value.filter((department) => readDepartmentUnlinkedAccountCount(department) > 0)
  if (gapDepartments.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization binding gap report',
    `Integration: ${integrationName}`,
    `Unlinked member count: ${departmentUnlinkedAccountCount.value}`,
    `Departments with gaps: ${gapDepartments.length}`,
    '',
    ...gapDepartments.map((department, index) => {
      const status = department.isActive ? 'active_department' : 'inactive_department'
      const name = department.fullPath || department.name
      const gapCount = readDepartmentUnlinkedAccountCount(department)
      return `${index + 1}. [${status}] ${department.externalDepartmentId} · ${name} · members=${department.accountCount} · linked=${department.linkedAccountCount} · unlinked=${gapCount}`
    }),
  ]
  return lines.join('\n')
}

function buildInactiveDepartmentReport(): string {
  const inactiveDepartments = departmentRows.value.filter((department) => !department.isActive)
  if (inactiveDepartments.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization inactive department report',
    `Integration: ${integrationName}`,
    `Inactive department count: ${inactiveDepartments.length}`,
    '',
    ...inactiveDepartments.map((department, index) => {
      const name = department.fullPath || department.name
      const gapCount = readDepartmentUnlinkedAccountCount(department)
      return `${index + 1}. [inactive_department] ${department.externalDepartmentId} · ${name} · members=${department.accountCount} · linked=${department.linkedAccountCount} · unlinked=${gapCount}`
    }),
  ]
  return lines.join('\n')
}

function buildDepartmentMirrorObservationReport(): string {
  if (departmentRows.value.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const staleDepartments = departmentRows.value.filter((department) => !isDepartmentInLatestMirrorBatch(department))
  const lines = [
    'DingTalk organization mirror observation report',
    `Integration: ${integrationName}`,
    `Latest mirror batch: ${departmentMirrorLatestSeenAt.value ?? 'not_recorded'}`,
    `Latest mirror update: ${departmentMirrorLatestUpdatedAt.value ?? 'not_recorded'}`,
    `Integration last successful sync: ${selectedIntegration.value?.lastSuccessAt ?? 'not_recorded'}`,
    `Mirror department count: ${departmentRows.value.length}`,
    `Current batch departments: ${departmentMirrorCurrentBatchCount.value}`,
    `Not seen in latest batch: ${departmentMirrorStaleSeenCount.value}`,
    `Inactive departments: ${inactiveDepartmentCount.value}`,
    `Unlinked member count: ${departmentUnlinkedAccountCount.value}`,
  ]
  if (staleDepartments.length > 0) {
    lines.push('', '[not_seen_in_latest_batch]')
    for (const department of staleDepartments) {
      const name = department.fullPath || department.name
      lines.push(`- ${department.externalDepartmentId} · ${name} · active=${department.isActive ? 'yes' : 'no'} · lastSeenAt=${department.lastSeenAt}`)
    }
  }
  return lines.join('\n')
}

function buildDepartmentDraftScopeChangeReport(): string {
  if (departmentDraftScopeChanges.value.length === 0) return ''
  const departmentByExternalId = new Map(departments.value.map((department) => [department.externalDepartmentId, department]))
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization draft scope change report',
    `Integration: ${integrationName}`,
    `Changed fields: ${departmentDraftScopeChanges.value.length}`,
    `Added department references: ${departmentDraftScopeAddedCount.value}`,
    `Removed department references: ${departmentDraftScopeRemovedCount.value}`,
  ]
  for (const change of departmentDraftScopeChanges.value) {
    lines.push('', `[${change.fieldLabel}]`)
    if (change.added.length > 0) {
      lines.push('added:')
      for (const departmentId of change.added) {
        lines.push(`- ${describeDepartmentConfigReference(departmentId, departmentByExternalId)}`)
      }
    }
    if (change.removed.length > 0) {
      lines.push('removed:')
      for (const departmentId of change.removed) {
        lines.push(`- ${describeDepartmentConfigReference(departmentId, departmentByExternalId)}`)
      }
    }
  }
  return lines.join('\n')
}

async function copyDepartmentReferenceIssueReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentReferenceIssueReport(),
    `已复制 ${departmentConfigReferenceIssues.value.length} 条异常引用报告`,
    {
      emptyMessage: '当前没有可复制的异常引用',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制异常引用内容',
      failureMessage: '复制异常引用报告失败，请手动复制异常引用内容',
    },
  )
}

async function copyDepartmentConfigReferenceReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentConfigReferenceReport(),
    `已复制 ${configuredDepartmentCount.value} 个配置部门引用报告`,
    {
      emptyMessage: '当前没有可复制的部门配置引用',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制配置引用内容',
      failureMessage: '复制配置引用报告失败，请手动复制配置引用内容',
    },
  )
}

async function copyDepartmentBindingGapReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentBindingGapReport(),
    `已复制 ${departmentUnlinkedMirrorCount.value} 个未全绑定部门报告`,
    {
      emptyMessage: '当前没有可复制的未绑定部门',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制未绑定部门内容',
      failureMessage: '复制未绑定部门报告失败，请手动复制未绑定部门内容',
    },
  )
}

async function copyInactiveDepartmentReport(): Promise<void> {
  await writeClipboardText(
    buildInactiveDepartmentReport(),
    `已复制 ${inactiveDepartmentCount.value} 个停用部门报告`,
    {
      emptyMessage: '当前没有可复制的停用部门',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制停用部门内容',
      failureMessage: '复制停用部门报告失败，请手动复制停用部门内容',
    },
  )
}

async function copyDepartmentMirrorObservationReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentMirrorObservationReport(),
    `已复制 ${departmentRows.value.length} 个部门的同步观测报告`,
    {
      emptyMessage: '当前没有可复制的同步观测数据',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制同步观测内容',
      failureMessage: '复制同步观测报告失败，请手动复制同步观测内容',
    },
  )
}

async function copyDepartmentDraftScopeChangeReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentDraftScopeChangeReport(),
    `已复制 ${departmentDraftScopeChanges.value.length} 个部门范围草稿变更报告`,
    {
      emptyMessage: '当前没有可复制的部门范围草稿变更',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制草稿变更内容',
      failureMessage: '复制部门范围草稿变更报告失败，请手动复制草稿变更内容',
    },
  )
}

function buildDepartmentConfigReferenceIssues(
  items: DirectoryDepartment[],
  scope: Record<DirectoryDepartmentTargetField, Set<string>>,
): DirectoryDepartmentReferenceIssue[] {
  const hasConfiguredScope = departmentTargetFields.some((field) => scope[field].size > 0)
  if (items.length === 0 && !hasConfiguredScope) return []
  const departmentByExternalId = new Map(items.map((item) => [item.externalDepartmentId, item]))
  const issues: DirectoryDepartmentReferenceIssue[] = []
  for (const field of departmentTargetFields) {
    const fieldLabel = readDepartmentTargetLabel(field)
    for (const departmentId of scope[field]) {
      const department = departmentByExternalId.get(departmentId)
      if (!department) {
        issues.push({
          key: `${field}:missing:${departmentId}`,
          field,
          fieldLabel,
          kind: 'missing',
          departmentId,
          departmentName: '',
        })
        continue
      }
      if (!department.isActive) {
        issues.push({
          key: `${field}:inactive:${departmentId}`,
          field,
          fieldLabel,
          kind: 'inactive',
          departmentId,
          departmentName: department.name,
        })
      }
    }
  }
  return issues
}

function readDepartmentReferenceIssueLabel(issue: DirectoryDepartmentReferenceIssue): string {
  if (issue.kind === 'missing') {
    return `${issue.fieldLabel}引用不存在的部门 ID ${issue.departmentId}`
  }
  return `${issue.fieldLabel}引用已停用部门 ${issue.departmentName} (${issue.departmentId})`
}

function addDepartmentIdToTarget(
  departmentId: string,
  departmentName: string,
  field: DirectoryDepartmentTargetField,
  options: { manual?: boolean } = {},
): boolean {
  const normalizedDepartmentId = departmentId.trim()
  const normalizedDepartmentName = departmentName.trim() || (options.manual ? '手动部门' : '部门')
  const targetLabel = readDepartmentTargetLabel(field)
  if (normalizedDepartmentId.length === 0) {
    setStatus(`${normalizedDepartmentName}缺少部门 ID，无法加入${targetLabel}`, 'error')
    return false
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  if (currentIds.includes(normalizedDepartmentId)) {
    setStatus(`${normalizedDepartmentName} (${normalizedDepartmentId}) 已在${targetLabel}中`)
    return false
  }
  writeDepartmentTargetText(field, [...currentIds, normalizedDepartmentId])
  setStatus(`已将${options.manual ? '手动部门' : '部门'} ${normalizedDepartmentName} (${normalizedDepartmentId}) 加入${targetLabel}`)
  return true
}

function addDepartmentToTarget(department: DirectoryDepartment, field: DirectoryDepartmentTargetField): void {
  addDepartmentIdToTarget(department.externalDepartmentId, department.name, field)
}

function addVisibleDepartmentsToTarget(field: DirectoryDepartmentTargetField): void {
  const targetLabel = readDepartmentTargetLabel(field)
  const departmentIds = visibleDepartmentRows.value
    .map((department) => department.externalDepartmentId.trim())
    .filter((departmentId) => departmentId.length > 0)
  if (departmentIds.length === 0) {
    setStatus(`当前没有可加入${targetLabel}的可见部门`, 'error')
    return
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  const currentSet = new Set(currentIds)
  const nextIds = [...currentIds]
  for (const departmentId of departmentIds) {
    if (currentSet.has(departmentId)) continue
    currentSet.add(departmentId)
    nextIds.push(departmentId)
  }
  const addedCount = nextIds.length - currentIds.length
  if (addedCount === 0) {
    setStatus(`当前可见部门均已在${targetLabel}中`)
    return
  }
  writeDepartmentTargetText(field, nextIds)
  setStatus(`已将 ${addedCount} 个当前可见部门加入${targetLabel}`)
}

function removeVisibleDepartmentsFromTarget(field: DirectoryDepartmentTargetField): void {
  const targetLabel = readDepartmentTargetLabel(field)
  const departmentIds = new Set(
    visibleDepartmentRows.value
      .map((department) => department.externalDepartmentId.trim())
      .filter((departmentId) => departmentId.length > 0),
  )
  if (departmentIds.size === 0) {
    setStatus(`当前没有可从${targetLabel}移除的可见部门`, 'error')
    return
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  const nextIds = currentIds.filter((departmentId) => !departmentIds.has(departmentId))
  const removedCount = currentIds.length - nextIds.length
  if (removedCount === 0) {
    setStatus(`当前可见部门不在${targetLabel}中`)
    return
  }
  writeDepartmentTargetText(field, nextIds)
  setStatus(`已从${targetLabel}移除 ${removedCount} 个当前可见部门`)
}

function addManualDepartmentToTarget(field: DirectoryDepartmentTargetField): void {
  addDepartmentIdToTarget(manualDepartmentId.value, manualDepartmentName.value, field, { manual: true })
}

function removeDepartmentFromTarget(departmentId: string, field: DirectoryDepartmentTargetField): void {
  const normalizedDepartmentId = departmentId.trim()
  const targetLabel = readDepartmentTargetLabel(field)
  if (normalizedDepartmentId.length === 0) {
    setStatus(`缺少部门 ID，无法从${targetLabel}移除`, 'error')
    return
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  const nextIds = currentIds.filter((id) => id !== normalizedDepartmentId)
  if (nextIds.length === currentIds.length) {
    setStatus(`部门 ${normalizedDepartmentId} 不在${targetLabel}中`)
    return
  }
  writeDepartmentTargetText(field, nextIds)
  setStatus(`已将部门 ${normalizedDepartmentId} 从${targetLabel}移除`)
}

function removeAllDepartmentReferenceIssues(): void {
  const issues = departmentConfigReferenceIssues.value
  if (issues.length === 0) {
    setStatus('当前没有需要清理的异常部门引用')
    return
  }
  const removeIdsByField: Record<DirectoryDepartmentTargetField, Set<string>> = {
    admission: new Set(),
    exclude: new Set(),
    memberGroup: new Set(),
  }
  for (const issue of issues) {
    removeIdsByField[issue.field].add(issue.departmentId)
  }
  for (const field of departmentTargetFields) {
    const removeIds = removeIdsByField[field]
    if (removeIds.size === 0) continue
    const nextIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
      .filter((id) => !removeIds.has(id))
    writeDepartmentTargetText(field, nextIds)
  }
  setStatus(`已清理 ${issues.length} 个异常部门引用`)
}

function readAdmissionModeLabel(integration: DirectoryIntegration): string {
  if (integration.config.admissionMode === 'auto_for_scoped_departments') {
    const includeCount = integration.config.admissionDepartmentIds.length
    const excludeCount = integration.config.excludeDepartmentIds.length
    const includeLabel = includeCount > 0 ? `${includeCount} 个部门白名单` : '未配置白名单'
    if (excludeCount > 0) return `自动准入 · ${includeLabel} / 排除 ${excludeCount} 个部门`
    return `自动准入 · ${includeLabel}`
  }
  return '自动准入已关闭'
}

function readMemberGroupSyncLabel(integration: DirectoryIntegration): string {
  if (integration.config.memberGroupSyncMode === 'sync_scoped_departments') {
    const count = integration.config.memberGroupDepartmentIds.length
    const governanceParts: string[] = []
    if (integration.config.memberGroupDefaultRoleIds.length > 0) {
      governanceParts.push(`默认角色 ${integration.config.memberGroupDefaultRoleIds.length}`)
    }
    if (integration.config.memberGroupDefaultNamespaces.length > 0) {
      governanceParts.push(`默认开通 ${integration.config.memberGroupDefaultNamespaces.length}`)
    }
    const scopeLabel = count > 0 ? `成员组同步 · ${count} 个部门` : '成员组同步 · 未配置部门'
    return governanceParts.length > 0 ? `${scopeLabel} / ${governanceParts.join(' / ')}` : scopeLabel
  }
  return '成员组同步已关闭'
}

function buildDirectoryDepartmentTreeRows(items: DirectoryDepartment[]): DirectoryDepartmentTreeRow[] {
  if (items.length === 0) return []
  const byExternalId = new Map(items.map((item) => [item.externalDepartmentId, item]))
  const childrenByParent = new Map<string, DirectoryDepartment[]>()
  const roots: DirectoryDepartment[] = []

  for (const item of items) {
    const parentId = item.parentExternalDepartmentId?.trim() || ''
    if (!parentId || !byExternalId.has(parentId)) {
      roots.push(item)
      continue
    }
    const children = childrenByParent.get(parentId) ?? []
    children.push(item)
    childrenByParent.set(parentId, children)
  }

  const sortDepartments = (left: DirectoryDepartment, right: DirectoryDepartment) => (
    left.orderIndex - right.orderIndex
    || left.name.localeCompare(right.name, 'zh-Hans-CN')
    || left.externalDepartmentId.localeCompare(right.externalDepartmentId)
  )
  roots.sort(sortDepartments)
  for (const children of childrenByParent.values()) {
    children.sort(sortDepartments)
  }

  const rows: DirectoryDepartmentTreeRow[] = []
  const visit = (item: DirectoryDepartment, depth: number, seen: Set<string>) => {
    if (seen.has(item.externalDepartmentId)) return
    rows.push({ ...item, depth })
    const nextSeen = new Set(seen)
    nextSeen.add(item.externalDepartmentId)
    for (const child of childrenByParent.get(item.externalDepartmentId) ?? []) {
      visit(child, depth + 1, nextSeen)
    }
  }
  for (const root of roots) visit(root, 0, new Set())
  return rows
}

function normalizeDepartmentSearchValue(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('zh-Hans-CN')
}

function filterDirectoryDepartmentRows(
  rows: DirectoryDepartmentTreeRow[],
  query: string,
): DirectoryDepartmentTreeRow[] {
  const normalizedQuery = normalizeDepartmentSearchValue(query)
  if (normalizedQuery.length === 0) return rows
  return rows.filter((department) => {
    const searchable = [
      department.name,
      department.fullPath,
      department.externalDepartmentId,
      department.parentExternalDepartmentId,
    ]
      .map(normalizeDepartmentSearchValue)
      .join(' ')
    return searchable.includes(normalizedQuery)
  })
}

function readDepartmentIndentStyle(department: DirectoryDepartmentTreeRow): Record<string, string> {
  return {
    paddingLeft: `${Math.min(department.depth, 8) * 18 + 14}px`,
  }
}

function describeDepartmentParent(department: DirectoryDepartment): string {
  const parentId = department.parentExternalDepartmentId?.trim()
  if (!parentId) return '根部门'
  const parent = departments.value.find((item) => item.externalDepartmentId === parentId)
  return parent ? `${parent.name} (${parent.externalDepartmentId})` : parentId
}

async function selectIntegration(integrationId: string): Promise<void> {
  selectedIntegrationId.value = integrationId
  testResult.value = null
  departments.value = []
  departmentsLoaded.value = false
  departmentLoadError.value = ''
  departmentQuery.value = ''
  departmentScopeFilter.value = 'all'
  manualDepartmentId.value = ''
  manualDepartmentName.value = ''
  clearAutoAdmissionOnboardingPackets()
  clearFocusedAccount()
  accountPage.value = 1
  accountTotal.value = 0
  reviewBatchProgress.value = null
  alertFilter.value = 'all'
  reviewFilter.value = 'all'
  pendingBindingView.value = 'recommended'
  pendingBindingViewTouched.value = false
  pendingBindingManualReason.value = 'all'
  reviewPage.value = 1
  reviewTotal.value = 0
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
  const integration = integrations.value.find((item) => item.id === integrationId)
  if (!integration) return
  applyIntegrationToDraft(integration)
  await applyInitialDirectoryNavigationBeforeLoads(integrationId)
  await Promise.all([
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

function readApiErrorCode(payload: unknown): string {
  const error = payload && typeof payload === 'object' ? (payload as { error?: { code?: unknown } }).error : undefined
  return typeof error?.code === 'string' ? error.code : ''
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
    const navigation = directoryNavigation.value
    const navigationKey = buildDirectoryNavigationKey(navigation)
    const hasPendingCrossIntegrationNavigation = (
      navigation.accountId.length > 0
      && navigation.integrationId.length > 0
      && navigation.integrationId !== selectedIntegrationId.value
      && navigationKey !== appliedDirectoryNavigationKey.value
    )
    if (!selectedIntegrationId.value && integrations.value.length > 0) {
      const requestedIntegrationId = navigation.integrationId
      const requestedIntegration = requestedIntegrationId
        ? integrations.value.find((item) => item.id === requestedIntegrationId)
        : null
      if (requestedIntegrationId && !requestedIntegration) {
        clearFocusedAccountNavigationState()
        const message = readDirectoryIntegrationMissingMessage(requestedIntegrationId)
        setStatus(message, 'error')
        setRouteNavigationFailureNotice({
          kind: 'missing_integration',
          message,
          targetIntegrationId: requestedIntegrationId,
          targetAccountId: navigation.accountId,
          currentIntegrationName: integrations.value[0]?.name ?? '',
        })
      }
      const targetIntegration = requestedIntegration || integrations.value[0]
      if (targetIntegration) await selectIntegration(targetIntegration.id)
    } else if (hasPendingCrossIntegrationNavigation) {
      const targetIntegration = integrations.value.find((item) => item.id === navigation.integrationId)
      if (targetIntegration) {
        await selectIntegration(targetIntegration.id)
        return
      }
      clearFocusedAccountNavigationState()
      const message = readDirectoryIntegrationMissingMessage(navigation.integrationId)
      setStatus(message, 'error')
      setRouteNavigationFailureNotice({
        kind: 'missing_integration',
        message,
        targetIntegrationId: navigation.integrationId,
        targetAccountId: navigation.accountId,
        currentIntegrationName: selectedIntegration.value?.name ?? '',
      })
      const current = integrations.value.find((item) => item.id === selectedIntegrationId.value)
      if (current) {
        applyIntegrationToDraft(current)
        await loadAccounts(current.id)
      }
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
  return bindingDrafts[account.id] ?? describeLocalUserIdentifier(account.localUser) ?? ''
}

function readBindingDraftByAccountId(accountId: string): string {
  const account = accounts.value.find((item) => item.id === accountId)
  if (!account) return bindingDrafts[accountId] ?? ''
  return readBindingDraft(account)
}

function clearFocusedAccount() {
  focusedAccountId.value = ''
  pendingFocusedAccountScroll.value = false
}

function clearFocusedAccountNavigationState() {
  clearFocusedAccount()
  accountQuery.value = ''
  accountPage.value = 1
}

function clearRouteNavigationFailureNotice() {
  routeNavigationFailureNotice.value = null
}

async function retryRouteNavigationFailureNotice(): Promise<void> {
  if (!routeNavigationFailureNotice.value || routeNavigationFailureAction.value.length > 0) return
  routeNavigationFailureAction.value = 'retry'
  try {
    appliedDirectoryNavigationKey.value = ''
    await handleDirectoryNavigationChange()
  } finally {
    routeNavigationFailureAction.value = ''
  }
}

function clearFailedDirectoryNavigation() {
  if (!routeNavigationFailureNotice.value || routeNavigationFailureAction.value.length > 0) return
  routeNavigationFailureAction.value = 'clear'
  try {
    const retainedIntegrationId = selectedIntegration.value?.id ?? selectedIntegrationId.value
    const retainedIntegrationName = selectedIntegration.value?.name ?? routeNavigationFailureNotice.value.currentIntegrationName
    clearRouteNavigationFailureNotice()
    replaceDirectoryNavigation({
      integrationId: retainedIntegrationId,
      accountId: '',
      source: '',
      userId: '',
    })
    setStatus(retainedIntegrationName ? `已保留当前目录上下文 ${retainedIntegrationName}` : '已清除失败定位条件')
  } finally {
    routeNavigationFailureAction.value = ''
  }
}

function setRouteNavigationFailureNotice(notice: DirectoryRouteNavigationFailureNotice) {
  routeNavigationFailureNotice.value = notice
}

function readDirectoryIntegrationMissingMessage(integrationId: string): string {
  return `未找到目录集成 ${integrationId}，请确认该集成仍存在或稍后刷新列表重试`
}

function readDirectoryAccountMissingMessage(accountId: string): string {
  return `未找到目录成员 ${accountId}，请确认该成员仍存在`
}

function updateBindingDraft(accountId: string, value: string) {
  bindingDrafts[accountId] = value
  const selectedUser = selectedBindingUsers[accountId]
  if (!selectedUser) return
  const normalizedValue = value.trim()
  const selectedIdentifiers = new Set([
    selectedUser.id,
    selectedUser.email || '',
    selectedUser.username || '',
    selectedUser.mobile || '',
  ].filter((item) => item.trim().length > 0))
  if (!selectedIdentifiers.has(normalizedValue)) {
    delete selectedBindingUsers[accountId]
    delete mobileOverrideConfirmations[accountId]
    delete mobileConflictHints[accountId]
  }
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
  updateBindingDraft(accountId, describeLocalUserIdentifier(user))
  selectedBindingUsers[accountId] = user
  delete mobileOverrideConfirmations[accountId]
  delete mobileConflictHints[accountId]
  setBindingSearchState(accountId, { results: [] })
}

function applyRecommendedLocalUser(accountId: string, recommendation: DirectoryBindingRecommendation) {
  updateBindingDraft(accountId, describeLocalUserIdentifier(recommendation.localUser))
  selectedBindingUsers[accountId] = recommendation.localUser
  delete mobileOverrideConfirmations[accountId]
  delete mobileConflictHints[accountId]
  clearBindingSearch(accountId)
}

function readSelectedBindingUser(item: DirectoryReviewItem): LocalUserOption | null {
  return selectedBindingUsers[item.account.id] ?? item.recommendations[0]?.localUser ?? null
}

function hasSelectedBindingUserMobileConflict(item: DirectoryReviewItem): boolean {
  const selectedUser = readSelectedBindingUser(item)
  const accountMobile = item.account.mobile?.trim() || ''
  const userMobile = selectedUser?.mobile?.trim() || ''
  return accountMobile.length > 0 && userMobile.length > 0 && accountMobile !== userMobile
}

function shouldOfferMobileBackfill(item: DirectoryReviewItem): boolean {
  const selectedUser = readSelectedBindingUser(item)
  const accountMobile = item.account.mobile?.trim() || ''
  const userMobile = selectedUser?.mobile?.trim() || ''
  return item.kind === 'pending_binding' && accountMobile.length > 0 && selectedUser !== null && accountMobile !== userMobile
}

function isAwaitingMobileOverrideConfirmation(accountId: string): boolean {
  return mobileOverrideConfirmations[accountId] === true
}

function clearMobileOverrideConfirmation(accountId: string): void {
  delete mobileOverrideConfirmations[accountId]
}

function readBackfillAndBindLabel(item: DirectoryReviewItem): string {
  if (hasSelectedBindingUserMobileConflict(item)) {
    return isAwaitingMobileOverrideConfirmation(item.account.id) ? '确认覆盖手机号并绑定' : '回填手机号后绑定'
  }
  return '回填手机号后绑定'
}

async function refreshSingleReviewItem(accountId: string): Promise<void> {
  const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(accountId)}/review-item`)
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, '刷新待绑定项失败'))
  const item = body?.data?.item
  if (!item || typeof item !== 'object') return
  const normalizedItem = normalizeReviewItems([item])[0]
  if (!normalizedItem) return
  const currentIndex = reviewItems.value.findIndex((entry) => entry.account.id === accountId)
  if (currentIndex >= 0) {
    reviewItems.value = reviewItems.value.map((entry, index) => index === currentIndex ? normalizedItem : entry)
  } else {
    reviewItems.value = [normalizedItem, ...reviewItems.value]
  }
  syncPendingBindingQueueDefaults()
}

function readMobileConflictHint(accountId: string): string {
  return mobileConflictHints[accountId] ?? ''
}

function clearMobileConflictHint(accountId: string): void {
  delete mobileConflictHints[accountId]
}

async function refreshSingleAccount(accountId: string): Promise<void> {
  const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(accountId)}`)
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, '刷新目录成员失败'))
  const account = body?.data?.account as DirectoryAccount | undefined
  if (!account) return
  const currentIndex = accounts.value.findIndex((entry) => entry.id === accountId)
  if (currentIndex >= 0) {
    accounts.value = accounts.value.map((entry, index) => index === currentIndex ? account : entry)
  }
}

function readRecommendationReasonLabel(reasons: DirectoryBindingRecommendationReason[]): string {
  return reasons.map((reason) => {
    if (reason === 'pending_link') return '已存在待确认匹配'
    if (reason === 'email') return '邮箱精确匹配'
    return '手机号精确匹配'
  }).join(' · ')
}

function readGrantToggle(accountId: string): boolean {
  return grantToggles[accountId] ?? true
}

function canEnableDingTalkGrant(account: Partial<Pick<DirectoryAccount, 'corpId' | 'openId'>>): boolean {
  return !((account.corpId?.trim() ?? '').length > 0 && (account.openId?.trim() ?? '').length === 0)
}

function readAccountGrantToggle(account: DirectoryAccount): boolean {
  return canEnableDingTalkGrant(account) && readGrantToggle(account.id)
}

function shouldWarnMissingOpenIdForGrant(account: Partial<Pick<DirectoryAccount, 'corpId' | 'openId'>>): boolean {
  return !canEnableDingTalkGrant(account)
}

function updateGrantToggle(accountId: string, value: boolean) {
  grantToggles[accountId] = value
}

function onGrantToggleChange(account: DirectoryAccount, event: Event) {
  const target = event.target
  if (!canEnableDingTalkGrant(account)) {
    updateGrantToggle(account.id, false)
    setStatus(`目录成员 ${account.name} 缺少 openId，暂不能开通钉钉登录；请重新同步目录或完成钉钉 OAuth 绑定`, 'error')
    return
  }
  updateGrantToggle(account.id, target instanceof HTMLInputElement ? target.checked : true)
}

function clearBindingSearch(accountId: string) {
  setBindingSearchState(accountId, { results: [], error: '' })
}

function buildManualAdmissionDraft(account: DirectoryAccount): ManualAdmissionDraft {
  return {
    name: account.name?.trim() || '',
    email: account.email?.trim() || '',
    username: '',
    mobile: account.mobile?.trim() || '',
  }
}

function readManualAdmissionDraft(account: DirectoryAccount): ManualAdmissionDraft {
  if (!manualAdmissionDrafts[account.id]) {
    manualAdmissionDrafts[account.id] = buildManualAdmissionDraft(account)
  }
  return manualAdmissionDrafts[account.id]
}

function isManualAdmissionExpanded(accountId: string): boolean {
  return manualAdmissionExpanded[accountId] === true
}

function toggleManualAdmission(account: DirectoryAccount): void {
  readManualAdmissionDraft(account)
  manualAdmissionExpanded[account.id] = !isManualAdmissionExpanded(account.id)
}

function onManualAdmissionDraftInput(accountId: string, field: keyof ManualAdmissionDraft, event: Event): void {
  const target = event.target
  const nextValue = target instanceof HTMLInputElement ? target.value : ''
  const current = manualAdmissionDrafts[accountId] ?? {
    name: '',
    email: '',
    username: '',
    mobile: '',
  }
  manualAdmissionDrafts[accountId] = {
    ...current,
    [field]: nextValue,
  }
}

function canSubmitManualAdmission(account: DirectoryAccount): boolean {
  const draft = readManualAdmissionDraft(account)
  return draft.name.trim().length > 0
    && (draft.email.trim().length > 0 || draft.username.trim().length > 0 || draft.mobile.trim().length > 0)
}

function describeLocalUserIdentifier(user: Pick<LocalUserOption, 'id' | 'email' | 'username' | 'mobile'> | null | undefined): string {
  if (!user) return ''
  return user.email || user.username || user.mobile || user.id
}

function describeLocalUserLabel(user: Pick<LocalUserOption, 'id' | 'email' | 'username' | 'mobile' | 'name'> | null | undefined): string {
  if (!user) return ''
  return user.name || describeLocalUserIdentifier(user)
}

function clearManualAdmissionResult(): void {
  manualAdmissionResult.value = null
}

function clearAutoAdmissionOnboardingPackets(): void {
  autoAdmissionOnboardingPackets.value = []
}

function readCreatedLocalUserOption(data: Record<string, unknown>, fallback: ManualAdmissionDraft): LocalUserOption {
  const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : null
  const id = typeof user?.id === 'string' ? user.id.trim() : ''
  if (!id) {
    throw new Error('创建用户成功但未返回用户 ID')
  }
  return {
    id,
    email: typeof user?.email === 'string' && user.email.trim().length > 0 ? user.email : (fallback.email || null),
    username: typeof user?.username === 'string' && user.username.trim().length > 0 ? user.username : (fallback.username || null),
    name: typeof user?.name === 'string' && user.name.trim().length > 0 ? user.name : fallback.name,
    mobile: typeof user?.mobile === 'string' && user.mobile.trim().length > 0 ? user.mobile : null,
    role: typeof user?.role === 'string' && user.role.trim().length > 0 ? user.role : 'user',
    is_active: typeof user?.is_active === 'boolean' ? user.is_active : true,
  }
}

function readAutoAdmissionOnboardingPackets(data: Record<string, unknown> | undefined): AutoAdmissionOnboardingPacket[] {
  const rawPackets = Array.isArray(data?.autoAdmissionOnboardingPackets) ? data.autoAdmissionOnboardingPackets : []
  return rawPackets.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const packet = entry as Record<string, unknown>
    const userId = typeof packet.userId === 'string' ? packet.userId.trim() : ''
    if (!userId) return []
    return [{
      userId,
      name: typeof packet.name === 'string' ? packet.name : '',
      email: typeof packet.email === 'string' && packet.email.trim().length > 0 ? packet.email : null,
      username: typeof packet.username === 'string' && packet.username.trim().length > 0 ? packet.username : null,
      mobile: typeof packet.mobile === 'string' && packet.mobile.trim().length > 0 ? packet.mobile : null,
      temporaryPassword: typeof packet.temporaryPassword === 'string' ? packet.temporaryPassword : '',
      onboarding: packet.onboarding && typeof packet.onboarding === 'object'
        ? packet.onboarding as OnboardingPacket
        : null,
    }]
  })
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
    admissionMode: draft.admissionMode,
    admissionDepartmentIds: parseAdmissionDepartmentIdsText(draft.admissionDepartmentIdsText),
    excludeDepartmentIds: parseAdmissionDepartmentIdsText(draft.excludeDepartmentIdsText),
    memberGroupSyncMode: draft.memberGroupSyncMode,
    memberGroupDepartmentIds: parseAdmissionDepartmentIdsText(draft.memberGroupDepartmentIdsText),
    memberGroupDefaultRoleIds: parseAdmissionDepartmentIdsText(draft.memberGroupDefaultRoleIdsText),
    memberGroupDefaultNamespaces: parseAdmissionDepartmentIdsText(draft.memberGroupDefaultNamespacesText),
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
    if (integration?.id) await selectIntegration(integration.id)
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

function buildWorkNotificationPayload() {
  return {
    integrationId: selectedIntegration.value?.id ?? '',
    agentId: draft.workNotificationAgentId.trim(),
    recipientUserId: draft.workNotificationTestUserId.trim(),
  }
}

async function testWorkNotificationAgentId() {
  if (!selectedIntegration.value) {
    setStatus('请先选择或创建钉钉目录集成', 'error')
    return
  }
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/dingtalk/work-notification/test', {
      method: 'POST',
      body: JSON.stringify(buildWorkNotificationPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '工作通知 Agent ID 测试失败'))
    const notificationSent = body?.data?.result?.notificationSent === true
    setStatus(notificationSent
      ? '工作通知 Agent ID 测试通过，已发送测试消息'
      : '工作通知 Agent ID 基础测试通过；未填写测试接收人，未发送真实工作通知')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '工作通知 Agent ID 测试失败', 'error')
  } finally {
    busy.value = false
  }
}

async function saveWorkNotificationAgentId() {
  if (!selectedIntegration.value) {
    setStatus('请先选择或创建钉钉目录集成', 'error')
    return
  }
  if (!draft.workNotificationAgentId.trim()) {
    setStatus('请填写工作通知 Agent ID', 'error')
    return
  }
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/dingtalk/work-notification', {
      method: 'PUT',
      body: JSON.stringify(buildWorkNotificationPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '保存工作通知 Agent ID 失败'))
    const currentIntegrationId = selectedIntegration.value.id
    setStatus('工作通知 Agent ID 已验证并保存')
    await loadIntegrations()
    await selectIntegration(currentIntegrationId)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存工作通知 Agent ID 失败', 'error')
  } finally {
    busy.value = false
  }
}

async function syncIntegration() {
  if (!selectedIntegration.value) return
  busy.value = true
  try {
    clearAutoAdmissionOnboardingPackets()
    const response = await apiFetch(`/api/admin/directory/integrations/${selectedIntegration.value.id}/sync`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '目录同步失败'))
    autoAdmissionOnboardingPackets.value = readAutoAdmissionOnboardingPackets(body?.data as Record<string, unknown> | undefined)
    const autoAdmittedCount = Number(body?.data?.run?.stats?.autoAdmittedCount ?? 0)
    const autoAdmittedNoEmailCount = Number(body?.data?.run?.stats?.autoAdmittedNoEmailCount ?? 0)
    const autoAdmissionSkippedMissingEmailCount = Number(body?.data?.run?.stats?.autoAdmissionSkippedMissingEmailCount ?? 0)
    const autoAdmissionExcludedCount = Number(body?.data?.run?.stats?.autoAdmissionExcludedCount ?? 0)
    const memberGroupsSyncedCount = Number(body?.data?.run?.stats?.memberGroupsSyncedCount ?? 0)
    const memberGroupsCreatedCount = Number(body?.data?.run?.stats?.memberGroupsCreatedCount ?? 0)
    const memberGroupGovernedUserCount = Number(body?.data?.run?.stats?.memberGroupGovernedUserCount ?? 0)
    const memberGroupDefaultRoleAssignmentsCount = Number(body?.data?.run?.stats?.memberGroupDefaultRoleAssignmentsCount ?? 0)
    const memberGroupDefaultNamespaceAdmissionsCount = Number(body?.data?.run?.stats?.memberGroupDefaultNamespaceAdmissionsCount ?? 0)
    if (
      autoAdmittedCount > 0
      || autoAdmittedNoEmailCount > 0
      || autoAdmissionSkippedMissingEmailCount > 0
      || autoAdmissionExcludedCount > 0
      || memberGroupsSyncedCount > 0
      || memberGroupGovernedUserCount > 0
    ) {
      const parts = ['目录同步已完成']
      if (autoAdmittedCount > 0) parts.push(`自动准入 ${autoAdmittedCount} 位成员`)
      if (autoAdmittedNoEmailCount > 0) parts.push(`其中 ${autoAdmittedNoEmailCount} 位成员无邮箱，已生成平台登录账号和临时密码`)
      if (autoAdmissionSkippedMissingEmailCount > 0) parts.push(`${autoAdmissionSkippedMissingEmailCount} 位成员因缺少邮箱未自动创建`)
      if (autoAdmissionExcludedCount > 0) parts.push(`${autoAdmissionExcludedCount} 位成员命中排除部门，未自动创建`)
      if (memberGroupsSyncedCount > 0) {
        if (memberGroupsCreatedCount > 0) {
          parts.push(`同步 ${memberGroupsSyncedCount} 个成员组（新建 ${memberGroupsCreatedCount} 个）`)
        } else {
          parts.push(`同步 ${memberGroupsSyncedCount} 个成员组`)
        }
      }
      if (memberGroupGovernedUserCount > 0) {
        const governanceDetails: string[] = []
        if (memberGroupDefaultRoleAssignmentsCount > 0) governanceDetails.push(`角色新增 ${memberGroupDefaultRoleAssignmentsCount} 项`)
        if (memberGroupDefaultNamespaceAdmissionsCount > 0) governanceDetails.push(`插件开通新增 ${memberGroupDefaultNamespaceAdmissionsCount} 项`)
        parts.push(
          governanceDetails.length > 0
            ? `为 ${memberGroupGovernedUserCount} 位成员补齐默认治理（${governanceDetails.join('，')}）`
            : `为 ${memberGroupGovernedUserCount} 位成员补齐默认治理`,
        )
      }
      setStatus(parts.join('，'))
    } else {
      setStatus('目录同步已完成')
    }
    await Promise.all([
      loadIntegrations(),
      loadRuns(selectedIntegration.value.id),
      loadScheduleSnapshot(selectedIntegration.value.id),
      loadAlerts(selectedIntegration.value.id),
      loadReviewItems(selectedIntegration.value.id),
      loadAccounts(selectedIntegration.value.id),
      departmentsLoaded.value ? loadDepartments(selectedIntegration.value.id, { force: true }) : Promise.resolve(),
    ])
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '目录同步失败', 'error')
  } finally {
    busy.value = false
  }
}

async function searchAccounts() {
  if (!selectedIntegration.value) return
  clearFocusedAccount()
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
}

async function changeAccountPage(nextPage: number) {
  if (!selectedIntegration.value) return
  const normalizedPage = Math.max(1, Math.min(nextPage, accountPageCount.value))
  if (normalizedPage === accountPage.value) return
  clearFocusedAccount()
  accountPage.value = normalizedPage
  await loadAccounts(selectedIntegration.value.id)
}

async function updateAccountPageSize(event: Event) {
  if (!selectedIntegration.value) return
  const target = event.target
  const nextPageSize = Number(target instanceof HTMLSelectElement ? target.value : accountPageSize.value)
  if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === accountPageSize.value) return
  clearFocusedAccount()
  accountPageSize.value = nextPageSize
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
}

async function scrollFocusedAccountIntoView() {
  await nextTick()
  const section = accountsSectionRef.value
  const focusedAccountElement = section?.querySelector('.directory-admin__account--focused')
  if (focusedAccountElement instanceof HTMLElement) {
    focusedAccountElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (section instanceof HTMLElement) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
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
    if (pendingFocusedAccountScroll.value) {
      pendingFocusedAccountScroll.value = false
      await scrollFocusedAccountIntoView()
    }
  } catch (error) {
    accounts.value = []
    accountTotal.value = 0
    pendingFocusedAccountScroll.value = false
    setStatus(error instanceof Error ? error.message : '加载目录成员失败', 'error')
  } finally {
    loadingAccounts.value = false
  }
}

async function loadDepartments(integrationId: string, options: { force?: boolean } = {}) {
  if (departmentsLoaded.value && options.force !== true) return
  loadingDepartments.value = true
  departmentLoadError.value = ''
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/departments`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载组织架构失败'))
    departments.value = Array.isArray(body?.data?.items) ? body.data.items : []
    departmentsLoaded.value = true
  } catch (error) {
    departments.value = []
    departmentsLoaded.value = true
    departmentLoadError.value = error instanceof Error ? error.message : '加载组织架构失败'
    setStatus(departmentLoadError.value, 'error')
  } finally {
    loadingDepartments.value = false
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

async function loadAlerts(integrationId: string) {
  loadingAlerts.value = true
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '20', filter: 'all' })
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/alerts?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载最近告警失败'))
    alerts.value = Array.isArray(body?.data?.items) ? body.data.items : []
  } catch (error) {
    alerts.value = []
    setStatus(error instanceof Error ? error.message : '加载最近告警失败', 'error')
  } finally {
    loadingAlerts.value = false
  }
}

function normalizeReviewItems(items: unknown[]): DirectoryReviewItem[] {
  return items.map((item) => {
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const recommendationStatusRaw = raw.recommendationStatus && typeof raw.recommendationStatus === 'object'
      ? raw.recommendationStatus as Record<string, unknown>
      : null
    const actionableRaw = raw.actionable && typeof raw.actionable === 'object'
      ? raw.actionable as Record<string, unknown>
      : null

    return {
      ...raw,
      recommendations: Array.isArray(raw.recommendations) ? raw.recommendations as DirectoryBindingRecommendation[] : [],
      recommendationStatus: recommendationStatusRaw
        ? {
          code: typeof recommendationStatusRaw.code === 'string' ? recommendationStatusRaw.code as DirectoryBindingRecommendationStatusCode : 'no_exact_match',
          message: typeof recommendationStatusRaw.message === 'string'
            ? recommendationStatusRaw.message
            : '未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。',
        }
        : null,
      actionable: {
        canBatchUnbind: actionableRaw?.canBatchUnbind === true,
        canConfirmRecommendation: actionableRaw?.canConfirmRecommendation === true,
      },
    } as DirectoryReviewItem
  })
}

function mergeReviewItems(existingItems: DirectoryReviewItem[], incomingItems: DirectoryReviewItem[]): DirectoryReviewItem[] {
  if (existingItems.length === 0) return incomingItems
  const merged = [...existingItems]
  const indexByAccountId = new Map(existingItems.map((item, index) => [item.account.id, index]))
  for (const item of incomingItems) {
    const existingIndex = indexByAccountId.get(item.account.id)
    if (typeof existingIndex === 'number') {
      merged[existingIndex] = item
      continue
    }
    indexByAccountId.set(item.account.id, merged.length)
    merged.push(item)
  }
  return merged
}

async function loadReviewItems(integrationId: string, options: { append?: boolean } = {}) {
  const append = options.append === true
  if (append) loadingMoreReviewItems.value = true
  else loadingReviewItems.value = true
  try {
    const nextPage = append ? reviewPage.value + 1 : 1
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/review-items?page=${nextPage}&pageSize=${reviewPageSize}&filter=all`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载待处理队列失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    const total = typeof body?.data?.total === 'number'
      ? body.data.total
      : Number(body?.data?.total ?? items.length)
    const normalizedTotal = Number.isFinite(total) && total >= 0 ? total : items.length
    const normalizedItems = normalizeReviewItems(items)
    reviewItems.value = append
      ? mergeReviewItems(reviewItems.value, normalizedItems)
      : normalizedItems
    reviewTotal.value = normalizedTotal
    if (!append) reviewPage.value = 1
    else if (normalizedItems.length > 0) reviewPage.value = nextPage
    const validIds = new Set(reviewItems.value.map((item) => item.account.id))
    for (const key of Object.keys(selectedReviewIds)) {
      if (!validIds.has(key)) delete selectedReviewIds[key]
    }
    syncPendingBindingQueueDefaults()
  } catch (error) {
    if (!append) {
      reviewItems.value = []
      reviewPage.value = 1
      reviewTotal.value = 0
      for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
    }
    setStatus(error instanceof Error ? error.message : '加载待处理队列失败', 'error')
  } finally {
    if (append) loadingMoreReviewItems.value = false
    else loadingReviewItems.value = false
  }
}

async function updateAlertFilter(value: DirectoryAlertFilter) {
  alertFilter.value = value
}

async function updateReviewFilter(value: DirectoryReviewItemFilter) {
  reviewFilter.value = value
}

function updatePendingBindingView(value: PendingBindingView) {
  pendingBindingView.value = value
  pendingBindingViewTouched.value = true
  if (value !== 'manual') pendingBindingManualReason.value = 'all'
}

function updatePendingBindingManualReason(value: PendingBindingManualReasonFilter) {
  pendingBindingManualReason.value = value
}

function syncPendingBindingQueueDefaults() {
  if (reviewCounts.value.pending_binding === 0) {
    pendingBindingView.value = 'all'
    pendingBindingViewTouched.value = false
    pendingBindingManualReason.value = 'all'
    clearReviewSelection()
    return
  }

  const recommendedAvailable = pendingBindingCounts.value.recommended > 0
  const manualAvailable = pendingBindingCounts.value.manual > 0

  const currentViewInvalid = (
    (pendingBindingView.value === 'recommended' && !recommendedAvailable)
    || (pendingBindingView.value === 'manual' && !manualAvailable)
  )

  if (!pendingBindingViewTouched.value || currentViewInvalid) {
    if (recommendedAvailable) pendingBindingView.value = 'recommended'
    else if (manualAvailable) pendingBindingView.value = 'manual'
    else pendingBindingView.value = 'all'
    pendingBindingViewTouched.value = false
  }

  if (!manualAvailable || pendingBindingView.value !== 'manual') {
    pendingBindingManualReason.value = 'all'
  } else if (
    pendingBindingManualReason.value !== 'all'
    && pendingBindingManualReasonCounts.value[pendingBindingManualReason.value] === 0
  ) {
    pendingBindingManualReason.value = 'all'
  }

  const hasSelection = Object.keys(selectedReviewIds).length > 0
  if (!hasSelection && pendingBindingView.value === 'recommended' && selectableVisibleRecommendedReviewIds.value.length > 0) {
    selectVisibleRecommendedReviewItems()
  }
}

async function loadMoreReviewItems() {
  if (!selectedIntegration.value || !hasMoreReviewItems.value || loadingMoreReviewItems.value) return
  await loadReviewItems(selectedIntegration.value.id, { append: true })
}

function clearReviewBatchProgress() {
  reviewBatchProgress.value = null
}

function readReviewBatchProgressKindLabel(kind: ReviewBatchProgressKind): string {
  if (kind === 'recommend') return '推荐绑定确认'
  if (kind === 'unbind') return '批量停权处理'
  return '批量绑定'
}

function readReviewBatchProgressPhaseLabel(phase: ReviewBatchProgressPhase): string {
  if (phase === 'submitting') return '提交中'
  if (phase === 'refreshing') return '刷新中'
  if (phase === 'completed') return '已完成'
  return '失败'
}

function readReviewBatchProgressPhaseClass(phase: ReviewBatchProgressPhase): string {
  if (phase === 'completed') return 'directory-admin__chip--success'
  if (phase === 'failed') return 'directory-admin__chip--danger'
  return 'directory-admin__chip--warning'
}

function setReviewBatchProgress(progress: ReviewBatchProgress) {
  reviewBatchProgress.value = progress
}

function readPendingBindingManualReasonCode(item: DirectoryReviewItem): PendingBindingManualReasonFilter {
  if (item.kind !== 'pending_binding' || item.actionable.canConfirmRecommendation) return 'all'
  const code = item.recommendationStatus?.code ?? 'no_exact_match'
  return code === 'no_exact_match' ? 'no_exact_match' : 'conflict'
}

function matchesPendingBindingView(item: DirectoryReviewItem): boolean {
  if (pendingBindingView.value === 'all') return true
  if (pendingBindingView.value === 'recommended') return item.actionable.canConfirmRecommendation
  if (item.actionable.canConfirmRecommendation) return false
  if (pendingBindingManualReason.value === 'all') return true
  return readPendingBindingManualReasonCode(item) === pendingBindingManualReason.value
}

async function acknowledgeAlert(alert: DirectorySyncAlert) {
  if (!selectedIntegration.value || alert.acknowledgedAt) return
  acknowledgingAlertId.value = alert.id
  try {
    const response = await apiFetch(`/api/admin/directory/alerts/${alert.id}/ack`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '确认告警失败'))
    await loadAlerts(selectedIntegration.value.id)
    setStatus('目录告警已确认')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '确认告警失败', 'error')
  } finally {
    acknowledgingAlertId.value = ''
  }
}

async function bindAccount(account: DirectoryAccount) {
  bindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${account.id}/bind`, {
      method: 'POST',
      body: JSON.stringify({
        localUserRef: readBindingDraft(account).trim(),
        enableDingTalkGrant: readAccountGrantToggle(account),
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '绑定目录成员失败'))

    const boundAccount = body?.data?.account as DirectoryAccount | undefined
    if (boundAccount) {
      accounts.value = accounts.value.map((item) => (item.id === boundAccount.id ? boundAccount : item))
      bindingDrafts[account.id] = describeLocalUserIdentifier(boundAccount.localUser) || readBindingDraft(account)
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

async function unbindAccount(account: DirectoryAccount, options: {
  disableDingTalkGrant?: boolean
  successMessage?: string
} = {}) {
  unbindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${account.id}/unbind`, {
      method: 'POST',
      body: JSON.stringify({
        disableDingTalkGrant: options.disableDingTalkGrant === true,
      }),
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
    setStatus(options.successMessage ?? `目录成员 ${account.name} 已解除绑定`)
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

function updateReviewSelection(accountId: string, checked: boolean) {
  if (checked) selectedReviewIds[accountId] = true
  else delete selectedReviewIds[accountId]
}

function clearReviewSelection() {
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
}

function selectVisibleReviewItems() {
  clearReviewSelection()
  for (const accountId of selectableVisibleReviewIds.value) {
    selectedReviewIds[accountId] = true
  }
}

function selectVisibleRecommendedReviewItems() {
  clearReviewSelection()
  for (const accountId of selectableVisibleRecommendedReviewIds.value) {
    selectedReviewIds[accountId] = true
  }
}

function onReviewSelectionChange(accountId: string, event: Event) {
  const target = event.target
  updateReviewSelection(accountId, target instanceof HTMLInputElement ? target.checked : false)
}

function focusReviewAccount(item: DirectoryReviewItem) {
  focusedAccountId.value = item.account.id
  pendingFocusedAccountScroll.value = true
  accountQuery.value = item.account.externalUserId
  if (selectedIntegration.value) {
    accountPage.value = 1
    void loadAccounts(selectedIntegration.value.id)
  }
}

async function applyInitialDirectoryNavigationBeforeLoads(integrationId: string): Promise<void> {
  const navigation = directoryNavigation.value
  const navigationKey = buildDirectoryNavigationKey(navigation)
  if (navigationKey && appliedDirectoryNavigationKey.value === navigationKey) return
  const targetAccountId = navigation.accountId
  if (!targetAccountId) {
    appliedDirectoryNavigationKey.value = navigationKey
    return
  }
  if (navigation.integrationId && navigation.integrationId !== integrationId) return

  try {
    clearFocusedAccountNavigationState()
    const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(targetAccountId)}`)
    const body = await readJson(response)
    if (!response.ok) {
      const fallback = response.status === 404
        ? readDirectoryAccountMissingMessage(targetAccountId)
        : '定位目录成员失败'
      throw new Error(readApiError(body, fallback))
    }
    const account = body?.data?.account as DirectoryAccount | undefined
    if (!account) throw new Error(readDirectoryAccountMissingMessage(targetAccountId))
    clearRouteNavigationFailureNotice()
    focusedAccountId.value = account.id
    pendingFocusedAccountScroll.value = true
    accountQuery.value = account.externalUserId
    accountPage.value = 1
    if (navigation.source === 'user-management') {
      setStatus(`已从用户管理定位到目录成员 ${account.name}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '定位目录成员失败'
    setStatus(message, 'error')
    setRouteNavigationFailureNotice({
      kind: 'missing_account',
      message,
      targetIntegrationId: navigation.integrationId || integrationId,
      targetAccountId,
      currentIntegrationName: selectedIntegration.value?.name ?? '',
    })
  } finally {
    appliedDirectoryNavigationKey.value = navigationKey
  }
}

async function handleDirectoryNavigationChange(): Promise<void> {
  const navigation = directoryNavigation.value
  const navigationKey = buildDirectoryNavigationKey(navigation)
  if (!navigation.accountId) {
    clearRouteNavigationFailureNotice()
    appliedDirectoryNavigationKey.value = navigationKey
    return
  }
  if (navigationKey && appliedDirectoryNavigationKey.value === navigationKey) return

  const targetIntegrationId = navigation.integrationId || selectedIntegrationId.value || integrations.value[0]?.id || ''
  if (!targetIntegrationId) return

  if (selectedIntegrationId.value !== targetIntegrationId) {
    const targetExists = integrations.value.some((item) => item.id === targetIntegrationId)
    if (targetExists) {
      await selectIntegration(targetIntegrationId)
      return
    }
    await loadIntegrations()
    return
  }

  await applyInitialDirectoryNavigationBeforeLoads(targetIntegrationId)
  await Promise.all([
    loadReviewItems(targetIntegrationId),
    loadAccounts(targetIntegrationId),
  ])
}

function buildUserManagementLocation(userId: string, account: Pick<DirectoryAccount, 'id' | 'integrationId'> & Partial<Pick<DirectoryAccount, 'corpId' | 'openId'>>): string {
  const params = new URLSearchParams()
  params.set('userId', userId)
  params.set('source', 'directory-sync')
  params.set('integrationId', account.integrationId)
  params.set('accountId', account.id)
  if (shouldWarnMissingOpenIdForGrant(account)) {
    params.set('filter', 'dingtalk-openid-missing')
  }
  return `/admin/users?${params.toString()}`
}

async function handleReviewUnbind(item: DirectoryReviewItem) {
  reviewProcessingAccountId.value = item.account.id
  try {
    await unbindAccount(item.account, {
      disableDingTalkGrant: reviewDisableDingTalkGrant.value,
      successMessage: `待处理成员 ${item.account.name} 已完成停权处理`,
    })
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function postReviewBindings(bindings: Array<{
  accountId: string
  localUserRef: string
  enableDingTalkGrant: boolean
}>, failureMessage = '绑定目录成员失败'): Promise<number> {
  if (!selectedIntegration.value || bindings.length === 0) return 0
  const response = await apiFetch('/api/admin/directory/accounts/batch-bind', {
    method: 'POST',
    body: JSON.stringify({ bindings }),
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, failureMessage))
  const processedItems = Array.isArray(body?.data?.items) ? body.data.items : []
  return processedItems.length > 0 ? processedItems.length : bindings.length
}

async function refreshAfterReviewBindings(): Promise<void> {
  if (!selectedIntegration.value) return
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
  await Promise.all([
    loadIntegrations(),
    loadReviewItems(selectedIntegration.value.id),
    loadAccounts(selectedIntegration.value.id),
  ])
}

async function submitReviewBindings(bindings: Array<{
  accountId: string
  localUserRef: string
  enableDingTalkGrant: boolean
}>, successMessage: string, failureMessage: string, progressKind?: ReviewBatchProgressKind) {
  if (!selectedIntegration.value || bindings.length === 0) return
  reviewBatchProcessing.value = true
  let appliedCount = 0
  try {
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'submitting',
        total: bindings.length,
        applied: 0,
        message: `正在提交${readReviewBatchProgressKindLabel(progressKind)}请求...`,
      })
    }
    appliedCount = await postReviewBindings(bindings, failureMessage)
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'refreshing',
        total: bindings.length,
        applied: appliedCount,
        message: `已提交 ${appliedCount} / ${bindings.length}，正在刷新目录成员与待处理队列...`,
      })
    }
    await refreshAfterReviewBindings()
    setStatus(successMessage)
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'completed',
        total: bindings.length,
        applied: appliedCount,
        message: successMessage,
      })
    }
  } catch (error) {
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'failed',
        total: bindings.length,
        applied: appliedCount,
        message: error instanceof Error ? error.message : failureMessage,
      })
    }
    setStatus(error instanceof Error ? error.message : failureMessage, 'error')
  } finally {
    reviewBatchProcessing.value = false
  }
}

async function handleReviewBind(item: DirectoryReviewItem) {
  reviewProcessingAccountId.value = item.account.id
  try {
    await submitReviewBindings([{
      accountId: item.account.id,
      localUserRef: readBindingDraft(item.account).trim(),
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }], `待处理成员 ${item.account.name} 已完成快速绑定`, '快速绑定失败')
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function backfillUserMobileAndBindReviewItem(item: DirectoryReviewItem) {
  const selectedUser = readSelectedBindingUser(item)
  const mobile = item.account.mobile?.trim()
  if (!selectedUser || !mobile) return
  if (hasSelectedBindingUserMobileConflict(item) && !isAwaitingMobileOverrideConfirmation(item.account.id)) {
    mobileOverrideConfirmations[item.account.id] = true
    setStatus(`待处理成员 ${item.account.name} 的平台手机号与目录手机号不一致，请再次确认后覆盖并绑定`, 'error')
    return
  }

  reviewProcessingAccountId.value = item.account.id
  try {
    delete mobileConflictHints[item.account.id]
    const profileResponse = await apiFetch(`/api/admin/users/${encodeURIComponent(selectedUser.id)}/profile`, {
      method: 'PATCH',
      body: JSON.stringify({
        mobile,
        expectedMobile: selectedUser.mobile ?? null,
      }),
    })
    const profileBody = await readJson(profileResponse)
    if (!profileResponse.ok) {
      if (readApiErrorCode(profileBody) === 'PROFILE_MOBILE_CONFLICT') {
        delete mobileOverrideConfirmations[item.account.id]
        delete selectedBindingUsers[item.account.id]
        await Promise.all([
          refreshSingleReviewItem(item.account.id),
          refreshSingleAccount(item.account.id),
        ])
        const refreshedItem = reviewItems.value.find((entry) => entry.account.id === item.account.id)
        const refreshedUser = refreshedItem ? readSelectedBindingUser(refreshedItem) : null
        mobileConflictHints[item.account.id] = refreshedUser?.mobile
          ? `待处理成员 ${item.account.name} 的平台手机号已更新为 ${refreshedUser.mobile}，请按最新差异重新确认。`
          : `待处理成员 ${item.account.name} 的平台手机号已被其他操作更新，请按最新差异重新确认。`
        setStatus(`待处理成员 ${item.account.name} 的平台手机号已被其他操作更新，请刷新后的最新差异为准`, 'error')
        return
      }
      throw new Error(readApiError(profileBody, '回填用户手机号失败'))
    }

    selectedBindingUsers[item.account.id] = {
      ...selectedUser,
      mobile,
    }
    delete mobileOverrideConfirmations[item.account.id]

    await submitReviewBindings([{
      accountId: item.account.id,
      localUserRef: selectedUser.id,
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }], `待处理成员 ${item.account.name} 已回填手机号并完成绑定`, '回填手机号并绑定失败')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '回填手机号并绑定失败', 'error')
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function createAndBindDirectoryAccountUser(account: DirectoryAccount, context: 'review' | 'account') {
  const memberLabel = context === 'review' ? '待处理成员' : '目录成员'
  const draft = readManualAdmissionDraft(account)
  const nextDraft: ManualAdmissionDraft = {
    name: draft.name.trim(),
    email: draft.email.trim(),
    username: draft.username.trim(),
    mobile: draft.mobile.trim(),
  }
  manualAdmissionDrafts[account.id] = nextDraft
  if (!nextDraft.name || (!nextDraft.email && !nextDraft.username && !nextDraft.mobile)) {
    setStatus(`${memberLabel} ${account.name} 的姓名必填，且邮箱、用户名、手机号至少填写一项`, 'error')
    return
  }

  if (context === 'review') reviewProcessingAccountId.value = account.id
  else bindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(account.id)}/admit-user`, {
      method: 'POST',
      body: JSON.stringify({
        name: nextDraft.name,
        email: nextDraft.email || undefined,
        username: nextDraft.username || undefined,
        mobile: nextDraft.mobile || undefined,
        enableDingTalkGrant: readAccountGrantToggle(account),
      }),
    })
    const body = await readJson(response)
    if (!response.ok || body?.ok !== true) {
      throw new Error(readApiError(body, '创建本地用户并绑定失败'))
    }
    const data = body?.data as Record<string, unknown> | undefined
    const createdUser = readCreatedLocalUserOption(data ?? {}, nextDraft)
    const temporaryPassword = typeof data?.temporaryPassword === 'string' ? data.temporaryPassword : ''
    const onboarding = data?.onboarding && typeof data.onboarding === 'object'
      ? data.onboarding as OnboardingPacket
      : null

    updateBindingDraft(account.id, describeLocalUserIdentifier(createdUser))
    selectedBindingUsers[account.id] = createdUser
    clearBindingSearch(account.id)
    delete mobileOverrideConfirmations[account.id]
    delete mobileConflictHints[account.id]
    delete manualAdmissionExpanded[account.id]
    delete manualAdmissionDrafts[account.id]
    await refreshAfterReviewBindings()
    manualAdmissionResult.value = {
      accountId: account.id,
      accountName: account.name,
      integrationId: account.integrationId,
      userId: createdUser.id,
      userName: createdUser.name || nextDraft.name,
      email: createdUser.email || nextDraft.email || null,
      username: createdUser.username || nextDraft.username || null,
      mobile: createdUser.mobile || nextDraft.mobile,
      temporaryPassword,
      onboarding,
      bound: true,
      bindError: '',
      mobileBackfilled: nextDraft.mobile.length === 0 || (createdUser.mobile ?? '') === nextDraft.mobile,
      mobileBackfillError: '',
    }
    setStatus(`${memberLabel} ${account.name} 已创建本地用户并完成绑定`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建本地用户并绑定失败', 'error')
  } finally {
    if (context === 'review') reviewProcessingAccountId.value = ''
    else bindingAccountId.value = ''
  }
}

async function createAndBindReviewUser(item: DirectoryReviewItem) {
  await createAndBindDirectoryAccountUser(item.account, 'review')
}

async function createAndBindAccountUser(account: DirectoryAccount) {
  await createAndBindDirectoryAccountUser(account, 'account')
}

async function retryBackfillUserMobileAndBindReviewItem(item: DirectoryReviewItem) {
  clearMobileConflictHint(item.account.id)
  clearMobileOverrideConfirmation(item.account.id)
  await backfillUserMobileAndBindReviewItem(item)
}

async function batchBindReviewItems() {
  await submitReviewBindings(
    selectedReviewBindEntries.value.map((item) => ({
      accountId: item.accountId,
      localUserRef: item.localUserRef,
      enableDingTalkGrant: item.enableDingTalkGrant,
    })),
    `已完成 ${selectedReviewBindEntries.value.length} 个目录成员的批量绑定`,
    '批量绑定失败',
    'bind',
  )
}

async function confirmRecommendedReviewBinding(item: DirectoryReviewItem) {
  if (item.recommendations.length === 0) return
  reviewProcessingAccountId.value = item.account.id
  try {
    const recommendation = item.recommendations[0]
    await submitReviewBindings([{
      accountId: item.account.id,
      localUserRef: recommendation.localUser.id,
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }], `待处理成员 ${item.account.name} 已确认推荐绑定`, '确认推荐绑定失败')
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function batchConfirmRecommendedReviewItems() {
  await submitReviewBindings(
    selectedRecommendedReviewBindEntries.value.map((item) => ({
      accountId: item.accountId,
      localUserRef: item.localUserRef,
      enableDingTalkGrant: item.enableDingTalkGrant,
    })),
    `已完成 ${selectedRecommendedReviewBindEntries.value.length} 个目录成员的推荐绑定确认`,
    '批量确认推荐绑定失败',
    'recommend',
  )
}

async function batchUnbindReviewItems() {
  if (!selectedIntegration.value || selectedReviewBatchIds.value.length === 0) return
  reviewBatchProcessing.value = true
  let appliedCount = 0
  try {
    const batchIds = [...selectedReviewBatchIds.value]
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'submitting',
      total: batchIds.length,
      applied: 0,
      message: '正在提交批量停权处理请求...',
    })
    const response = await apiFetch('/api/admin/directory/accounts/batch-unbind', {
      method: 'POST',
      body: JSON.stringify({
        accountIds: batchIds,
        disableDingTalkGrant: reviewDisableDingTalkGrant.value,
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '批量停权处理失败'))
    const processedItems = Array.isArray(body?.data?.items) ? body.data.items : []
    appliedCount = processedItems.length > 0 ? processedItems.length : batchIds.length
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'refreshing',
      total: batchIds.length,
      applied: appliedCount,
      message: `已提交 ${appliedCount} / ${batchIds.length}，正在刷新目录成员与待处理队列...`,
    })
    for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
    setStatus(`已完成 ${batchIds.length} 个目录成员的批量停权处理`)
    await Promise.all([
      loadIntegrations(),
      loadReviewItems(selectedIntegration.value.id),
      loadAccounts(selectedIntegration.value.id),
    ])
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'completed',
      total: batchIds.length,
      applied: appliedCount,
      message: `已完成 ${batchIds.length} 个目录成员的批量停权处理`,
    })
  } catch (error) {
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'failed',
      total: selectedReviewBatchIds.value.length,
      applied: appliedCount,
      message: error instanceof Error ? error.message : '批量停权处理失败',
    })
    setStatus(error instanceof Error ? error.message : '批量停权处理失败', 'error')
  } finally {
    reviewBatchProcessing.value = false
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

function readObservationStatusLabel(status: DirectoryObservationStatus | null | undefined): string {
  if (status === 'auto_observed' || status === 'scheduler_observed') return '已观察到自动触发'
  if (status === 'configured_no_runs' || status === 'awaiting_first_run') return '等待首次自动触发'
  if (status === 'manual_only') return '仅观察到手动执行'
  if (status === 'missing_cron') return '缺少 cron'
  if (status === 'invalid_cron') return 'cron 无效'
  if (status === 'disabled') return '自动同步未启用'
  return '状态未知'
}

function readObservationStatusClass(status: DirectoryObservationStatus | null | undefined): string {
  if (status === 'auto_observed' || status === 'scheduler_observed') return 'directory-admin__chip--success'
  if (status === 'manual_only' || status === 'configured_no_runs' || status === 'awaiting_first_run' || status === 'missing_cron' || status === 'disabled') {
    return 'directory-admin__chip--warning'
  }
  if (status === 'invalid_cron') return 'directory-admin__chip--danger'
  return ''
}

function readTriggerSourceLabel(triggerSource: string | null | undefined): string {
  if (!triggerSource) return '未记录'
  if (triggerSource === 'scheduler') return '自动调度'
  if (triggerSource === 'manual') return '手动触发'
  return triggerSource
}

function readAlertLevelLabel(level: DirectorySyncAlert['level']): string {
  if (level === 'info') return '信息'
  if (level === 'warning') return '警告'
  return '错误'
}

function readAlertLevelClass(level: DirectorySyncAlert['level']): string {
  if (level === 'info') return 'directory-admin__chip--success'
  if (level === 'warning') return 'directory-admin__chip--warning'
  return 'directory-admin__chip--danger'
}

function readReviewKindLabel(kind: DirectoryReviewItem['kind']): string {
  if (kind === 'pending_binding') return '待绑定'
  if (kind === 'inactive_linked') return '停用待停权'
  if (kind === 'missing_identifier') return '缺身份标识'
  return '待处理'
}

function readReviewKindClass(kind: DirectoryReviewItem['kind']): string {
  if (kind === 'pending_binding') return 'directory-admin__chip--warning'
  if (kind === 'inactive_linked') return 'directory-admin__chip--danger'
  if (kind === 'missing_identifier') return 'directory-admin__chip--warning'
  return ''
}

function readNumericStat(stats: Record<string, unknown>, key: string): number {
  const value = stats[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) return Number(value)
  return 0
}

function readStringStat(stats: Record<string, unknown>, key: string): string {
  const value = stats[key]
  return typeof value === 'string' ? value : ''
}

function readStringArrayStat(stats: Record<string, unknown>, key: string): string[] {
  const value = stats[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function formatSampleUsers(users: Array<{ userId: string; name: string }>, hasMore: boolean): string {
  const summary = users.map((user) => `${user.name} (${user.userId})`).join('，')
  if (!summary) return '无'
  return hasMore ? `${summary} 等` : summary
}

const stopDirectoryLocationSync = subscribeToLocationChanges(() => {
  if (!syncDirectoryNavigationFromLocation()) return
  void handleDirectoryNavigationChange()
})

onMounted(() => {
  void loadIntegrations()
})

onUnmounted(() => {
  stopDirectoryLocationSync()
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

.directory-admin__field--wide {
  grid-column: 1 / -1;
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

.directory-admin__textarea {
  min-height: 96px;
  resize: vertical;
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

.directory-admin__button--active {
  border-color: #1d4ed8;
  background: #dbeafe;
  color: #1e3a8a;
}

.directory-admin__link-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: #1d4ed8;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
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

.directory-admin__chip--success {
  background: #dcfce7;
  color: #166534;
}

.directory-admin__chip--warning {
  background: #fef3c7;
  color: #92400e;
}

.directory-admin__chip--danger {
  background: #fee2e2;
  color: #991b1b;
}

.directory-admin__badge--inactive {
  background: #fef3c7;
  color: #92400e;
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

.directory-admin__route-banner {
  border: 1px solid #fca5a5;
  border-radius: 14px;
  padding: 14px;
  background: linear-gradient(180deg, #fff1f2 0%, #fff7ed 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__focus-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid #99f6e4;
  border-radius: 14px;
  background: linear-gradient(180deg, #f0fdfa 0%, #ecfeff 100%);
}

.directory-admin__focus-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.directory-admin__run {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px;
  background: #f8fafc;
}

.directory-admin__schedule-card,
.directory-admin__alert,
.directory-admin__review-item,
.directory-admin__progress-card {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px;
  background: #fff;
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

.directory-admin__review-head,
.directory-admin__review-title,
.directory-admin__review-select {
  display: flex;
  align-items: center;
  gap: 12px;
}

.directory-admin__review-head {
  justify-content: space-between;
  flex-wrap: wrap;
}

.directory-admin__review-title {
  align-items: flex-start;
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

.directory-admin__account--focused {
  border-color: #0f766e;
  box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.16);
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

.directory-admin__department-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__department-node {
  border: 1px solid #dbeafe;
  border-radius: 14px;
  padding: 12px 14px;
  background: linear-gradient(180deg, #f8fbff 0%, #eff6ff 100%);
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.directory-admin__department-node--inactive {
  border-color: #fde68a;
  background: linear-gradient(180deg, #fffbeb 0%, #fef3c7 100%);
}

.directory-admin__department-search {
  margin-top: 4px;
}

.directory-admin__department-scope-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.directory-admin__department-filter-reset {
  margin-top: -4px;
}

.directory-admin__visible-department-actions {
  border: 1px solid #bfdbfe;
  border-radius: 14px;
  padding: 10px 12px;
  background: #eff6ff;
}

.directory-admin__mirror-observation {
  border: 1px solid #bbf7d0;
  border-radius: 14px;
  padding: 12px 14px;
  background: #f0fdf4;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.directory-admin__mirror-observation--warning {
  border-color: #fde68a;
  background: #fffbeb;
}

.directory-admin__manual-department {
  border: 1px dashed #93c5fd;
  border-radius: 14px;
  padding: 12px 14px;
  background: #f8fbff;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.directory-admin__manual-department-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.directory-admin__department-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex-basis: 100%;
}

.directory-admin__reference-issues {
  border: 1px solid #fecaca;
  border-radius: 14px;
  padding: 12px 14px;
  background: #fef2f2;
}

.directory-admin__draft-scope-changes {
  border: 1px solid #bfdbfe;
  border-radius: 14px;
  padding: 12px 14px;
  background: #eff6ff;
}

.directory-admin__reference-issues--ok {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.directory-admin__draft-scope-changes ul,
.directory-admin__reference-issues ul {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-admin__draft-scope-changes li,
.directory-admin__reference-issues li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.directory-admin__reference-actions {
  margin-top: 8px;
}

.directory-admin__review-admission {
  border: 1px dashed #cbd5e1;
  border-radius: 14px;
  padding: 12px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 12px;
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

.directory-admin__invite {
  margin: 0;
  padding: 12px;
  border-radius: 12px;
  background: #0f172a;
  color: #e2e8f0;
  white-space: pre-wrap;
  word-break: break-word;
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

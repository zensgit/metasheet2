<template>
  <section class="user-admin">
    <header class="user-admin__header">
      <div>
        <h1>用户管理</h1>
        <p>平台管理员可在此查看用户访问状态并分配角色。</p>
      </div>

      <div class="user-admin__actions">
        <router-link class="user-admin__link" to="/admin/roles">角色管理</router-link>
        <router-link class="user-admin__link" to="/admin/permissions">权限管理</router-link>
        <router-link class="user-admin__link" to="/admin/directory">目录同步</router-link>
        <router-link class="user-admin__link" to="/admin/audit">管理审计</router-link>
        <input
          v-model.trim="search"
          class="user-admin__search"
          type="search"
          placeholder="搜索邮箱、用户名、手机号、姓名或用户 ID"
          @keyup.enter="void loadUsers()"
        />
        <button class="user-admin__button" type="button" :disabled="loading" @click="void loadUsers()">
          {{ loading ? '加载中...' : '查询' }}
        </button>
      </div>
    </header>

    <p v-if="!adminAllowed" class="user-admin__warning">
      当前账号不是平台管理员。页面可见，但后端接口会拒绝非管理员操作。
    </p>
    <p v-if="status" class="user-admin__status" :class="{ 'user-admin__status--error': statusTone === 'error' }">
      {{ status }}
    </p>
    <section
      v-if="hasDirectorySyncNavigation"
      class="user-admin__status user-admin__source-banner"
      :class="{ 'user-admin__status--error': userNavigation.directoryFailure }"
    >
      <strong>{{ userNavigation.directoryFailure ? '目录定位未完成' : '目录同步回跳' }}</strong>
      <p>{{ directoryNavigationNotice }}</p>
      <p v-if="directoryNavigationTargetLabel">{{ directoryNavigationTargetLabel }}</p>
      <div v-if="directoryReturnLocation" class="user-admin__source-actions">
        <router-link class="user-admin__button user-admin__button--secondary user-admin__button-link" :to="directoryReturnLocation">
          返回目录同步
        </router-link>
        <button class="user-admin__button user-admin__button--secondary" type="button" @click="void copyDirectoryReturnLocation()">
          复制目录链接
        </button>
        <button class="user-admin__button user-admin__button--secondary" type="button" @click="void copyCurrentUserManagementLocation()">
          复制用户链接
        </button>
        <button class="user-admin__button user-admin__button--secondary" type="button" @click="clearDirectoryNavigationContext()">
          清除目录回跳
        </button>
      </div>
    </section>
    <section class="user-admin__panel user-admin__panel--create">
      <div class="user-admin__section-head">
        <div>
          <h2>创建用户</h2>
          <p class="user-admin__hint">可选择自动生成临时密码，后续再在权限页补充直接权限。密码需至少 8 位，包含大小写字母和数字。</p>
        </div>
      </div>
      <div class="user-admin__create-grid">
        <input v-model.trim="createForm.name" class="user-admin__search" type="text" placeholder="姓名" />
        <input v-model.trim="createForm.email" class="user-admin__search" type="email" placeholder="邮箱（可选）" />
        <input v-model.trim="createForm.username" class="user-admin__search" type="text" placeholder="用户名（可选）" />
        <input v-model.trim="createForm.mobile" class="user-admin__search" type="text" placeholder="手机号（可选）" />
        <input v-model.trim="createForm.password" class="user-admin__search" type="text" placeholder="可选：初始密码" />
        <select v-model="presetModeFilter" class="user-admin__select">
          <option value="">预设模式（全部）</option>
          <option value="platform">platform</option>
          <option value="attendance">attendance</option>
          <option value="plm-workbench">plm-workbench</option>
        </select>
        <select v-model="createForm.presetId" class="user-admin__select">
          <option value="">选择访问预设（可选）</option>
          <option v-for="preset in filteredAccessPresets" :key="preset.id" :value="preset.id">
            {{ preset.name }} · {{ preset.productMode }}
          </option>
        </select>
        <input v-model.trim="createForm.role" class="user-admin__search" type="text" placeholder="显示角色，默认 user" />
        <select v-model="createForm.roleId" class="user-admin__select">
          <option value="">初始 RBAC 角色（可选）</option>
          <option v-for="role in roleCatalog" :key="role.id" :value="role.id">
            {{ role.name }} ({{ role.id }})
          </option>
        </select>
        <label class="user-admin__toggle">
          <input v-model="createForm.isActive" type="checkbox" />
          <span>创建后立即启用</span>
        </label>
      </div>
      <div class="user-admin__role-actions">
        <button class="user-admin__button" type="button" :disabled="busy" @click="void createUser()">
          创建用户
        </button>
        <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="!createdInviteMessage" @click="void copyInviteMessage()">
          复制邀请文案
        </button>
      </div>
      <p v-if="createdTemporaryPassword" class="user-admin__status">
        新用户临时密码：{{ createdTemporaryPassword }}
      </p>
      <div v-if="selectedPreset" class="user-admin__preset">
        <strong>{{ selectedPreset.name }}</strong>
        <p>{{ selectedPreset.description }}</p>
        <small>推荐入口：{{ selectedPreset.homePath }} · 权限：{{ selectedPreset.permissions.join(', ') }}</small>
      </div>
      <p v-if="createdOnboarding?.acceptInviteUrl" class="user-admin__hint">
        首次设置密码链接：
        <a :href="createdOnboarding.acceptInviteUrl" target="_blank" rel="noreferrer">{{ createdOnboarding.acceptInviteUrl }}</a>
      </p>
      <pre v-if="createdInviteMessage" class="user-admin__invite">{{ createdInviteMessage }}</pre>
    </section>

    <section class="user-admin__panel">
      <div class="user-admin__section-head">
        <div>
          <h2>邀请记录</h2>
          <p class="user-admin__hint">展示最近发出的邀请及其当前状态。</p>
        </div>
        <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingInvites" @click="void loadInviteRecords(selectedUserId || undefined)">
          {{ loadingInvites ? '刷新中...' : '刷新邀请记录' }}
        </button>
      </div>
      <div v-if="inviteRecords.length === 0" class="user-admin__empty">暂无邀请记录</div>
      <div v-else class="user-admin__role-list">
        <article v-for="record in inviteRecords" :key="record.id" class="user-admin__role-card">
          <strong>{{ record.userName || record.email }}</strong>
          <span>{{ record.email }}</span>
          <small>{{ record.productMode }} · {{ record.status }} · 创建于 {{ formatDate(record.createdAt) }}</small>
          <p>最近发送：{{ formatDate(record.lastSentAt) }}</p>
          <p v-if="record.acceptedAt">接受时间：{{ formatDate(record.acceptedAt) }}</p>
          <a :href="buildInviteUrl(record.inviteToken)" target="_blank" rel="noreferrer">打开邀请链接</a>
          <button
            v-if="record.status !== 'accepted'"
            class="user-admin__button user-admin__button--secondary"
            type="button"
            :disabled="busy || loadingInvites"
            @click="void resendInvite(record)"
          >
            重发邀请
          </button>
          <button
            v-if="record.status === 'pending'"
            class="user-admin__button user-admin__button--secondary"
            type="button"
            :disabled="busy || loadingInvites"
            @click="void revokeInvite(record)"
          >
            撤销邀请
          </button>
        </article>
      </div>
    </section>

    <div class="user-admin__layout">
      <aside class="user-admin__panel">
        <div class="user-admin__section-head">
          <div>
            <h2>用户列表</h2>
            <p class="user-admin__hint">按账号、钉钉和目录状态快速筛选，再执行批量治理动作。</p>
          </div>
        </div>
        <div class="user-admin__summary">
          <span class="user-admin__metric">
            <strong>{{ governanceSummary.total }}</strong>
            <small>总用户</small>
          </span>
          <span class="user-admin__metric">
            <strong>{{ governanceSummary.accountEnabled }}</strong>
            <small>账号启用</small>
          </span>
          <span class="user-admin__metric">
            <strong>{{ governanceSummary.dingtalkEnabled }}</strong>
            <small>钉钉启用</small>
          </span>
          <span class="user-admin__metric">
            <strong>{{ governanceSummary.directoryLinked }}</strong>
            <small>目录已链接</small>
          </span>
          <router-link class="user-admin__metric user-admin__metric-link" :to="buildMissingOpenIdUserManagementLocation()">
            <strong>{{ governanceSummary.dingtalkOpenIdMissing }}</strong>
            <small>缺 OpenID</small>
          </router-link>
          <router-link class="user-admin__metric user-admin__metric-link" :to="buildRecentDingTalkGovernanceAuditLocation()">
            <strong>{{ governanceSummary.dingtalkOpenIdGoverned }}</strong>
            <small>已收口</small>
          </router-link>
          <router-link class="user-admin__metric user-admin__metric-link" :to="buildDingTalkGovernanceAuditLocation()">
            <strong>{{ governanceSummary.dingtalkOpenIdPending }}</strong>
            <small>待收口</small>
          </router-link>
        </div>
        <div class="user-admin__section-head user-admin__section-head--workbench">
          <div>
            <h3>治理工作台</h3>
            <p class="user-admin__hint">把筛查、目录修复和审计复盘入口放到同一个工作台，便于值班和日常收口。</p>
          </div>
          <div class="user-admin__role-actions">
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceDailySummary()">
              导出治理日报摘要
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceLiveValidationChecklist()">
              导出联调检查单
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceValidationResultTemplate()">
              导出联调结果模板
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceExecutionPackageIndex()">
              导出联调执行包索引
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceFullValidationPackage()">
              导出完整联调包
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceDeliveryChecklist()">
              导出交付清单
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernance142AcceptanceChecklist()">
              导出 142 联调验收清单
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceTrialRunbook()">
              导出试运行值班说明
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceDeliveryDecision()">
              导出正式交付结论
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceDeliveryArchiveIndex()">
              导出交付归档包索引
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceCloseoutChecklist()">
              导出收尾检查单
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceStakeholderUpdateTemplate()">
              导出对外同步模板
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceLaunchObservationTemplate()">
              导出上线观察记录模板
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceManualAcceptanceScript()">
              导出真人侧验收执行单
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernance142AcceptancePackage()">
              导出 142 验收执行包
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceFinalHandoffPackage()">
              导出最终交付包
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceAcceptanceResultSummaryTemplate()">
              导出验收结果汇总模板
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceAcceptanceReadinessSnapshot()">
              导出当前验收就绪快照
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" @click="exportGovernanceEnvironmentBlockerTemplate()">
              导出环境阻塞记录模板
            </button>
          </div>
        </div>
        <div class="user-admin__workbench">
          <router-link
            v-for="card in governanceWorkbenchCards"
            :key="card.title"
            class="user-admin__workbench-card"
            :to="card.to"
          >
            <span class="user-admin__workbench-kicker">{{ card.kicker }}</span>
            <strong>{{ card.title }}</strong>
            <small>{{ card.description }}</small>
            <span class="user-admin__workbench-note">{{ card.note }}</span>
          </router-link>
        </div>
        <div class="user-admin__filters" role="group" aria-label="成员治理筛选">
          <button
            v-for="option in userFilterOptions"
            :key="option.value"
            class="user-admin__filter"
            :class="{ 'user-admin__filter--active': userListFilter === option.value }"
            type="button"
            @click="userListFilter = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <div v-if="visibleUsers.length > 0" class="user-admin__bulkbar">
          <div>
            <strong>批量操作</strong>
            <p class="user-admin__hint">
              已选择 {{ selectedUserIds.length }} / {{ visibleUsers.length }} 个当前筛选结果。
            </p>
            <p v-if="screeningUsersMissingOpenId.length > 0" class="user-admin__hint">
              当前筛选结果中有 {{ screeningUsersMissingOpenId.length }} 个缺 OpenID 用户，可直接导出治理清单。
            </p>
            <p v-if="screeningUsersMissingOpenIdWithGrant.length > 0" class="user-admin__hint">
              其中 {{ screeningUsersMissingOpenIdWithGrant.length }} 个仍开通钉钉扫码，可直接批量关闭以降低误用风险。
            </p>
          </div>
          <div class="user-admin__bulk-group">
            <select
              v-model="selectedNamespace"
              class="user-admin__select user-admin__select--namespace"
              aria-label="插件命名空间"
            >
              <option value="">选择插件命名空间</option>
              <option v-for="namespace in namespaceOptions" :key="namespace" :value="namespace">
                {{ namespace }}
              </option>
            </select>
            <p class="user-admin__hint">
              命名空间优先来自当前成员准入，再合并角色目录可推导的插件范围。
            </p>
          </div>
          <div class="user-admin__role-actions">
            <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loading || bulkBusy || visibleUsers.length === 0" @click="void selectVisibleUsers()">
              选择当前筛选结果
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loading || bulkBusy || selectedUserIds.length === 0" @click="void clearSelectedUsers()">
              清空选择
            </button>
            <button class="user-admin__button" type="button" :disabled="loading || bulkBusy || selectedUserIds.length === 0 || !selectedNamespace" @click="void bulkUpdateNamespaceAdmissions(true)">
              批量开通插件使用
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loading || bulkBusy || selectedUserIds.length === 0 || !selectedNamespace" @click="void bulkUpdateNamespaceAdmissions(false)">
              批量关闭插件使用
            </button>
            <button class="user-admin__button" type="button" :disabled="loading || bulkBusy || selectedUserIds.length === 0" @click="void bulkUpdateDingTalkGrants(true)">
              批量开通钉钉扫码
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loading || bulkBusy || selectedUserIds.length === 0" @click="void bulkUpdateDingTalkGrants(false)">
              批量关闭钉钉扫码
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="screeningUsersMissingOpenIdWithGrant.length === 0" @click="void bulkDisableMissingOpenIdDingTalkGrants()">
              批量关闭缺 OpenID 钉钉扫码
            </button>
            <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="screeningUsersMissingOpenId.length === 0" @click="exportMissingOpenIdCsv()">
              导出缺 OpenID 清单
            </button>
            <router-link class="user-admin__button user-admin__button--secondary" :to="buildDingTalkGovernanceAuditLocation()">
              查看钉钉治理审计
            </router-link>
          </div>
        </div>
        <div v-if="visibleUsers.length === 0" class="user-admin__empty">暂无用户数据</div>
        <article
          v-for="user in visibleUsers"
          :key="user.id"
          class="user-admin__user"
          :class="{ 'user-admin__user--active': selectedUserId === user.id }"
        >
          <label class="user-admin__user-select">
            <input
              :checked="selectedUserIdSet.has(user.id)"
              type="checkbox"
              @change="void handleUserSelectionChange(user.id, $event)"
            />
            <span>选择</span>
          </label>
          <button class="user-admin__user-body" type="button" @click="void selectUser(user.id)">
            <strong>{{ user.name || formatManagedUserLabel(user) }}</strong>
            <span>{{ formatManagedUserIdentifier(user) }}</span>
            <span class="user-admin__meta">{{ user.role }} · {{ user.is_active ? '启用' : '停用' }}</span>
            <div class="user-admin__row-badges">
              <span class="user-admin__row-badge" :class="{ 'user-admin__row-badge--success': user.is_active, 'user-admin__row-badge--danger': !user.is_active }">
                {{ user.is_active ? '账号启用' : '账号停用' }}
              </span>
              <span class="user-admin__row-badge" :class="{ 'user-admin__row-badge--success': user.dingtalkLoginEnabled !== false, 'user-admin__row-badge--danger': user.dingtalkLoginEnabled === false }">
                {{ user.dingtalkLoginEnabled === false ? '钉钉停用' : '钉钉启用' }}
              </span>
              <span class="user-admin__row-badge" :class="{ 'user-admin__row-badge--success': user.directoryLinked === true, 'user-admin__row-badge--danger': user.directoryLinked !== true }">
                {{ user.directoryLinked === true ? '目录已链接' : '目录未链接' }}
              </span>
              <span v-if="user.dingtalkOpenIdMissing" class="user-admin__row-badge user-admin__row-badge--danger">
                缺 OpenID
              </span>
              <span v-if="user.platformAdminEnabled" class="user-admin__row-badge user-admin__row-badge--accent">
                平台管理员
              </span>
              <span v-if="user.attendanceAdminEnabled" class="user-admin__row-badge user-admin__row-badge--accent">
                考勤管理员
              </span>
              <span v-if="(user.businessRoleCount || 0) > 0" class="user-admin__row-badge user-admin__row-badge--muted">
                业务角色 {{ user.businessRoleCount }}
              </span>
            </div>
          </button>
          <p v-if="user.dingtalkOpenIdMissing" class="user-admin__hint">
            {{ readMissingOpenIdGovernanceHint(user) }}
          </p>
        </article>
      </aside>

      <section class="user-admin__panel user-admin__panel--detail">
        <template v-if="access">
          <div class="user-admin__detail-head">
            <div>
              <h2>{{ access.user.name || formatManagedUserLabel(access.user) }}</h2>
              <p>{{ formatManagedUserIdentifier(access.user) }}</p>
              <p v-if="access.user.mobile" class="user-admin__hint">手机号：{{ access.user.mobile }}</p>
            </div>
            <div class="user-admin__badges">
              <span class="user-admin__badge">{{ access.user.role }}</span>
              <span class="user-admin__badge" :class="{ 'user-admin__badge--inactive': !access.user.is_active }">
                {{ access.user.is_active ? '已启用' : '已停用' }}
              </span>
              <span class="user-admin__badge" :class="{ 'user-admin__badge--admin': access.isAdmin }">
                {{ access.isAdmin ? '管理员' : '普通用户' }}
              </span>
            </div>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>基础资料</h3>
                <p class="user-admin__hint">管理员可直接维护姓名和手机号，用于目录推荐绑定与钉钉匹配。</p>
              </div>
            </div>
            <div class="user-admin__create-grid">
              <input
                v-model.trim="profileDraftName"
                class="user-admin__search"
                type="text"
                placeholder="姓名"
              />
              <input
                v-model.trim="profileDraftMobile"
                class="user-admin__search"
                type="text"
                placeholder="手机号，可留空"
              />
            </div>
            <div class="user-admin__role-actions">
              <button class="user-admin__button" type="button" :disabled="busy || !hasProfileDraftChanges" @click="void saveUserProfile()">
                保存资料
              </button>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>角色</h3>
            <div class="user-admin__chips">
              <span v-for="role in access.roles" :key="role" class="user-admin__chip">
                {{ role }}
              </span>
              <span v-if="access.roles.length === 0" class="user-admin__empty">未分配角色</span>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>权限</h3>
            <div class="user-admin__chips">
              <span v-for="permission in access.permissions" :key="permission" class="user-admin__chip user-admin__chip--permission">
                {{ permission }}
              </span>
              <span v-if="access.permissions.length === 0" class="user-admin__empty">未授予额外权限</span>
            </div>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>成员准入</h3>
                <p class="user-admin__hint">平台管理员负责账号启用和钉钉登录开通，业务系统角色决定成员能使用哪些插件系统。</p>
              </div>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingAdmission || !access" @click="void loadMemberAdmission(access.user.id)">
                {{ loadingAdmission ? '刷新中...' : '刷新准入状态' }}
              </button>
            </div>
            <div v-if="memberAdmission" class="user-admin__chips">
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': memberAdmission.accountEnabled, 'user-admin__chip--danger': !memberAdmission.accountEnabled }">
                {{ memberAdmission.accountEnabled ? '平台账号已启用' : '平台账号未启用' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': memberAdmission.dingtalk.grant.enabled, 'user-admin__chip--danger': !memberAdmission.dingtalk.grant.enabled }">
                {{ memberAdmission.dingtalk.grant.enabled ? '已开通钉钉登录' : '未开通钉钉登录' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': memberAdmission.directoryMemberships.length > 0 }">
                {{ memberAdmission.directoryMemberships.length > 0 ? `目录已链接 ${memberAdmission.directoryMemberships.length}` : '未关联目录成员' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': memberAdmission.businessRoleIds.length > 0 }">
                {{ memberAdmission.businessRoleIds.length > 0 ? `业务系统角色 ${memberAdmission.businessRoleIds.length}` : '未分配业务系统角色' }}
              </span>
            </div>
            <div v-if="memberAdmission?.directoryMemberships.length" class="user-admin__role-list">
              <article v-for="membership in memberAdmission.directoryMemberships" :key="membership.directoryAccountId" class="user-admin__role-card">
                <strong>{{ membership.integrationName }} · {{ membership.name }}</strong>
                <span>{{ membership.provider }} · {{ membership.linkStatus }} · {{ membership.matchStrategy || 'manual' }}</span>
                <small>{{ membership.email || membership.mobile || membership.externalUserId }}</small>
                <p v-if="membership.departmentPaths.length">部门：{{ membership.departmentPaths.join(' / ') }}</p>
                <p>目录账号：{{ membership.accountEnabled ? '启用' : '停用' }} · 同步于 {{ formatDate(membership.accountUpdatedAt) }}</p>
              </article>
            </div>
            <div v-if="memberAdmission?.businessRoleIds.length" class="user-admin__chips">
              <span v-for="roleId in memberAdmission.businessRoleIds" :key="roleId" class="user-admin__chip">
                {{ roleId }}
              </span>
            </div>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>插件使用</h3>
                <p class="user-admin__hint">这里控制成员是否可进入具体插件命名空间。钉钉登录只决定能否扫码进入平台，不等于插件权限。</p>
              </div>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingAdmission || !access" @click="void loadMemberAdmission(access.user.id)">
                {{ loadingAdmission ? '刷新中...' : '刷新插件准入' }}
              </button>
            </div>
            <div v-if="memberAdmission?.namespaceAdmissions?.length" class="user-admin__role-list">
              <article v-for="admission in memberAdmission.namespaceAdmissions || []" :key="admission.namespace" class="user-admin__role-card user-admin__role-card--namespace">
                <strong>{{ admission.namespace }}</strong>
                <span v-if="admission.updatedAt">更新时间：{{ formatDate(admission.updatedAt) }}</span>
                <div class="user-admin__chips">
                  <span class="user-admin__chip" :class="{ 'user-admin__chip--success': admission.hasRole, 'user-admin__chip--danger': !admission.hasRole }">
                    {{ admission.hasRole ? '已分配角色' : '未分配角色' }}
                  </span>
                  <span class="user-admin__chip" :class="{ 'user-admin__chip--success': admission.enabled, 'user-admin__chip--danger': !admission.enabled }">
                    {{ admission.enabled ? '插件使用已开通' : '插件使用未开通' }}
                  </span>
                  <span class="user-admin__chip" :class="{ 'user-admin__chip--success': admission.effective, 'user-admin__chip--danger': !admission.effective }">
                    {{ admission.effective ? '当前实际可用' : '当前不可用' }}
                  </span>
                </div>
                <p>只有角色和开通状态同时满足时，成员才能使用对应插件。</p>
                <div class="user-admin__role-actions">
                  <button class="user-admin__button" type="button" :disabled="busy || admission.enabled" @click="void updateNamespaceAdmission(admission, true)">
                    开通插件使用
                  </button>
                  <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy || !admission.enabled" @click="void updateNamespaceAdmission(admission, false)">
                    关闭插件使用
                  </button>
                </div>
              </article>
            </div>
            <div v-else class="user-admin__empty">
              暂无插件使用准入信息
            </div>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>管理员能力</h3>
                <p class="user-admin__hint">考勤管理员和平台管理员分开控制，互不隐含。平台管理员变更后建议重新登录一次。</p>
              </div>
            </div>
            <div class="user-admin__chips">
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': hasPlatformAdminAccess, 'user-admin__chip--danger': !hasPlatformAdminAccess }">
                {{ hasPlatformAdminAccess ? '已开通平台管理员' : '未开通平台管理员' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': hasAttendanceAdminAccess, 'user-admin__chip--danger': !hasAttendanceAdminAccess }">
                {{ hasAttendanceAdminAccess ? '已开通考勤管理员' : '未开通考勤管理员' }}
              </span>
            </div>
            <div class="user-admin__role-actions">
              <button class="user-admin__button" type="button" :disabled="busy || hasPlatformAdminAccess" @click="void updateNamedRole('admin', true)">
                提升为平台管理员
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy || !hasPlatformAdminAccess" @click="void updateNamedRole('admin', false)">
                取消平台管理员
              </button>
              <button class="user-admin__button" type="button" :disabled="busy || hasAttendanceAdminAccess" @click="void updateNamedRole('attendance_admin', true)">
                开通考勤管理员
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy || !hasAttendanceAdminAccess" @click="void updateNamedRole('attendance_admin', false)">
                关闭考勤管理员
              </button>
            </div>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>钉钉扫码登录</h3>
                <p class="user-admin__hint">生产建议开启严格白名单，只允许已存在且已开通的用户扫码登录。</p>
              </div>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingDingTalk || !access" @click="void loadDingTalkAccess(access.user.id)">
                {{ loadingDingTalk ? '刷新中...' : '刷新钉钉状态' }}
              </button>
            </div>
            <div v-if="dingtalkAccess" class="user-admin__chips">
              <span class="user-admin__chip" :class="{ 'user-admin__chip--permission': dingtalkAccess.requireGrant }">
                {{ dingtalkAccess.requireGrant ? '严格白名单模式' : '宽松模式' }}
              </span>
              <span
                v-if="dingtalkAccess.server"
                class="user-admin__chip"
                :class="{ 'user-admin__chip--success': dingtalkAccess.server.available, 'user-admin__chip--danger': !dingtalkAccess.server.available }"
              >
                {{ dingtalkAccess.server.available ? '服务端已启用钉钉登录' : '服务端未启用钉钉登录' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': dingtalkAccess.grant.enabled, 'user-admin__chip--danger': !dingtalkAccess.grant.enabled }">
                {{ dingtalkAccess.grant.enabled ? '已开通钉钉扫码' : '未开通钉钉扫码' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': dingtalkAccess.identity.exists }">
                {{ dingtalkAccess.identity.exists ? '已绑定钉钉身份' : '未绑定钉钉身份' }}
              </span>
            </div>
            <p v-if="dingtalkAccess?.server" class="user-admin__hint">
              {{ readDingTalkServerStatus(dingtalkAccess) }}
            </p>
            <p v-if="dingtalkAccess?.server?.corpId" class="user-admin__hint">
              服务端 corpId：{{ dingtalkAccess.server.corpId }}
            </p>
            <p v-if="dingtalkAccess?.server?.allowedCorpIds?.length" class="user-admin__hint">
              允许企业：{{ dingtalkAccess.server.allowedCorpIds.join('、') }}
            </p>
            <div v-if="dingtalkAccess?.workNotification" class="user-admin__chips">
              <span
                class="user-admin__chip"
                :class="{ 'user-admin__chip--success': dingtalkAccess.workNotification.available, 'user-admin__chip--danger': !dingtalkAccess.workNotification.available }"
              >
                {{ dingtalkAccess.workNotification.available ? '工作通知已配置' : '工作通知未配置完整' }}
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': dingtalkAccess.workNotification.requirements.appKey.configured, 'user-admin__chip--danger': !dingtalkAccess.workNotification.requirements.appKey.configured }">
                App Key
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': dingtalkAccess.workNotification.requirements.appSecret.configured, 'user-admin__chip--danger': !dingtalkAccess.workNotification.requirements.appSecret.configured }">
                App Secret
              </span>
              <span class="user-admin__chip" :class="{ 'user-admin__chip--success': dingtalkAccess.workNotification.requirements.agentId.configured, 'user-admin__chip--danger': !dingtalkAccess.workNotification.requirements.agentId.configured }">
                Agent ID
              </span>
            </div>
            <p v-if="dingtalkAccess?.workNotification" class="user-admin__hint">
              {{ readDingTalkWorkNotificationStatus(dingtalkAccess) }}
            </p>
            <div v-if="dingtalkAccess" class="user-admin__create-grid">
              <div class="user-admin__hint"><strong>身份 corpId：</strong>{{ dingtalkAccess.identity.corpId || dingtalkAccess.server?.corpId || '未记录' }}</div>
              <div class="user-admin__hint"><strong>Union ID：</strong>{{ dingtalkAccess.identity.unionId || '未记录' }}</div>
              <div class="user-admin__hint"><strong>Open ID：</strong>{{ dingtalkAccess.identity.openId || '未记录' }}</div>
              <div class="user-admin__hint"><strong>最近钉钉登录：</strong>{{ formatDate(dingtalkAccess.identity.lastLoginAt) }}</div>
              <div class="user-admin__hint"><strong>最近目录同步：</strong>{{ formatDirectorySyncAt(memberAdmission) }}</div>
              <div class="user-admin__hint"><strong>钉钉身份更新时间：</strong>{{ formatDate(dingtalkAccess.identity.updatedAt) }}</div>
            </div>
            <p v-if="dingtalkAccess?.identity.lastLoginAt" class="user-admin__hint">
              最近钉钉登录：{{ formatDate(dingtalkAccess.identity.lastLoginAt) }}
            </p>
            <p v-if="shouldWarnMissingDingTalkOpenId(dingtalkAccess)" class="user-admin__warning">
              当前钉钉身份缺少 openId，暂不能开通钉钉扫码；请重新同步目录或让用户完成一次钉钉 OAuth 绑定。
            </p>
            <p v-if="shouldWarnMissingDingTalkOpenId(dingtalkAccess)" class="user-admin__hint">
              修复建议：先回到目录同步查看该成员是否已补齐 openId；如果目录仍未返回，请让用户先完成一次钉钉 OAuth 绑定；确认 openId 已补齐后刷新本页，再开通钉钉扫码。
            </p>
            <p v-if="dingtalkAccess?.grant.updatedAt" class="user-admin__hint">
              开通状态更新时间：{{ formatDate(dingtalkAccess.grant.updatedAt) }}
            </p>
            <div class="user-admin__role-actions">
              <router-link
                v-if="shouldWarnMissingDingTalkOpenId(dingtalkAccess) && access && readPrimaryDingTalkDirectoryMembership(memberAdmission)"
                class="user-admin__button user-admin__button--secondary"
                :to="buildDirectoryManagementLocation(access.user.id, readPrimaryDingTalkDirectoryMembership(memberAdmission)!)"
              >
                前往目录成员
              </router-link>
              <button class="user-admin__button" type="button" :disabled="busy || loadingDingTalk || dingtalkAccess?.grant.enabled === true || !canEnableDingTalkGrant(dingtalkAccess)" @click="void updateDingTalkGrant(true)">
                开通钉钉扫码
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy || loadingDingTalk || dingtalkAccess?.grant.enabled !== true" @click="void updateDingTalkGrant(false)">
                关闭钉钉扫码
              </button>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>账号操作</h3>
            <div class="user-admin__role-actions">
              <button class="user-admin__button" type="button" :disabled="busy" @click="void toggleUserStatus()">
                {{ access.user.is_active ? '停用账号' : '启用账号' }}
              </button>
              <input
                v-model.trim="manualPassword"
                class="user-admin__search"
                type="text"
                placeholder="可选：设置临时密码"
              />
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy" @click="void resetPassword()">
                重置密码
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy" @click="void revokeSessions()">
                全部下线
              </button>
            </div>
            <p class="user-admin__hint">重置密码或停用账号会让该用户的现有会话失效。</p>
            <p v-if="temporaryPassword" class="user-admin__status">
              临时密码：{{ temporaryPassword }}
            </p>
          </div>

          <div class="user-admin__section">
            <div class="user-admin__section-head">
              <div>
                <h3>会话</h3>
                <p class="user-admin__hint">支持按单会话踢下线，避免一刀切影响全部设备。</p>
              </div>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingSessions" @click="void loadUserSessions(access.user.id)">
                {{ loadingSessions ? '刷新中...' : '刷新会话' }}
              </button>
            </div>
            <div v-if="userSessions.length === 0" class="user-admin__empty">暂无活动会话</div>
            <div v-else class="user-admin__role-list">
              <article v-for="session in userSessions" :key="session.id" class="user-admin__role-card">
                <strong>{{ session.id }}</strong>
                <small>签发：{{ formatDate(session.issuedAt) }}</small>
                <small>过期：{{ formatDate(session.expiresAt) }}</small>
                <small>最近活跃：{{ formatDate(session.lastSeenAt) }}</small>
                <small v-if="session.ipAddress">IP：{{ session.ipAddress }}</small>
                <small v-if="session.userAgent">UA：{{ session.userAgent }}</small>
                <small v-if="session.revokedAt">已撤销：{{ formatDate(session.revokedAt) }}</small>
                <button
                  v-if="!session.revokedAt"
                  class="user-admin__button user-admin__button--secondary"
                  type="button"
                  :disabled="busy || loadingSessions"
                  @click="void revokeSingleSession(session.id)"
                >
                  踢下线
                </button>
              </article>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>角色操作</h3>
            <div class="user-admin__role-actions">
              <select v-model="selectedRoleId" class="user-admin__select">
                <option value="">请选择角色</option>
                <option v-for="role in roleCatalog" :key="role.id" :value="role.id">
                  {{ role.name }} ({{ role.id }})
                </option>
              </select>
              <button class="user-admin__button" type="button" :disabled="busy || !selectedRoleId" @click="void assignRole()">
                分配角色
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy || !selectedRoleId" @click="void unassignRole()">
                撤销角色
              </button>
            </div>
          </div>

          <div class="user-admin__section">
            <h3>角色目录</h3>
            <div class="user-admin__role-list">
              <article v-for="role in roleCatalog" :key="role.id" class="user-admin__role-card">
                <strong>{{ role.name }}</strong>
                <span>{{ role.id }}</span>
                <small>成员数：{{ role.memberCount }}</small>
                <p>{{ role.permissions.join(', ') || '无权限映射' }}</p>
              </article>
            </div>
          </div>
        </template>

        <div v-else class="user-admin__empty">
          请选择一个用户查看访问详情
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'
import { subscribeToLocationChanges } from '../utils/browserLocation'

type ManagedUser = {
  id: string
  email: string | null
  username?: string | null
  name: string | null
  mobile?: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
  platformAdminEnabled?: boolean
  attendanceAdminEnabled?: boolean
  dingtalkLoginEnabled?: boolean
  dingtalkGrantUpdatedAt?: string | null
  dingtalkGrantUpdatedBy?: string | null
  directoryLinked?: boolean
  dingtalkIdentityExists?: boolean
  dingtalkHasUnionId?: boolean
  dingtalkHasOpenId?: boolean
  dingtalkOpenIdMissing?: boolean
  dingtalkCorpId?: string | null
  lastDirectorySyncAt?: string | null
  businessRoleCount?: number
}

type RoleCatalogItem = {
  id: string
  name: string
  permissions: string[]
  memberCount: number
}

type UserAccess = {
  user: ManagedUser
  roles: string[]
  permissions: string[]
  isAdmin: boolean
}

type DingTalkRuntimeStatus = {
  configured: boolean
  available: boolean
  corpId: string | null
  allowedCorpIds: string[]
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
  unavailableReason: 'missing_client_id' | 'missing_client_secret' | 'missing_redirect_uri' | 'corp_not_allowed' | null
}

type DingTalkWorkNotificationRuntimeStatus = {
  configured: boolean
  available: boolean
  unavailableReason: 'missing_app_key' | 'missing_app_secret' | 'missing_agent_id' | null
  requirements: {
    appKey: {
      configured: boolean
      selectedKey: string | null
    }
    appSecret: {
      configured: boolean
      selectedKey: string | null
    }
    agentId: {
      configured: boolean
      selectedKey: string | null
    }
    baseUrl?: {
      configured: boolean
      selectedKey: string | null
    }
  }
}

type DingTalkAccess = {
  provider: 'dingtalk'
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
  server?: DingTalkRuntimeStatus
  workNotification?: DingTalkWorkNotificationRuntimeStatus
  grant: {
    exists: boolean
    enabled: boolean
    grantedBy: string | null
    createdAt: string | null
    updatedAt: string | null
  }
  identity: {
    exists: boolean
    corpId: string | null
    unionId: string | null
    openId: string | null
    hasUnionId: boolean
    hasOpenId: boolean
    lastLoginAt: string | null
    createdAt: string | null
    updatedAt: string | null
  }
}

type MemberDirectoryMembership = {
  integrationId: string
  integrationName: string
  provider: string
  corpId: string | null
  directoryAccountId: string
  externalUserId: string
  name: string
  email: string | null
  mobile: string | null
  accountEnabled: boolean
  accountUpdatedAt: string
  linkStatus: string
  matchStrategy: string | null
  reviewedBy: string | null
  reviewNote: string | null
  linkUpdatedAt: string
  departmentPaths: string[]
}

type MemberAdmission = {
  userId: string
  accountEnabled: boolean
  platformAdminEnabled: boolean
  attendanceAdminEnabled: boolean
  businessRoleIds: string[]
  directoryMemberships: MemberDirectoryMembership[]
  dingtalk: DingTalkAccess
  namespaceAdmissions: NamespaceAdmission[]
}

type NamespaceAdmission = {
  namespace: string
  enabled: boolean
  effective: boolean
  hasRole: boolean
  updatedAt: string | null
}

type CreateUserForm = {
  name: string
  email: string
  username: string
  mobile: string
  password: string
  presetId: string
  role: string
  roleId: string
  isActive: boolean
}

type AccessPreset = {
  id: string
  name: string
  description: string
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  role: string
  roleId?: string
  permissions: string[]
  homePath: string
  welcomeTitle: string
  checklist: string[]
}

type OnboardingPacket = {
  presetId: string | null
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  homePath: string
  loginPath: string
  loginUrl: string
  acceptInvitePath: string
  acceptInviteUrl: string
  accountLabel: string
  welcomeTitle: string
  checklist: string[]
  inviteMessage: string
}

type InviteLedgerRecord = {
  id: string
  userId: string
  email: string
  userName: string | null
  presetId: string | null
  productMode: 'platform' | 'attendance' | 'plm-workbench'
  roleId: string | null
  invitedByEmail: string | null
  invitedByName: string | null
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  acceptedAt: string | null
  inviteToken: string
  lastSentAt: string
  createdAt: string
}

type UserSessionRecord = {
  id: string
  userId: string
  issuedAt: string
  expiresAt: string
  lastSeenAt: string
  revokedAt: string | null
  revokedBy: string | null
  revokeReason: string | null
  ipAddress: string | null
  userAgent: string | null
}

type UserListFilter = 'all' | 'account-disabled' | 'dingtalk-disabled' | 'directory-unlinked' | 'dingtalk-openid-missing' | 'platform-admin'

const USER_LIST_FILTER_VALUES: UserListFilter[] = ['all', 'account-disabled', 'dingtalk-disabled', 'directory-unlinked', 'dingtalk-openid-missing', 'platform-admin']

type InitialUserNavigation = {
  userId: string
  source: string
  filter: UserListFilter
  integrationId: string
  accountId: string
  directoryFailure: string
}

const { hasAdminAccess } = useAuth()

const adminAllowed = hasAdminAccess()
const loading = ref(false)
const loadingInvites = ref(false)
const loadingSessions = ref(false)
const loadingDingTalk = ref(false)
const loadingAdmission = ref(false)
const bulkBusy = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const users = ref<ManagedUser[]>([])
const selectedUserIds = ref<string[]>([])
const userListFilter = ref<UserListFilter>(readInitialUserNavigation().filter)
const roleCatalog = ref<RoleCatalogItem[]>([])
const accessPresets = ref<AccessPreset[]>([])
const presetModeFilter = ref<'' | 'platform' | 'attendance' | 'plm-workbench'>('')
const selectedNamespace = ref('')
const selectedUserId = ref('')
const selectedRoleId = ref('')
const manualPassword = ref('')
const temporaryPassword = ref('')
const createdTemporaryPassword = ref('')
const createdInviteMessage = ref('')
const createdOnboarding = ref<OnboardingPacket | null>(null)
const inviteRecords = ref<InviteLedgerRecord[]>([])
const userSessions = ref<UserSessionRecord[]>([])
const access = ref<UserAccess | null>(null)
const dingtalkAccess = ref<DingTalkAccess | null>(null)
const memberAdmission = ref<MemberAdmission | null>(null)
const profileDraftName = ref('')
const profileDraftMobile = ref('')
const appliedUserNavigationKey = ref('')
const createForm = ref<CreateUserForm>({
  name: '',
  email: '',
  username: '',
  mobile: '',
  password: '',
  presetId: '',
  role: 'user',
  roleId: '',
  isActive: true,
})
const selectedPreset = computed(() => accessPresets.value.find((preset) => preset.id === createForm.value.presetId) || null)
const governanceSummary = computed(() => ({
  total: users.value.length,
  accountEnabled: users.value.filter((user) => user.is_active).length,
  dingtalkEnabled: users.value.filter((user) => user.dingtalkLoginEnabled !== false).length,
  directoryLinked: users.value.filter((user) => user.directoryLinked === true).length,
  dingtalkOpenIdMissing: users.value.filter((user) => user.dingtalkOpenIdMissing === true).length,
  dingtalkOpenIdGoverned: users.value.filter((user) => user.dingtalkOpenIdMissing === true && user.dingtalkLoginEnabled === false).length,
  dingtalkOpenIdPending: users.value.filter((user) => user.dingtalkOpenIdMissing === true && user.dingtalkLoginEnabled !== false).length,
}))
const governanceWorkbenchCards = computed(() => {
  const pendingToday = users.value.filter((user) => (
    user.dingtalkOpenIdMissing === true
    && user.dingtalkLoginEnabled !== false
  )).length
  const directoryRepairCount = users.value.filter((user) => (
    user.dingtalkOpenIdMissing === true
    && user.directoryLinked === true
  )).length
  const governedRecent = users.value.filter((user) => (
    user.dingtalkOpenIdMissing === true
    && user.dingtalkLoginEnabled === false
    && isWithinRecentDays(user.dingtalkGrantUpdatedAt, 7)
  )).length

  return [
    {
      kicker: '治理清单',
      title: '缺 OpenID 成员',
      description: '直接进入当前缺 OpenID 用户筛选，适合先做名单筛查和批量收口。',
      note: pendingToday > 0 ? `今日优先处理 ${pendingToday} 个待收口成员` : '当前没有待收口成员需要优先处理',
      to: buildMissingOpenIdUserManagementLocation(),
    },
    {
      kicker: '目录修复',
      title: '目录同步修复入口',
      description: '跳到目录同步页，继续刷新目录成员、补齐 openId 或回看目录绑定状态。',
      note: directoryRepairCount > 0 ? `${directoryRepairCount} 个成员可先回目录同步继续补齐 openId` : '当前没有需要回目录同步补齐的成员',
      to: buildDirectoryMissingOpenIdWorkbenchLocation(),
    },
    {
      kicker: '审计复盘',
      title: '最近 7 天收口审计',
      description: '查看最近 7 天钉钉扫码关闭记录，适合巡检治理结果和责任追踪。',
      note: governedRecent > 0 ? `最近 7 天已收口 ${governedRecent} 个成员，可直接复盘处理动作` : '最近 7 天暂无新的收口记录',
      to: buildRecentDingTalkGovernanceAuditLocation(),
    },
  ]
})
const visibleUsers = computed(() => {
  return users.value.filter((user) => {
    if (userListFilter.value === 'account-disabled') return !user.is_active
    if (userListFilter.value === 'dingtalk-disabled') return user.dingtalkLoginEnabled === false
    if (userListFilter.value === 'directory-unlinked') return user.directoryLinked !== true
    if (userListFilter.value === 'dingtalk-openid-missing') return user.dingtalkOpenIdMissing === true
    if (userListFilter.value === 'platform-admin') return user.platformAdminEnabled === true
    return true
  })
})
const screeningUsersMissingOpenId = computed(() => visibleUsers.value.filter((user) => user.dingtalkOpenIdMissing === true))
const screeningUsersMissingOpenIdWithGrant = computed(() => (
  screeningUsersMissingOpenId.value.filter((user) => user.dingtalkLoginEnabled === true)
))
const selectedUserIdSet = computed(() => new Set(selectedUserIds.value))
const userFilterOptions = [
  { value: 'all', label: '全部' },
  { value: 'account-disabled', label: '账号停用' },
  { value: 'dingtalk-disabled', label: '钉钉停用' },
  { value: 'directory-unlinked', label: '目录未链接' },
  { value: 'dingtalk-openid-missing', label: '缺 OpenID' },
  { value: 'platform-admin', label: '平台管理员' },
] as const
const hasPlatformAdminAccess = computed(() => {
  if (!access.value) return false
  return access.value.roles.includes('admin') || access.value.user.role === 'admin' || access.value.user.is_admin
})
const hasAttendanceAdminAccess = computed(() => {
  if (!access.value) return false
  return access.value.roles.includes('attendance_admin') || access.value.permissions.includes('attendance:admin')
})
const filteredAccessPresets = computed(() => {
  return accessPresets.value.filter((preset) => !presetModeFilter.value || preset.productMode === presetModeFilter.value)
})
const hasProfileDraftChanges = computed(() => {
  if (!access.value) return false
  return profileDraftName.value !== (access.value.user.name || '') || profileDraftMobile.value !== (access.value.user.mobile || '')
})

function formatManagedUserIdentifier(user: ManagedUser | null | undefined): string {
  if (!user) return ''
  return user.email || user.username || user.mobile || user.id
}

function formatManagedUserLabel(user: ManagedUser | null | undefined): string {
  if (!user) return ''
  return user.name || formatManagedUserIdentifier(user)
}

function isWithinRecentDays(value: string | null | undefined, days: number): boolean {
  if (!value) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  const now = new Date()
  const threshold = new Date(now)
  threshold.setDate(now.getDate() - Math.max(0, days - 1))
  threshold.setHours(0, 0, 0, 0)
  return date.getTime() >= threshold.getTime()
}

function readMissingOpenIdGovernanceHint(user: ManagedUser): string {
  const parts = [`corpId ${user.dingtalkCorpId || '未记录'}`]
  if (user.lastDirectorySyncAt) {
    parts.push(`最近目录同步 ${formatDate(user.lastDirectorySyncAt)}`)
  }
  if (user.dingtalkLoginEnabled === false && user.dingtalkGrantUpdatedAt) {
    const actor = user.dingtalkGrantUpdatedBy ? ` · 处理人 ${user.dingtalkGrantUpdatedBy}` : ''
    parts.push(`最近关闭钉钉扫码 ${formatDate(user.dingtalkGrantUpdatedAt)}${actor}`)
  }
  return parts.join(' · ')
}

function escapeCsvValue(value: unknown): string {
  const text = String(value ?? '')
  if (!/[",\n]/.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

function downloadText(filename: string, text: string, mimeType: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前环境不支持文件导出')
  }
  const blob = new Blob([`\ufeff${text}`], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function exportMissingOpenIdCsv(): void {
  if (screeningUsersMissingOpenId.value.length === 0) {
    setStatus('当前筛选结果中没有缺 OpenID 用户可导出', 'error')
    return
  }

  const header = ['userId', 'name', 'account', 'role', 'dingtalkCorpId', 'directoryLinked', 'lastDirectorySyncAt']
  const rows = screeningUsersMissingOpenId.value.map((user) => ([
    user.id,
    user.name || '',
    formatManagedUserIdentifier(user),
    user.role,
    user.dingtalkCorpId || '',
    user.directoryLinked === true ? 'linked' : 'unlinked',
    user.lastDirectorySyncAt || '',
  ].map(escapeCsvValue).join(',')))
  downloadText(
    `dingtalk-missing-openid-users-${new Date().toISOString().slice(0, 10)}.csv`,
    [header.join(','), ...rows].join('\n'),
    'text/csv;charset=utf-8',
  )
  setStatus(`已导出 ${screeningUsersMissingOpenId.value.length} 个缺 OpenID 用户的治理清单`)
}

function exportGovernanceDailySummary(): void {
  const today = formatDateInput(new Date())
  const lines = [
    `# DingTalk 治理日报摘要`,
    '',
    `日期：${today}`,
    '',
    `## 核心统计`,
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    `## 当前建议`,
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
    '',
    `## 工作台入口`,
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.to}`),
  ]
  downloadText(
    `dingtalk-governance-daily-summary-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 治理日报摘要')
}

function exportGovernanceLiveValidationChecklist(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 治理联调检查单',
    '',
    `日期：${today}`,
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    '',
    '## 联调步骤',
    '- 1. 打开缺 OpenID 成员清单，确认待收口成员列表与当前预期一致。',
    `  入口：${buildMissingOpenIdUserManagementLocation()}`,
    '- 2. 随机抽取至少 1 个目录已链接但缺 openId 的成员，跳到目录同步页，刷新目录成员并确认是否补齐 openId。',
    `  入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    '- 3. 对仍缺 openId 且已开通钉钉扫码的成员，执行批量关闭，确认治理统计从“待收口”转到“已收口”。',
    '- 4. 打开最近 7 天收口审计，确认最近治理动作、处理时间和处理人可追溯。',
    `  入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '- 5. 在真实钉钉账号上验证：已修复成员可正常钉钉登录；未修复成员仍被正确阻止。',
    '- 6. 导出治理日报摘要，归档当天治理结果。',
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-live-validation-checklist-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 联调检查单')
}

function exportGovernanceValidationResultTemplate(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 治理联调结果回填模板',
    '',
    `日期：${today}`,
    '',
    '## 联调环境',
    '- 环境：142 / staging / other',
    '- 执行人：',
    '- 协同人：',
    '- 执行时间：',
    '',
    '## 执行前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    '',
    '## 结果回填',
    '- [ ] 缺 OpenID 成员清单与预期一致',
    '  - 实际结果：',
    `  - 入口：${buildMissingOpenIdUserManagementLocation()}`,
    '- [ ] 目录同步可补齐 openId / 或确认仍缺失原因',
    '  - 实际结果：',
    `  - 入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    '- [ ] 批量关闭缺 OpenID 钉钉扫码后，待收口数量正确变化',
    '  - 实际结果：',
    '- [ ] 最近 7 天收口审计可看到时间、处理人和动作',
    '  - 实际结果：',
    `  - 入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '- [ ] 真实钉钉账号验证通过',
    '  - 已修复成员：',
    '  - 未修复成员：',
    '',
    '## 异常记录',
    '- 账号 / 现象 / 初步判断：',
    '- 日志或截图位置：',
    '',
    '## 执行后结论',
    '- 是否可继续放量：',
    '- 是否需要继续修复：',
    '- 下一步负责人：',
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-validation-result-template-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 联调结果模板')
}

function exportGovernanceExecutionPackageIndex(): void {
  const today = formatDateInput(new Date())
  const dailySummaryFile = `dingtalk-governance-daily-summary-${today}.md`
  const checklistFile = `dingtalk-governance-live-validation-checklist-${today}.md`
  const resultTemplateFile = `dingtalk-governance-validation-result-template-${today}.md`
  const lines = [
    '# DingTalk 治理联调执行包索引',
    '',
    `日期：${today}`,
    '',
    '## 推荐执行顺序',
    '1. 导出治理日报摘要',
    `   - 文件：${dailySummaryFile}`,
    '2. 导出联调检查单',
    `   - 文件：${checklistFile}`,
    '3. 执行真实联调',
    `   - 缺 OpenID 成员入口：${buildMissingOpenIdUserManagementLocation()}`,
    `   - 目录同步修复入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `   - 最近 7 天收口审计：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '4. 导出联调结果模板',
    `   - 文件：${resultTemplateFile}`,
    '5. 回填并归档结果',
    '   - 建议归档日报、检查单、结果模板和异常截图 / 日志位置。',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 导出文件清单',
    `- ${dailySummaryFile}`,
    `- ${checklistFile}`,
    `- ${resultTemplateFile}`,
    '',
    '## 工作台入口',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.to}`),
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-execution-package-index-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 联调执行包索引')
}

function exportGovernanceFullValidationPackage(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 治理完整联调包',
    '',
    `日期：${today}`,
    '',
    '## 包内目录',
    '- 治理日报摘要',
    '- 联调检查单',
    '- 联调结果回填模板',
    '- 工作台入口与当前建议',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 推荐执行顺序',
    '1. 先看治理日报摘要，确认当天缺 OpenID、待收口、已收口数量。',
    '2. 按联调检查单执行缺 OpenID 清单、目录同步修复、批量关闭和审计复盘。',
    '3. 用真实钉钉账号验证已修复成员和未修复成员的登录结果。',
    '4. 在结果回填模板中记录执行结论、异常和下一步负责人。',
    '5. 归档本完整包以及必要的日志或截图位置。',
    '',
    '## 治理日报摘要',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 联调检查单',
    '- [ ] 缺 OpenID 成员清单与预期一致',
    `  - 入口：${buildMissingOpenIdUserManagementLocation()}`,
    '- [ ] 目录同步页可用于补齐 openId 或确认仍缺失原因',
    `  - 入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    '- [ ] 批量关闭缺 OpenID 钉钉扫码后，待收口和已收口统计变化正确',
    '- [ ] 最近 7 天收口审计可看到动作、处理时间和处理人',
    `  - 入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '- [ ] 真实钉钉账号验证通过',
    '  - 已修复成员：',
    '  - 未修复成员：',
    '',
    '## 联调结果回填模板',
    '- 环境：142 / staging / other',
    '- 执行人：',
    '- 协同人：',
    '- 执行时间：',
    '- 实际结果：',
    '- 异常记录：',
    '- 是否可继续放量：',
    '- 是否需要继续修复：',
    '- 下一步负责人：',
    '',
    '## 工作台入口',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.to}`),
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-full-validation-package-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 完整联调包')
}

function exportGovernanceDeliveryChecklist(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 交付清单',
    '',
    `日期：${today}`,
    '',
    '## 当前交付判断',
    '- 当前阶段：可进入试运行 / 试交付',
    '- 正式交付前提：完成 142 真实环境联调、钉钉授权范围确认、真实账号访问矩阵验收',
    '- 适用范围：钉钉登录、目录同步、成员绑定、无邮箱自动准入、治理工作台、公共表单联调',
    '',
    '## 代码基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 交付项',
    '- [ ] 钉钉登录与本地账号绑定链路可用',
    '- [ ] 目录同步页可定位成员、回跳用户治理页、复制协作链接',
    '- [ ] 无邮箱成员自动准入与手工创建链路可复制完整交付信息',
    '- [ ] 治理工作台可导出日报、联调检查单、联调结果模板、完整联调包',
    '- [ ] 公共表单在匿名 / 登录 / 指定用户 / 未绑定用户场景的预期文案明确',
    '',
    '## 交付前操作',
    `- 导出完整联调包：dingtalk-governance-full-validation-package-${today}.md`,
    `- 导出 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    '- 准备真实钉钉测试账号、真实群机器人 webhook、目录同步管理员账号',
    '- 准备回填位置：异常记录、截图位置、日志位置、负责人',
    '',
    '## 关键入口',
    `- 缺 OpenID 成员：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步修复入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 最近 7 天治理审计：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 剩余风险',
    '- 钉钉授权用户组、组织范围和 openId 数据完整性仍需以 142 实际联调为准。',
    '- 首次改密用户、未绑定钉钉用户、匿名表单访问仍需做真实环境矩阵回归。',
    '- 正式交付结论不应只依据本地测试通过，需要结合 142 运行结果一起判断。',
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-delivery-checklist-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 交付清单')
}

function exportGovernance142AcceptanceChecklist(): void {
  const today = formatDateInput(new Date())
  const fullPackageFile = `dingtalk-governance-full-validation-package-${today}.md`
  const lines = [
    '# DingTalk 142 联调验收清单',
    '',
    `日期：${today}`,
    '',
    '## 验收前提',
    `- 先导出完整联调包：${fullPackageFile}`,
    '- 准备 142 管理员账号、真实钉钉测试账号、无邮箱测试账号、至少 1 个授权用户组外账号',
    '- 准备真实 DingTalk 群机器人 webhook 和需要联调的公共表单链接',
    '',
    '## 验收矩阵',
    '- [ ] 场景 1：已绑定且启用的 DingTalk 用户可正常登录并访问目标页面',
    '- [ ] 场景 2：未绑定本地启用用户的 DingTalk 账号收到明确失败提示',
    '- [ ] 场景 3：缺 openId 用户不会被误判为可用登录用户',
    '- [ ] 场景 4：首次登录需改密用户能看到正确改密页和退出路径',
    '- [ ] 场景 5：公共表单在匿名、登录、指定用户三类模式下行为符合预期',
    '- [ ] 场景 6：目录同步可定位并补齐目标成员信息，或准确提示缺失原因',
    '- [ ] 场景 7：群机器人消息发送成功，签名和关键词限制符合预期',
    '',
    '## 执行入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 结果回填',
    '- 验收环境：142',
    '- 执行人：',
    '- 执行时间：',
    '- 通过项：',
    '- 失败项：',
    '- 失败现象：',
    '- 对应截图 / 日志位置：',
    '- 是否允许正式交付：',
    '- 下一步负责人：',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-142-acceptance-checklist-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 142 联调验收清单')
}

function exportGovernanceTrialRunbook(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 试运行值班说明',
    '',
    `日期：${today}`,
    '',
    '## 适用阶段',
    '- 当前用于试运行 / 灰度放量阶段。',
    '- 目标是在正式交付前，把钉钉登录、目录同步、公共表单和群机器人链路跑通并留痕。',
    '',
    '## 值班前准备',
    '- 导出交付清单，明确今日试运行范围与剩余风险。',
    `  - 文件：dingtalk-governance-delivery-checklist-${today}.md`,
    '- 导出 142 联调验收清单，作为当天结果回填载体。',
    `  - 文件：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    '- 准备至少 1 个已绑定用户、1 个未绑定用户、1 个无邮箱准入用户和 1 个授权组外用户。',
    '',
    '## 值班入口',
    `- 缺 OpenID 成员：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步修复入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 最近 7 天治理审计：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 值班检查项',
    '- [ ] 已绑定钉钉用户能正常登录目标页面。',
    '- [ ] 未绑定或未启用用户得到正确失败提示，不出现误放行。',
    '- [ ] 缺 openId 成员可在目录页定位，或能明确看到缺失原因。',
    '- [ ] 自动准入 / 手工创建结果卡片可复制交付信息并发给协作者。',
    '- [ ] 公共表单在匿名、登录、指定用户模式下行为符合预期。',
    '- [ ] 群机器人消息发送成功，关键词与签名校验符合预期。',
    '',
    '## 异常上报',
    '- 记录账号、页面、时间、错误文案、是否可复现。',
    '- 附上截图位置、接口日志位置和初步判断。',
    '- 如为钉钉授权范围 / 组织范围问题，单独标记为环境侧阻塞。',
    '',
    '## 当日收口',
    '- 回填 142 联调验收清单中的通过项、失败项和负责人。',
    '- 导出治理日报摘要，用于和前一日对比。',
    '- 如果失败项只剩环境问题，可进入“可试交付、待正式验收”状态。',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-trial-runbook-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 试运行值班说明')
}

function exportGovernanceDeliveryDecision(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 正式交付结论',
    '',
    `日期：${today}`,
    '',
    '## 结论类型',
    '- [ ] 可正式交付',
    '- [ ] 可试交付，需继续观察',
    '- [ ] 暂不交付，需继续修复',
    '',
    '## 依据文档',
    `- 交付清单：dingtalk-governance-delivery-checklist-${today}.md`,
    `- 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- 试运行值班说明：dingtalk-governance-trial-runbook-${today}.md`,
    `- 完整联调包：dingtalk-governance-full-validation-package-${today}.md`,
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 关键链路结论',
    '- 钉钉登录：',
    '- 本地账号绑定：',
    '- 目录同步与成员定位：',
    '- 无邮箱自动准入 / 手工创建：',
    '- 公共表单匿名 / 登录 / 指定用户访问：',
    '- 群机器人消息发送：',
    '',
    '## 环境侧结论',
    '- 钉钉授权组范围是否正确：',
    '- 钉钉组织范围 / 通讯录同步是否正确：',
    '- 是否仍存在 openId / unionId 数据缺口：',
    '- 是否存在仅 142 环境可复现的问题：',
    '',
    '## 风险与阻塞',
    '- 仍需修复项：',
    '- 环境侧阻塞项：',
    '- 是否影响正式交付：',
    '',
    '## 建议动作',
    '- 是否继续放量：',
    '- 是否进入正式交付：',
    '- 下一步负责人：',
    '- 计划完成时间：',
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-delivery-decision-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 正式交付结论')
}

function exportGovernanceDeliveryArchiveIndex(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 交付归档包索引',
    '',
    `日期：${today}`,
    '',
    '## 归档目的',
    '- 用于把试运行、142 联调验收和正式交付结论相关文档集中归档。',
    '- 适合作为交付负责人、测试、运维和后续值班复盘的统一入口。',
    '',
    '## 归档文件清单',
    `- dingtalk-governance-daily-summary-${today}.md`,
    `- dingtalk-governance-live-validation-checklist-${today}.md`,
    `- dingtalk-governance-validation-result-template-${today}.md`,
    `- dingtalk-governance-execution-package-index-${today}.md`,
    `- dingtalk-governance-full-validation-package-${today}.md`,
    `- dingtalk-governance-delivery-checklist-${today}.md`,
    `- dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- dingtalk-governance-trial-runbook-${today}.md`,
    `- dingtalk-governance-delivery-decision-${today}.md`,
    '',
    '## 建议归档顺序',
    '1. 先归档完整联调包与交付清单，保留当天基线。',
    '2. 再归档 142 联调验收清单和试运行值班说明，保留真实环境执行记录。',
    '3. 最后归档正式交付结论，形成 go / no-go 结论。',
    '',
    '## 配套证据',
    '- 异常截图路径：',
    '- 接口日志路径：',
    '- 群机器人发送记录：',
    '- 真实账号测试记录：',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-delivery-archive-index-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 交付归档包索引')
}

function exportGovernanceCloseoutChecklist(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 收尾检查单',
    '',
    `日期：${today}`,
    '',
    '## 收尾目标',
    '- 在代码开发基本收口后，完成 142 联调回填、交付判断、归档和对外同步。',
    '- 这份清单用于把“可试运行”推进到“可正式交付”或“明确暂缓交付”。',
    '',
    '## 必做项',
    '- [ ] 回填 142 联调验收清单中的通过项、失败项、截图和日志位置。',
    '- [ ] 根据试运行结果补齐正式交付结论中的 go / no-go 判断。',
    '- [ ] 归档完整联调包、试运行说明、正式交付结论和交付归档包索引。',
    '- [ ] 明确是否还存在环境侧阻塞，如授权组、组织范围、openId 数据缺口。',
    '- [ ] 向测试、运维、业务负责人同步当天结论和下一步动作。',
    '',
    '## 建议执行顺序',
    `1. 导出并回填 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `2. 导出并补齐正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    `3. 导出交付归档包索引：dingtalk-governance-delivery-archive-index-${today}.md`,
    `4. 如仍在观察期，导出试运行值班说明：dingtalk-governance-trial-runbook-${today}.md`,
    '',
    '## 输出物',
    `- dingtalk-governance-delivery-checklist-${today}.md`,
    `- dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- dingtalk-governance-trial-runbook-${today}.md`,
    `- dingtalk-governance-delivery-decision-${today}.md`,
    `- dingtalk-governance-delivery-archive-index-${today}.md`,
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-closeout-checklist-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 收尾检查单')
}

function exportGovernanceStakeholderUpdateTemplate(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 对外同步模板',
    '',
    `日期：${today}`,
    '',
    '## 同步对象',
    '- 测试负责人：',
    '- 运维负责人：',
    '- 业务负责人：',
    '- 项目负责人：',
    '',
    '## 今日结论',
    '- 当前阶段：试运行 / 联调验收 / 可正式交付 / 暂缓交付',
    '- 今日总体判断：',
    '- 是否允许继续放量：',
    '',
    '## 关键状态',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 已完成事项',
    '- [ ] 142 联调验收完成并已回填',
    '- [ ] 试运行结果已回填',
    '- [ ] 正式交付结论已更新',
    '- [ ] 归档包索引已整理',
    '',
    '## 风险与阻塞',
    '- 环境侧阻塞：',
    '- 代码侧待修复：',
    '- 是否影响交付：',
    '',
    '## 附件与文档',
    `- 交付清单：dingtalk-governance-delivery-checklist-${today}.md`,
    `- 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- 试运行值班说明：dingtalk-governance-trial-runbook-${today}.md`,
    `- 正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    `- 交付归档包索引：dingtalk-governance-delivery-archive-index-${today}.md`,
    `- 收尾检查单：dingtalk-governance-closeout-checklist-${today}.md`,
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 建议下一步',
    '- 下一步动作：',
    '- 下一步负责人：',
    '- 目标完成时间：',
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-stakeholder-update-template-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 对外同步模板')
}

function exportGovernanceLaunchObservationTemplate(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 上线观察记录模板',
    '',
    `日期：${today}`,
    '',
    '## 观察窗口',
    '- 观察开始时间：',
    '- 观察结束时间：',
    '- 观察负责人：',
    '- 观察阶段：试运行 / 正式放量 / 全量上线后观察',
    '',
    '## 关键指标',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '- 登录成功率：',
    '- 表单访问成功率：',
    '- 群机器人消息成功率：',
    '',
    '## 观察项',
    '- [ ] 已绑定 DingTalk 用户登录稳定，无新增异常。',
    '- [ ] 未绑定 / 授权组外用户得到正确提示，无误放行。',
    '- [ ] 目录同步、成员定位和回跳链路稳定。',
    '- [ ] 公共表单访问符合当前授权模式预期。',
    '- [ ] 群机器人消息发送稳定，关键词和签名限制正常。',
    '',
    '## 异常记录',
    '- 时间 / 账号 / 场景 / 现象：',
    '- 影响范围：',
    '- 初步判断：代码 / 数据 / 授权组 / 组织范围 / 第三方波动',
    '- 对应截图 / 日志路径：',
    '',
    '## 结论',
    '- 是否继续观察：',
    '- 是否允许继续放量：',
    '- 是否需要回滚或暂停：',
    '- 下一步负责人：',
    '',
    '## 关联文档',
    `- 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- 正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    `- 收尾检查单：dingtalk-governance-closeout-checklist-${today}.md`,
    `- 对外同步模板：dingtalk-governance-stakeholder-update-template-${today}.md`,
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-launch-observation-template-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 上线观察记录模板')
}

function exportGovernanceManualAcceptanceScript(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 真人侧验收执行单',
    '',
    `日期：${today}`,
    '',
    '## 验收目标',
    '- 用最少的人工作业完成 142 真实环境的关键闭环验证。',
    '- 把“成功样本”“缺 openId 样本”“受保护表单样本”“群机器人样本”按固定顺序跑完。',
    '',
    '## 执行角色',
    '- 执行人：',
    '- 协同记录人：',
    '- 钉钉真人账号持有人：',
    '',
    '## 样本清单',
    '- 成功登录样本：zhouhua',
    '- 缺 openId 样本：P4 Unauthorized Target',
    '- 公开表单样本：钉钉填写入口',
    '- 受保护表单样本：DingTalk P4 Protected Form',
    '- 群机器人样本：生产群机器人 / 验证群',
    '',
    '## 执行顺序',
    '1. 用成功样本打开 DingTalk 登录入口，记录是否成功进入目标页面。',
    '2. 用缺 openId 样本打开同一入口，记录是否被正确拦截，以及错误文案。',
    '3. 打开公开表单样本，记录是否无需额外登录即可进入并看到填写页。',
    '4. 打开受保护表单样本，先记录未登录时是否出现 `DINGTALK_AUTH_REQUIRED` 类提示；再用允许名单用户完成 DingTalk 登录，记录能否进入。',
    '5. 触发一次群机器人消息发送，记录群内是否成功收到消息，以及关键词 / 加签是否符合预期。',
    '',
    '## 机器侧参考',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '- 受保护表单机器探针结果：当前匿名访问会返回 `DINGTALK_AUTH_REQUIRED`。',
    '',
    '## 结果回填',
    '- 成功登录样本结果：',
    '- 缺 openId 样本结果：',
    '- 公开表单样本结果：',
    '- 受保护表单样本结果：',
    '- 群机器人样本结果：',
    '- 截图 / 日志位置：',
    '- 是否允许继续放量：',
    '',
    '## 关联文档',
    `- 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- 正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    `- 上线观察记录模板：dingtalk-governance-launch-observation-template-${today}.md`,
    `- 对外同步模板：dingtalk-governance-stakeholder-update-template-${today}.md`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-manual-acceptance-script-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 真人侧验收执行单')
}

function exportGovernance142AcceptancePackage(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 142 验收执行包',
    '',
    `日期：${today}`,
    '',
    '## 包内目录',
    `- 142 联调验收清单：dingtalk-governance-142-acceptance-checklist-${today}.md`,
    `- 真人侧验收执行单：dingtalk-governance-manual-acceptance-script-${today}.md`,
    `- 上线观察记录模板：dingtalk-governance-launch-observation-template-${today}.md`,
    `- 正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    '',
    '## 当前机器侧结论',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '- 受保护表单机器探针：匿名访问返回 `DINGTALK_AUTH_REQUIRED`',
    '- 公开表单机器探针：可拿到 submitPath',
    '',
    '## 142 真人侧执行顺序',
    '1. 先跑成功登录样本：zhouhua。',
    '2. 再跑缺 openId 样本：P4 Unauthorized Target。',
    '3. 再跑公开表单样本：钉钉填写入口。',
    '4. 再跑受保护表单样本：DingTalk P4 Protected Form。',
    '5. 最后跑群机器人消息样本。',
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 回填要求',
    '- 每个真人侧样本至少记录：结果、错误文案、截图位置、是否影响交付。',
    '- 完成后同步更新正式交付结论与上线观察记录模板。',
    '- 如只剩环境侧阻塞，应在结论中明确标记，不和代码缺陷混淆。',
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-142-acceptance-package-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 142 验收执行包')
}

function exportGovernanceFinalHandoffPackage(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 最终交付包',
    '',
    `日期：${today}`,
    '',
    '## 包内目录',
    `- 142 验收执行包：dingtalk-governance-142-acceptance-package-${today}.md`,
    `- 正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    `- 对外同步模板：dingtalk-governance-stakeholder-update-template-${today}.md`,
    `- 上线观察记录模板：dingtalk-governance-launch-observation-template-${today}.md`,
    `- 交付归档包索引：dingtalk-governance-delivery-archive-index-${today}.md`,
    `- 收尾检查单：dingtalk-governance-closeout-checklist-${today}.md`,
    '',
    '## 当前交付判断',
    '- 当前状态：代码侧已基本收口，等待 142 真人侧验收回填。',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 最终执行顺序',
    '1. 先执行 142 验收执行包中的真人侧样本。',
    '2. 回填正式交付结论，确认 go / no-go。',
    '3. 导出对外同步模板，向测试、运维、业务和项目负责人同步结论。',
    '4. 用上线观察记录模板记录放量后的观察窗口结果。',
    '5. 用交付归档包索引完成最终归档。',
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 最终回填要求',
    '- 必须记录：成功样本、失败样本、受保护表单、公开表单、群机器人结果。',
    '- 必须记录：截图位置、日志位置、是否影响正式交付。',
    '- 如仍存在环境侧阻塞，必须在正式交付结论和对外同步模板里显式说明。',
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-final-handoff-package-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 最终交付包')
}

function exportGovernanceAcceptanceResultSummaryTemplate(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 验收结果汇总模板',
    '',
    `日期：${today}`,
    '',
    '## 汇总目标',
    '- 用一页汇总 142 真人侧验收与机器探针的最终结果。',
    '- 适合作为交付负责人、测试、运维和业务方的统一结果页。',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 样本结果汇总',
    '- 成功登录样本：',
    '- 缺 OpenID 样本：',
    '- 公开表单样本：',
    '- 受保护表单样本：',
    '- 群机器人样本：',
    '',
    '## 机器探针结论',
    '- 管理员联调 token：已恢复 / 未恢复',
    '- `/api/auth/me`：通过 / 失败',
    '- 用户治理接口：通过 / 失败',
    '- 目录同步接口：通过 / 失败',
    '- 审计接口：通过 / 失败',
    '',
    '## 风险与阻塞',
    '- 代码侧问题：',
    '- 环境侧问题：',
    '- 是否影响正式交付：',
    '',
    '## 最终结论',
    '- 是否允许继续放量：',
    '- 是否允许正式交付：',
    '- 下一步负责人：',
    '- 计划完成时间：',
    '',
    '## 关联文档',
    `- 142 验收执行包：dingtalk-governance-142-acceptance-package-${today}.md`,
    `- 最终交付包：dingtalk-governance-final-handoff-package-${today}.md`,
    `- 正式交付结论：dingtalk-governance-delivery-decision-${today}.md`,
    `- 对外同步模板：dingtalk-governance-stakeholder-update-template-${today}.md`,
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-acceptance-result-summary-template-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 验收结果汇总模板')
}

function exportGovernanceAcceptanceReadinessSnapshot(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 当前验收就绪快照',
    '',
    `日期：${today}`,
    '',
    '## 当前就绪判断',
    '- 代码侧：已完成主要治理与导出收口。',
    '- 机器探针：已覆盖管理员鉴权、用户治理、目录同步、审计接口、公开表单、受保护表单匿名拦截。',
    '- 真人侧：仍需完成成功样本、缺 openId 样本、受保护表单允许名单样本、群机器人消息样本。',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 已准备好的执行物',
    `- 142 验收执行包：dingtalk-governance-142-acceptance-package-${today}.md`,
    `- 真人侧验收执行单：dingtalk-governance-manual-acceptance-script-${today}.md`,
    `- 最终交付包：dingtalk-governance-final-handoff-package-${today}.md`,
    `- 验收结果汇总模板：dingtalk-governance-acceptance-result-summary-template-${today}.md`,
    '',
    '## 现场开测前检查',
    '- [ ] 本地 142 管理员 token 文件可读取',
    '- [ ] 真实 DingTalk 测试账号在手',
    '- [ ] 公开表单和受保护表单链接已准备',
    '- [ ] 群机器人测试群可观察到消息',
    '- [ ] 回填人和截图 / 日志记录位置已明确',
    '',
    '## 下一步顺序',
    '1. 先用真人侧验收执行单跑 4 项样本。',
    '2. 用验收结果汇总模板汇总结果。',
    '3. 更新正式交付结论和对外同步模板。',
    '4. 如通过，则进入上线观察记录模板阶段。',
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-acceptance-readiness-snapshot-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 当前验收就绪快照')
}

function exportGovernanceEnvironmentBlockerTemplate(): void {
  const today = formatDateInput(new Date())
  const lines = [
    '# DingTalk 环境阻塞记录模板',
    '',
    `日期：${today}`,
    '',
    '## 适用范围',
    '- 用于记录并跟踪非代码缺陷类阻塞。',
    '- 典型场景包括：钉钉授权组范围、组织范围、openId 数据缺口、真实群机器人配置、第三方波动。',
    '',
    '## 当前基线',
    `- 缺 OpenID：${governanceSummary.value.dingtalkOpenIdMissing}`,
    `- 待收口：${governanceSummary.value.dingtalkOpenIdPending}`,
    `- 已收口：${governanceSummary.value.dingtalkOpenIdGoverned}`,
    `- 目录已链接：${governanceSummary.value.directoryLinked}`,
    '',
    '## 阻塞记录',
    '- 阻塞标题：',
    '- 阻塞类型：授权组 / 组织范围 / openId 数据 / 群机器人 / 第三方波动 / 其他',
    '- 影响范围：',
    '- 复现账号 / 样本：',
    '- 现象描述：',
    '- 当前判断：',
    '- 是否影响正式交付：是 / 否',
    '',
    '## 已采取动作',
    '- 已执行检查：',
    '- 已联系对象：',
    '- 已收集证据：截图 / 日志 / 返回报文 / 配置快照',
    '',
    '## 下一步',
    '- 下一步动作：',
    '- 负责人：',
    '- 预计完成时间：',
    '- 回退方案 / 绕行方案：',
    '',
    '## 关联文档',
    `- 142 验收执行包：dingtalk-governance-142-acceptance-package-${today}.md`,
    `- 验收结果汇总模板：dingtalk-governance-acceptance-result-summary-template-${today}.md`,
    `- 最终交付包：dingtalk-governance-final-handoff-package-${today}.md`,
    '',
    '## 关键入口',
    `- 用户治理入口：${buildMissingOpenIdUserManagementLocation()}`,
    `- 目录同步入口：${buildDirectoryMissingOpenIdWorkbenchLocation()}`,
    `- 治理审计入口：${buildRecentDingTalkGovernanceAuditLocation()}`,
    '',
    '## 当前建议',
    ...governanceWorkbenchCards.value.map((card) => `- ${card.title}：${card.note}`),
  ]
  downloadText(
    `dingtalk-governance-environment-blocker-template-${today}.md`,
    lines.join('\n'),
    'text/markdown;charset=utf-8',
  )
  setStatus('已导出 DingTalk 环境阻塞记录模板')
}

function buildDingTalkGovernanceAuditLocation(): string {
  const params = new URLSearchParams({
    resourceType: 'user-auth-grant',
    action: 'revoke',
  })
  return `/admin/audit?${params.toString()}`
}

function buildMissingOpenIdUserManagementLocation(): string {
  const params = new URLSearchParams({
    filter: 'dingtalk-openid-missing',
    source: 'dingtalk-governance',
  })
  return `/admin/users?${params.toString()}`
}

function buildDirectoryMissingOpenIdWorkbenchLocation(): string {
  const params = new URLSearchParams({
    source: 'dingtalk-governance',
  })
  return `/admin/directory?${params.toString()}`
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildRecentDingTalkGovernanceAuditLocation(): string {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  const params = new URLSearchParams({
    resourceType: 'user-auth-grant',
    action: 'revoke',
    from: `${formatDateInput(start)}T00:00:00.000Z`,
    to: `${formatDateInput(end)}T23:59:59.999Z`,
  })
  return `/admin/audit?${params.toString()}`
}

watch(userListFilter, (nextFilter) => {
  if (userNavigation.value.filter === nextFilter) return
  const nextNavigation: InitialUserNavigation = {
    ...userNavigation.value,
    filter: nextFilter,
  }
  userNavigation.value = nextNavigation
  replaceUserNavigation(nextNavigation)
})

const namespaceOptions = computed(() => {
  const namespaces: string[] = []
  const append = (namespace: string): void => {
    const trimmed = namespace.trim()
    if (!trimmed || namespaces.includes(trimmed)) return
    namespaces.push(trimmed)
  }

  for (const admission of memberAdmission.value?.namespaceAdmissions || []) {
    append(admission.namespace)
  }

  for (const role of roleCatalog.value) {
    for (const permission of role.permissions) {
      const namespace = extractNamespaceFromPermission(permission)
      if (namespace) append(namespace)
    }
  }

  return namespaces
})
const userNavigation = ref(readInitialUserNavigation())
const hasDirectorySyncNavigation = computed(() => userNavigation.value.source === 'directory-sync')
const directoryReturnLocation = computed(() => buildDirectoryReturnLocation(userNavigation.value))
const directoryNavigationTargetLabel = computed(() => {
  const integrationId = userNavigation.value.integrationId.trim()
  const accountId = userNavigation.value.accountId.trim()
  if (!integrationId && !accountId) return ''
  return `目标集成：${integrationId || '未指定'} · 目标成员：${accountId || '未指定'}`
})
const directoryNavigationNotice = computed(() => {
  if (!hasDirectorySyncNavigation.value) return ''
  const failureMessage = readDirectoryFailureMessage(userNavigation.value.directoryFailure)
  if (failureMessage) {
    return `从目录同步返回用户管理，但定位未完成：${failureMessage}。请确认目录集成或成员是否仍存在。`
  }
  return '已从目录同步返回用户管理，可继续查看用户授权、钉钉身份和 openId 治理状态。'
})

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
}

function normalizeUserListFilter(value: string | null | undefined): UserListFilter {
  const candidate = String(value || '').trim()
  return USER_LIST_FILTER_VALUES.includes(candidate as UserListFilter) ? candidate as UserListFilter : 'all'
}

function readInitialUserNavigation(): InitialUserNavigation {
  if (typeof window === 'undefined') {
    return { userId: '', source: '', filter: 'all', integrationId: '', accountId: '', directoryFailure: '' }
  }
  const params = new URL(window.location.href).searchParams
  return {
    userId: params.get('userId')?.trim() || '',
    source: params.get('source')?.trim() || '',
    filter: normalizeUserListFilter(params.get('filter')),
    integrationId: params.get('integrationId')?.trim() || '',
    accountId: params.get('accountId')?.trim() || '',
    directoryFailure: params.get('directoryFailure')?.trim() || '',
  }
}

function buildUserNavigationKey(navigation: InitialUserNavigation): string {
  return [
    navigation.userId.trim(),
    navigation.source.trim(),
    navigation.filter,
    navigation.integrationId.trim(),
    navigation.accountId.trim(),
    navigation.directoryFailure.trim(),
  ].join('|')
}

function buildUserLocation(navigation: InitialUserNavigation): string {
  if (typeof window === 'undefined') return '/admin/users'
  const url = new URL(window.location.href)
  const params = new URLSearchParams()
  if (navigation.userId.trim().length > 0) params.set('userId', navigation.userId.trim())
  if (navigation.source.trim().length > 0) params.set('source', navigation.source.trim())
  if (navigation.directoryFailure.trim().length > 0) params.set('directoryFailure', navigation.directoryFailure.trim())
  if (navigation.integrationId.trim().length > 0) params.set('integrationId', navigation.integrationId.trim())
  if (navigation.accountId.trim().length > 0) params.set('accountId', navigation.accountId.trim())
  if (navigation.filter !== 'all') params.set('filter', navigation.filter)
  const search = params.toString()
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}

function buildDirectoryReturnLocation(navigation: InitialUserNavigation): string {
  if (navigation.source !== 'directory-sync') return ''
  const params = new URLSearchParams()
  if (navigation.integrationId.trim().length > 0) params.set('integrationId', navigation.integrationId.trim())
  if (navigation.accountId.trim().length > 0) params.set('accountId', navigation.accountId.trim())
  params.set('source', 'user-management')
  if (navigation.userId.trim().length > 0) params.set('userId', navigation.userId.trim())
  return `/admin/directory?${params.toString()}`
}

function readDirectoryFailureMessage(value: string): string {
  if (value === 'missing_integration') return '未找到目标目录集成'
  if (value === 'missing_account') return '未找到目标目录成员'
  if (value.trim().length > 0) return value.trim()
  return ''
}

function clearDirectoryNavigationContext(): void {
  const nextNavigation: InitialUserNavigation = {
    ...userNavigation.value,
    source: '',
    integrationId: '',
    accountId: '',
    directoryFailure: '',
  }
  userNavigation.value = nextNavigation
  replaceUserNavigation(nextNavigation)
  setStatus('已清除目录回跳上下文')
}

async function copyDirectoryReturnLocation(): Promise<void> {
  const location = directoryReturnLocation.value
  if (!location) return
  try {
    const absoluteLocation = typeof window === 'undefined'
      ? location
      : new URL(location, window.location.origin).toString()
    await navigator.clipboard.writeText(absoluteLocation)
    setStatus('目录回跳链接已复制')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '复制目录回跳链接失败', 'error')
  }
}

async function copyCurrentUserManagementLocation(): Promise<void> {
  const location = buildUserLocation(userNavigation.value)
  if (!location) return
  try {
    const absoluteLocation = typeof window === 'undefined'
      ? location
      : new URL(location, window.location.origin).toString()
    await navigator.clipboard.writeText(absoluteLocation)
    setStatus('用户治理链接已复制')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '复制用户治理链接失败', 'error')
  }
}

function replaceUserNavigation(navigation: InitialUserNavigation): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', buildUserLocation(navigation))
}

function syncUserNavigationFromLocation(): boolean {
  const next = readInitialUserNavigation()
  const currentKey = buildUserNavigationKey(userNavigation.value)
  const nextKey = buildUserNavigationKey(next)
  userNavigation.value = next
  userListFilter.value = next.filter
  return currentKey !== nextKey
}

function syncProfileDraftFromAccess(): void {
  profileDraftName.value = access.value?.user.name || ''
  profileDraftMobile.value = access.value?.user.mobile || ''
}

function extractNamespaceFromPermission(permission: string): string | null {
  const value = permission.trim()
  if (!value) return null
  const namespace = value.split(/[:/]/, 1)[0]?.trim()
  if (!namespace) return null
  return namespace
}

function reconcileSelectedUsers(): void {
  if (selectedUserIds.value.length === 0) return
  const visibleUserIdSet = new Set(visibleUsers.value.map((user) => user.id))
  selectedUserIds.value = selectedUserIds.value.filter((userId) => visibleUserIdSet.has(userId))
}

function clearSelectedUsers(): void {
  selectedUserIds.value = []
}

function selectVisibleUsers(): void {
  selectedUserIds.value = visibleUsers.value.map((user) => user.id)
}

function toggleUserSelection(userId: string, checked: boolean): void {
  if (checked) {
    if (!selectedUserIds.value.includes(userId)) {
      selectedUserIds.value = [...selectedUserIds.value, userId]
    }
    return
  }

  selectedUserIds.value = selectedUserIds.value.filter((selectedUserId) => selectedUserId !== userId)
}

function handleUserSelectionChange(userId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  toggleUserSelection(userId, target.checked)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`
}

function readDingTalkServerStatus(accessValue: DingTalkAccess | null): string {
  const reason = accessValue?.server?.unavailableReason ?? null
  if (reason === 'corp_not_allowed') {
    return '服务端企业白名单未放行当前 corpId'
  }
  if (
    reason === 'missing_client_id' ||
    reason === 'missing_client_secret' ||
    reason === 'missing_redirect_uri'
  ) {
    return '服务端钉钉 OAuth 配置不完整'
  }
  if (accessValue?.server?.available === false) {
    return '服务端钉钉登录暂不可用'
  }
  return '服务端钉钉登录可用'
}

function readDingTalkWorkNotificationStatus(accessValue: DingTalkAccess | null): string {
  const reason = accessValue?.workNotification?.unavailableReason ?? null
  if (reason === 'missing_app_key') return '钉钉工作通知缺少 DINGTALK_APP_KEY 或 DINGTALK_CLIENT_ID'
  if (reason === 'missing_app_secret') return '钉钉工作通知缺少 DINGTALK_APP_SECRET 或 DINGTALK_CLIENT_SECRET'
  if (reason === 'missing_agent_id') return '钉钉工作通知缺少 DINGTALK_AGENT_ID 或 DINGTALK_NOTIFY_AGENT_ID'
  if (accessValue?.workNotification?.available === false) return '钉钉工作通知暂不可用'
  return '钉钉工作通知可用；群机器人发送失败时可通知规则创建人'
}

function canEnableDingTalkGrant(accessValue: DingTalkAccess | null): boolean {
  if (!accessValue) return false
  if (!accessValue.identity.exists) return true
  if (!accessValue.server?.corpId) return true
  return accessValue.identity.hasOpenId
}

function shouldWarnMissingDingTalkOpenId(accessValue: DingTalkAccess | null): boolean {
  if (!accessValue?.identity.exists) return false
  if (!accessValue.server?.corpId) return false
  return !accessValue.identity.hasOpenId
}

function readPrimaryDingTalkDirectoryMembership(admissionValue: MemberAdmission | null): MemberDirectoryMembership | null {
  const membership = admissionValue?.directoryMemberships.find((item) => item.provider === 'dingtalk')
  return membership ?? null
}

function formatDirectorySyncAt(admissionValue: MemberAdmission | null): string {
  const membership = readPrimaryDingTalkDirectoryMembership(admissionValue)
  return formatDate(membership?.accountUpdatedAt)
}

function buildDirectoryManagementLocation(userId: string, membership: Pick<MemberDirectoryMembership, 'integrationId' | 'directoryAccountId'>): string {
  const params = new URLSearchParams({
    integrationId: membership.integrationId,
    accountId: membership.directoryAccountId,
    source: 'user-management',
    userId,
  })
  return `/admin/directory?${params.toString()}`
}

function normalizeNamespaceAdmissions(value: unknown): NamespaceAdmission[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = item as Record<string, unknown>
      const namespace = String(record.namespace || '').trim()
      if (!namespace) return null

      const hasRole = record.hasRole === true || record.has_role === true
      const enabled = record.enabled === true
      const effective = typeof record.effective === 'boolean' ? record.effective : enabled && hasRole
      const updatedAt = typeof record.updatedAt === 'string'
        ? record.updatedAt
        : typeof record.updated_at === 'string'
          ? record.updated_at
          : null

      return {
        namespace,
        enabled,
        effective,
        hasRole,
        updatedAt,
      }
    })
    .filter((item): item is NamespaceAdmission => item !== null)
}

function buildInviteUrl(token: string): string {
  if (createdOnboarding.value?.acceptInviteUrl) {
    try {
      const url = new URL(createdOnboarding.value.acceptInviteUrl)
      url.searchParams.set('token', token)
      return url.toString()
    } catch {
      // ignore and fall back
    }
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`
  }
  return `/accept-invite?token=${encodeURIComponent(token)}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function loadUsers(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('q', search.value)
    const pinUserId = userNavigation.value.userId.trim()
    if (pinUserId) params.set('userId', pinUserId)
    const response = await apiFetch(`/api/admin/users?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载用户失败'))
    }

    const data = payload.data as { items?: ManagedUser[] } | undefined
    users.value = Array.isArray(data?.items)
      ? data.items.map((item) => ({
          ...item,
          platformAdminEnabled: item.platformAdminEnabled ?? (item.role === 'admin' || item.is_admin),
          attendanceAdminEnabled: item.attendanceAdminEnabled ?? false,
          dingtalkLoginEnabled: item.dingtalkLoginEnabled ?? false,
          dingtalkGrantUpdatedAt: item.dingtalkGrantUpdatedAt ?? null,
          dingtalkGrantUpdatedBy: item.dingtalkGrantUpdatedBy ?? null,
          directoryLinked: item.directoryLinked ?? false,
          dingtalkIdentityExists: item.dingtalkIdentityExists ?? false,
          dingtalkHasUnionId: item.dingtalkHasUnionId ?? false,
          dingtalkHasOpenId: item.dingtalkHasOpenId ?? false,
          dingtalkOpenIdMissing: item.dingtalkOpenIdMissing ?? false,
          dingtalkCorpId: item.dingtalkCorpId ?? null,
          lastDirectorySyncAt: item.lastDirectorySyncAt ?? null,
          businessRoleCount: item.businessRoleCount ?? 0,
        }))
      : []
    reconcileSelectedUsers()

    if (!selectedUserId.value && users.value.length > 0) {
      const requestedUser = userNavigation.value.userId
        ? users.value.find((item) => item.id === userNavigation.value.userId)
        : null
      await selectUser((requestedUser || users.value[0]).id)
    } else if (userNavigation.value.userId) {
      const navigationKey = buildUserNavigationKey(userNavigation.value)
      const requestedUser = users.value.find((item) => item.id === userNavigation.value.userId)
      if (
        requestedUser
        && (selectedUserId.value !== requestedUser.id || appliedUserNavigationKey.value !== navigationKey)
      ) {
        await selectUser(requestedUser.id)
      }
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载用户失败', 'error')
  } finally {
    loading.value = false
  }
}

async function loadRoles(): Promise<void> {
  try {
    const response = await apiFetch('/api/admin/roles')
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载角色失败'))
    }

    const data = payload.data as { items?: RoleCatalogItem[] } | undefined
    roleCatalog.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载角色失败', 'error')
  }
}

async function loadAccessPresets(): Promise<void> {
  try {
    const params = new URLSearchParams()
    if (presetModeFilter.value) params.set('mode', presetModeFilter.value)
    const response = await apiFetch(`/api/admin/access-presets${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载访问预设失败'))
    }

    const data = payload.data as { items?: AccessPreset[] } | undefined
    accessPresets.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载访问预设失败', 'error')
  }
}

async function loadInviteRecords(userId?: string): Promise<void> {
  loadingInvites.value = true
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '10' })
    if (userId) params.set('userId', userId)
    const response = await apiFetch(`/api/admin/invites?${params.toString()}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载邀请记录失败'))
    }

    const data = payload.data as { items?: Array<Record<string, unknown>> } | undefined
    inviteRecords.value = Array.isArray(data?.items)
      ? data.items.map((item) => ({
          id: String(item.id || ''),
          userId: String(item.user_id || item.userId || ''),
          email: String(item.email || ''),
          userName: typeof item.user_name === 'string' ? item.user_name : typeof item.userName === 'string' ? item.userName : null,
          presetId: typeof item.preset_id === 'string' ? item.preset_id : typeof item.presetId === 'string' ? item.presetId : null,
          productMode: (item.product_mode || item.productMode || 'platform') as InviteLedgerRecord['productMode'],
          roleId: typeof item.role_id === 'string' ? item.role_id : typeof item.roleId === 'string' ? item.roleId : null,
          invitedByEmail: typeof item.invited_by_email === 'string' ? item.invited_by_email : typeof item.invitedByEmail === 'string' ? item.invitedByEmail : null,
          invitedByName: typeof item.invited_by_name === 'string' ? item.invited_by_name : typeof item.invitedByName === 'string' ? item.invitedByName : null,
          status: (item.status || 'pending') as InviteLedgerRecord['status'],
          acceptedAt: typeof item.accepted_at === 'string' ? item.accepted_at : typeof item.acceptedAt === 'string' ? item.acceptedAt : null,
          inviteToken: String(item.invite_token || item.inviteToken || ''),
          lastSentAt: String(item.last_sent_at || item.lastSentAt || item.created_at || item.createdAt || ''),
          createdAt: String(item.created_at || item.createdAt || ''),
        }))
      : []
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载邀请记录失败', 'error')
  } finally {
    loadingInvites.value = false
  }
}

async function loadUserSessions(userId?: string): Promise<void> {
  if (!userId) {
    userSessions.value = []
    return
  }

  loadingSessions.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/sessions`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载用户会话失败'))
    }

    const data = payload.data as { items?: Array<Record<string, unknown>> } | undefined
    userSessions.value = Array.isArray(data?.items)
      ? data.items.map((item) => ({
          id: String(item.id || ''),
          userId: String(item.userId || item.user_id || ''),
          issuedAt: String(item.issuedAt || item.issued_at || ''),
          expiresAt: String(item.expiresAt || item.expires_at || ''),
          lastSeenAt: String(item.lastSeenAt || item.last_seen_at || ''),
          revokedAt: typeof item.revokedAt === 'string' ? item.revokedAt : typeof item.revoked_at === 'string' ? item.revoked_at : null,
          revokedBy: typeof item.revokedBy === 'string' ? item.revokedBy : typeof item.revoked_by === 'string' ? item.revoked_by : null,
          revokeReason: typeof item.revokeReason === 'string' ? item.revokeReason : typeof item.revoke_reason === 'string' ? item.revoke_reason : null,
          ipAddress: typeof item.ipAddress === 'string' ? item.ipAddress : typeof item.ip_address === 'string' ? item.ip_address : null,
          userAgent: typeof item.userAgent === 'string' ? item.userAgent : typeof item.user_agent === 'string' ? item.user_agent : null,
        }))
      : []
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载用户会话失败', 'error')
  } finally {
    loadingSessions.value = false
  }
}

async function fetchUserAccessOrThrow(userId: string): Promise<UserAccess> {
  const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/access`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载用户权限失败'))
  }
  return payload.data as UserAccess
}

async function selectUser(userId: string): Promise<void> {
  selectedUserId.value = userId
  selectedRoleId.value = ''
  manualPassword.value = ''
  temporaryPassword.value = ''
  createdTemporaryPassword.value = ''
  dingtalkAccess.value = null
  memberAdmission.value = null
  try {
    access.value = await fetchUserAccessOrThrow(userId)
    syncProfileDraftFromAccess()
    const navigationKey = buildUserNavigationKey(userNavigation.value)
    if (userNavigation.value.userId === userId && appliedUserNavigationKey.value !== navigationKey) {
      if (userNavigation.value.source === 'directory-sync') {
        setStatus(`已从目录同步定位到用户 ${formatManagedUserLabel(access.value.user)}`)
      }
      appliedUserNavigationKey.value = navigationKey
    }
    await Promise.all([loadInviteRecords(userId), loadUserSessions(userId), loadDingTalkAccess(userId), loadMemberAdmission(userId)])
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载用户权限失败', 'error')
  }
}

async function handleUserNavigationChange(): Promise<void> {
  const navigation = userNavigation.value
  const navigationKey = buildUserNavigationKey(navigation)
  if (!navigation.userId) {
    appliedUserNavigationKey.value = navigationKey
    return
  }
  if (navigationKey && appliedUserNavigationKey.value === navigationKey && selectedUserId.value === navigation.userId) return

  if (search.value) {
    search.value = ''
    await loadUsers()
    return
  }

  const requestedUser = users.value.find((item) => item.id === navigation.userId)
  if (!requestedUser) {
    await loadUsers()
    return
  }

  await selectUser(requestedUser.id)
}

async function loadDingTalkAccess(userId?: string): Promise<void> {
  if (!userId) {
    dingtalkAccess.value = null
    return
  }

  loadingDingTalk.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/dingtalk-access`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载钉钉登录状态失败'))
    }

    dingtalkAccess.value = payload.data as DingTalkAccess
  } catch (error) {
    dingtalkAccess.value = null
    setStatus(error instanceof Error ? error.message : '加载钉钉登录状态失败', 'error')
  } finally {
    loadingDingTalk.value = false
  }
}

async function loadMemberAdmission(userId?: string): Promise<void> {
  if (!userId) {
    memberAdmission.value = null
    return
  }

  loadingAdmission.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/member-admission`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载成员准入失败'))
    }

    const data = payload.data as Record<string, unknown> | undefined
    memberAdmission.value = {
      ...(data as MemberAdmission),
      namespaceAdmissions: normalizeNamespaceAdmissions(data?.namespaceAdmissions),
    }
  } catch (error) {
    memberAdmission.value = null
    setStatus(error instanceof Error ? error.message : '加载成员准入失败', 'error')
  } finally {
    loadingAdmission.value = false
  }
}

async function refreshCurrentDetailMemberAdmissionIfNeeded(userIds: string[]): Promise<void> {
  if (!selectedUserId.value || !userIds.includes(selectedUserId.value)) return
  await loadMemberAdmission(selectedUserId.value)
}

async function updateNamespaceAdmission(admission: NamespaceAdmission, enabled: boolean): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/namespaces/${encodeURIComponent(admission.namespace)}/admission`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新插件使用准入失败'))
    }

    const data = payload.data as Record<string, unknown> | undefined
    if (data?.namespaceAdmissions !== undefined) {
      memberAdmission.value = {
        ...(memberAdmission.value as MemberAdmission),
        ...(data as MemberAdmission),
        namespaceAdmissions: normalizeNamespaceAdmissions(data.namespaceAdmissions),
      }
    } else {
      await loadMemberAdmission(access.value.user.id)
    }
    setStatus(enabled ? `已开通 ${admission.namespace} 插件使用` : `已关闭 ${admission.namespace} 插件使用`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新插件使用准入失败', 'error')
  } finally {
    busy.value = false
  }
}

async function updateDingTalkGrant(enabled: boolean): Promise<void> {
  if (!access.value) return
  if (enabled && !canEnableDingTalkGrant(dingtalkAccess.value)) {
    setStatus('当前钉钉身份缺少 openId，暂不能开通钉钉扫码；请重新同步目录或让用户完成一次钉钉 OAuth 绑定。', 'error')
    return
  }
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/dingtalk-grant`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新钉钉登录状态失败'))
    }

    dingtalkAccess.value = payload.data as DingTalkAccess
    if (memberAdmission.value) {
      memberAdmission.value = {
        ...memberAdmission.value,
        dingtalk: dingtalkAccess.value,
      }
    }
    setStatus(enabled ? '已开通该用户的钉钉扫码登录' : '已关闭该用户的钉钉扫码登录')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新钉钉登录状态失败', 'error')
  } finally {
    busy.value = false
  }
}

async function bulkUpdateDingTalkGrants(enabled: boolean): Promise<void> {
  const userIds = Array.from(new Set(selectedUserIds.value)).filter((userId) => userId.length > 0)
  if (userIds.length === 0) return

  bulkBusy.value = true
  try {
    const response = await apiFetch('/api/admin/users/dingtalk-grants/bulk', {
      method: 'POST',
      body: JSON.stringify({
        userIds,
        enabled,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '批量更新钉钉扫码失败'))
    }

    await loadUsers()
    if (selectedUserId.value && userIds.includes(selectedUserId.value)) {
      await Promise.all([
        loadDingTalkAccess(selectedUserId.value),
        loadMemberAdmission(selectedUserId.value),
      ])
    }
    setStatus(enabled ? `已批量开通 ${userIds.length} 个用户的钉钉扫码` : `已批量关闭 ${userIds.length} 个用户的钉钉扫码`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '批量更新钉钉扫码失败', 'error')
  } finally {
    bulkBusy.value = false
  }
}

async function bulkDisableMissingOpenIdDingTalkGrants(): Promise<void> {
  const userIds = screeningUsersMissingOpenIdWithGrant.value.map((user) => user.id)
  if (userIds.length === 0) {
    setStatus('当前筛选结果中没有已开通钉钉扫码的缺 OpenID 用户', 'error')
    return
  }

  bulkBusy.value = true
  try {
    const response = await apiFetch('/api/admin/users/dingtalk-grants/bulk', {
      method: 'POST',
      body: JSON.stringify({
        userIds,
        enabled: false,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '批量关闭缺 OpenID 钉钉扫码失败'))
    }

    await loadUsers()
    if (selectedUserId.value && userIds.includes(selectedUserId.value)) {
      await Promise.all([
        loadDingTalkAccess(selectedUserId.value),
        loadMemberAdmission(selectedUserId.value),
      ])
    }
    setStatus(`已批量关闭 ${userIds.length} 个缺 OpenID 用户的钉钉扫码`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '批量关闭缺 OpenID 钉钉扫码失败', 'error')
  } finally {
    bulkBusy.value = false
  }
}

async function bulkUpdateNamespaceAdmissions(enabled: boolean): Promise<void> {
  const userIds = Array.from(new Set(selectedUserIds.value)).filter((userId) => userId.length > 0)
  const namespace = selectedNamespace.value.trim()
  if (userIds.length === 0 || !namespace) return

  bulkBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/namespaces/${encodeURIComponent(namespace)}/admission/bulk`, {
      method: 'POST',
      body: JSON.stringify({
        userIds,
        enabled,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '批量更新插件使用失败'))
    }

    await loadUsers()
    await refreshCurrentDetailMemberAdmissionIfNeeded(userIds)
    setStatus(enabled ? `已批量开通 ${namespace} 插件使用` : `已批量关闭 ${namespace} 插件使用`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '批量更新插件使用失败', 'error')
  } finally {
    bulkBusy.value = false
  }
}

async function createUser(): Promise<void> {
  busy.value = true
  createdTemporaryPassword.value = ''
  createdInviteMessage.value = ''
  createdOnboarding.value = null
  try {
    const response = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: createForm.value.name,
        email: createForm.value.email,
        username: createForm.value.username || undefined,
        mobile: createForm.value.mobile || undefined,
        password: createForm.value.password || undefined,
        presetId: createForm.value.presetId || undefined,
        role: createForm.value.role || undefined,
        roleId: createForm.value.roleId || undefined,
        isActive: createForm.value.isActive,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      const errorPayload = payload.error as Record<string, unknown> | undefined
      const detailText = Array.isArray(errorPayload?.details) ? `：${(errorPayload?.details as string[]).join('；')}` : ''
      throw new Error(String(errorPayload?.message || '创建用户失败') + detailText)
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    selectedUserId.value = access.value.user.id
    createdTemporaryPassword.value = String((payload.data as Record<string, unknown>).temporaryPassword || '')
    createdOnboarding.value = ((payload.data as Record<string, unknown>).onboarding as OnboardingPacket | undefined) || null
    createdInviteMessage.value = String(createdOnboarding.value?.inviteMessage || '')
    createForm.value = {
      name: '',
      email: '',
      username: '',
      mobile: '',
      password: '',
      presetId: '',
      role: 'user',
      roleId: '',
      isActive: true,
    }
    presetModeFilter.value = ''
    await Promise.all([loadUsers(), loadInviteRecords(access.value?.user.id), loadMemberAdmission(access.value?.user.id)])
    setStatus('用户已创建')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建用户失败', 'error')
  } finally {
    busy.value = false
  }
}

async function revokeInvite(record: InviteLedgerRecord): Promise<void> {
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/invites/${encodeURIComponent(record.id)}/revoke`, {
      method: 'POST',
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '撤销邀请失败'))
    }

    await loadInviteRecords(selectedUserId.value || undefined)
    setStatus(`邀请已撤销：${record.email}`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '撤销邀请失败', 'error')
  } finally {
    busy.value = false
  }
}

async function resendInvite(record: InviteLedgerRecord): Promise<void> {
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/invites/${encodeURIComponent(record.id)}/resend`, {
      method: 'POST',
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '重发邀请失败'))
    }

    const data = payload.data as Record<string, unknown>
    createdOnboarding.value = (data.onboarding as OnboardingPacket | undefined) || null
    createdInviteMessage.value = String(createdOnboarding.value?.inviteMessage || '')
    await loadInviteRecords(selectedUserId.value || undefined)
    setStatus(`邀请已重发：${record.email}`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '重发邀请失败', 'error')
  } finally {
    busy.value = false
  }
}

async function copyInviteMessage(): Promise<void> {
  if (!createdInviteMessage.value) return
  try {
    await navigator.clipboard.writeText(createdInviteMessage.value)
    setStatus('邀请文案已复制')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '复制邀请文案失败', 'error')
  }
}

watch(selectedPreset, (preset) => {
  if (!preset) return
  createForm.value.role = preset.role
  createForm.value.roleId = preset.roleId || ''
})

watch(presetModeFilter, async () => {
  await loadAccessPresets()
  if (createForm.value.presetId && !accessPresets.value.some((preset) => preset.id === createForm.value.presetId)) {
    createForm.value.presetId = ''
  }
})

watch(namespaceOptions, (options) => {
  if (options.length === 0) {
    selectedNamespace.value = ''
    return
  }

  if (!selectedNamespace.value || !options.includes(selectedNamespace.value)) {
    selectedNamespace.value = options[0] || ''
  }
}, { immediate: true })

async function toggleUserStatus(): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !access.value.user.is_active }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新用户状态失败'))
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    await loadUsers()
    await loadMemberAdmission(access.value.user.id)
    setStatus(access.value.user.is_active ? '账号已启用' : '账号已停用')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新用户状态失败', 'error')
  } finally {
    busy.value = false
  }
}

async function resetPassword(): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({
        password: manualPassword.value || undefined,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '重置密码失败'))
    }

    temporaryPassword.value = String((payload.data as Record<string, unknown> | undefined)?.temporaryPassword || '')
    manualPassword.value = ''
    setStatus('密码已重置')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '重置密码失败', 'error')
  } finally {
    busy.value = false
  }
}

async function revokeSessions(): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/revoke-sessions`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'admin-console-force-logout' }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '强制下线失败'))
    }

    setStatus('该用户现有会话已失效')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '强制下线失败', 'error')
  } finally {
    busy.value = false
  }
}

async function revokeSingleSession(sessionId: string): Promise<void> {
  if (!access.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(access.value.user.id)}/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'admin-console-force-single-session-logout' }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '踢下线失败'))
    }

    await loadUserSessions(access.value.user.id)
    setStatus('会话已踢下线')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '踢下线失败', 'error')
  } finally {
    busy.value = false
  }
}

async function updateRole(action: 'assign' | 'unassign'): Promise<void> {
  if (!selectedUserId.value || !selectedRoleId.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(selectedUserId.value)}/roles/${action}`, {
      method: 'POST',
      body: JSON.stringify({ roleId: selectedRoleId.value }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存角色失败'))
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    await loadUsers()
    await loadMemberAdmission(selectedUserId.value)
    setStatus(action === 'assign' ? '角色已分配' : '角色已撤销')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存角色失败', 'error')
  } finally {
    busy.value = false
  }
}

async function updateNamedRole(roleId: string, enabled: boolean): Promise<void> {
  if (!selectedUserId.value) return
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(selectedUserId.value)}/roles/${enabled ? 'assign' : 'unassign'}`, {
      method: 'POST',
      body: JSON.stringify({ roleId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存管理员角色失败'))
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    await loadUsers()
    await loadMemberAdmission(selectedUserId.value)
    const label = roleId === 'admin' ? '平台管理员' : roleId === 'attendance_admin' ? '考勤管理员' : roleId
    setStatus(enabled ? `已开通${label}` : `已关闭${label}`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存管理员角色失败', 'error')
  } finally {
    busy.value = false
  }
}

async function assignRole(): Promise<void> {
  await updateRole('assign')
}

async function unassignRole(): Promise<void> {
  await updateRole('unassign')
}

async function saveUserProfile(): Promise<void> {
  if (!access.value) return
  busy.value = true
  // Snapshot the mobile we believed the server held when we rendered the
  // form; the backend uses this as a CAS witness on UPDATE so a concurrent
  // edit can't get silently overwritten.
  const baselineUserId = access.value.user.id
  const baselineMobile = access.value.user.mobile ?? null
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(baselineUserId)}/profile`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: profileDraftName.value,
        mobile: profileDraftMobile.value,
        expectedMobile: baselineMobile,
      }),
    })
    const payload = await readJson(response)
    if (response.status === 409) {
      const errorCode = (payload.error as Record<string, unknown> | undefined)?.code
      if (errorCode === 'PROFILE_MOBILE_CONFLICT') {
        try {
          const latestAccess = await fetchUserAccessOrThrow(baselineUserId)
          access.value = latestAccess
          syncProfileDraftFromAccess()
          const latest = latestAccess.user.mobile ?? null
          const latestLabel = latest === null || latest === '' ? '（空）' : latest
          setStatus(`用户手机号已被其他操作更新为 ${latestLabel}，请确认最新值后重新保存`, 'error')
        } catch {
          // If the refresh itself failed we must not advertise a stale value
          // as the "latest" — it would mislead the admin about what the
          // backend currently holds.
          setStatus('用户手机号已被其他操作更新，请刷新后重试', 'error')
        }
        return
      }
    }
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新用户资料失败'))
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    await loadUsers()
    setStatus('用户资料已更新')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新用户资料失败', 'error')
  } finally {
    busy.value = false
  }
}

const stopUserLocationSync = subscribeToLocationChanges(() => {
  if (!syncUserNavigationFromLocation()) return
  void handleUserNavigationChange()
})

onMounted(async () => {
  await Promise.all([loadRoles(), loadUsers(), loadAccessPresets(), loadInviteRecords()])
})

onUnmounted(() => {
  stopUserLocationSync()
})
</script>

<style scoped>
.user-admin {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.user-admin__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.user-admin__header h1 {
  margin: 0 0 4px;
  font-size: 24px;
}

.user-admin__header p {
  margin: 0;
  color: #6b7280;
}

.user-admin__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.user-admin__link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 600;
}

.user-admin__link:hover {
  text-decoration: underline;
}

.user-admin__search,
.user-admin__select {
  min-width: 240px;
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 12px;
}

.user-admin__button {
  height: 38px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

.user-admin__button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.user-admin__button--secondary {
  background: #475569;
}

.user-admin__hint {
  margin: 4px 0 0;
  color: #6b7280;
  font-size: 13px;
}

.user-admin__warning,
.user-admin__status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
}

.user-admin__status--error {
  background: #fef2f2;
  color: #dc2626;
}

.user-admin__source-banner {
  display: grid;
  gap: 4px;
}

.user-admin__source-banner p {
  margin: 0;
}

.user-admin__source-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.user-admin__button-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}

.user-admin__button-link:hover {
  text-decoration: none;
}

.user-admin__layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  min-height: 520px;
}

.user-admin__panel--create {
  gap: 16px;
}

.user-admin__preset,
.user-admin__invite {
  margin: 0;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f8fafc;
  color: #334155;
}

.user-admin__preset p,
.user-admin__preset small {
  margin: 4px 0 0;
  display: block;
}

.user-admin__invite {
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12px;
}

.user-admin__panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.user-admin__panel h2,
.user-admin__section h3 {
  margin: 0;
}

.user-admin__section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.user-admin__section-head--workbench {
  margin-top: 4px;
}

.user-admin__panel--detail {
  gap: 16px;
}

.user-admin__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.user-admin__workbench {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.user-admin__metric {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f8fafc;
}

.user-admin__metric-link {
  color: inherit;
  text-decoration: none;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}

.user-admin__metric-link:hover {
  border-color: #93c5fd;
  background: #eff6ff;
}

.user-admin__workbench-card {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: linear-gradient(135deg, #f8fbff, #eff6ff);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.user-admin__workbench-card:hover {
  border-color: #60a5fa;
  transform: translateY(-1px);
}

.user-admin__workbench-card strong {
  color: #111827;
}

.user-admin__workbench-card small,
.user-admin__workbench-kicker {
  color: #6b7280;
}

.user-admin__workbench-note {
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 500;
}

.user-admin__workbench-kicker {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.user-admin__metric strong {
  font-size: 18px;
  color: #111827;
}

.user-admin__metric small {
  color: #6b7280;
}

.user-admin__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.user-admin__filter {
  height: 32px;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #fff;
  color: #374151;
  padding: 0 12px;
  cursor: pointer;
}

.user-admin__filter--active {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}

.user-admin__user {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  text-align: left;
  width: 100%;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 12px;
}

.user-admin__user--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.user-admin__user-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #374151;
  font-size: 12px;
  user-select: none;
  white-space: nowrap;
}

.user-admin__user-body {
  flex: 1;
  display: grid;
  gap: 4px;
  text-align: left;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.user-admin__meta {
  color: #6b7280;
  font-size: 12px;
}

.user-admin__row-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.user-admin__row-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #f3f4f6;
  color: #374151;
  padding: 4px 8px;
  font-size: 12px;
}

.user-admin__row-badge--success {
  background: #dcfce7;
  color: #166534;
}

.user-admin__row-badge--danger {
  background: #fee2e2;
  color: #b91c1c;
}

.user-admin__row-badge--accent {
  background: #dbeafe;
  color: #1d4ed8;
}

.user-admin__row-badge--muted {
  background: #e2e8f0;
  color: #475569;
}

.user-admin__detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.user-admin__detail-head p {
  margin: 4px 0 0;
  color: #6b7280;
}

.user-admin__create-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.user-admin__bulkbar {
  display: grid;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid #dbeafe;
  background: linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%);
}

.user-admin__bulk-group {
  display: grid;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
}

.user-admin__badges,
.user-admin__chips,
.user-admin__role-actions,
.user-admin__role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.user-admin__badge,
.user-admin__chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #f3f4f6;
  color: #111827;
  padding: 4px 10px;
  font-size: 12px;
}

.user-admin__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  color: #374151;
}

.user-admin__badge--admin {
  background: #dbeafe;
  color: #1d4ed8;
}

.user-admin__badge--inactive {
  background: #fef2f2;
  color: #b91c1c;
}

.user-admin__chip--permission {
  background: #ecfeff;
  color: #155e75;
}

.user-admin__chip--success {
  background: #dcfce7;
  color: #166534;
}

.user-admin__chip--danger {
  background: #fef2f2;
  color: #b91c1c;
}

.user-admin__role-card {
  width: min(280px, 100%);
  display: grid;
  gap: 4px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
}

.user-admin__role-card span,
.user-admin__role-card small,
.user-admin__role-card p,
.user-admin__empty {
  color: #6b7280;
}

.user-admin__role-card p {
  margin: 0;
}

@media (max-width: 960px) {
  .user-admin__header,
  .user-admin__layout {
    display: grid;
    grid-template-columns: 1fr;
  }

  .user-admin__create-grid,
  .user-admin__summary,
  .user-admin__workbench {
    grid-template-columns: 1fr;
  }

  .user-admin__actions {
    flex-wrap: wrap;
  }
}
</style>

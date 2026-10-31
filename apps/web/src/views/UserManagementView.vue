<template>
  <section class="user-admin">
    <header class="user-admin__header">
      <div>
        <h1>用户管理</h1>
        <p>查看成员、邀请新用户，并在侧栏里维护资料与权限。</p>
      </div>

      <div class="user-admin__actions">
        <router-link class="user-admin__link" to="/admin/roles">角色管理</router-link>
        <router-link class="user-admin__link" to="/admin/permissions">权限管理</router-link>
        <router-link class="user-admin__link" to="/admin/directory">目录同步</router-link>
        <router-link class="user-admin__link" to="/admin/audit">管理审计</router-link>
        <button class="user-admin__button" type="button" data-testid="open-invite-user" @click="openInvite()">
          邀请用户
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
        <button class="user-admin__button user-admin__button--secondary" type="button" @click="clearDirectoryNavigationContext()">
          清除目录回跳
        </button>
      </div>
    </section>
    <div class="user-admin__tabs" role="tablist" aria-label="用户管理视图">
      <button
        class="user-admin__tab"
        :class="{ 'user-admin__tab--active': surface === 'members' }"
        type="button"
        role="tab"
        :aria-selected="surface === 'members'"
        @click="surface = 'members'"
      >
        成员
      </button>
      <button
        class="user-admin__tab"
        :class="{ 'user-admin__tab--active': surface === 'invites' }"
        type="button"
        role="tab"
        :aria-selected="surface === 'invites'"
        data-testid="pending-invites-tab"
        @click="surface = 'invites'"
      >
        待处理邀请
        <span v-if="pendingInviteCount > 0" class="user-admin__tab-count">{{ pendingInviteCount }}</span>
      </button>
    </div>

    <div v-show="surface === 'invites'" class="user-admin__panel">
      <div class="user-admin__section-head">
        <div>
          <h2>邀请记录</h2>
          <p class="user-admin__hint">待接受的邀请在这里重发或撤销。已接受、已撤销的记录可切换查看。</p>
        </div>
        <div class="user-admin__role-actions">
          <button
            class="user-admin__filter"
            :class="{ 'user-admin__filter--active': inviteStatusFilter === 'pending' }"
            type="button"
            @click="inviteStatusFilter = 'pending'"
          >
            待处理
          </button>
          <button
            class="user-admin__filter"
            :class="{ 'user-admin__filter--active': inviteStatusFilter === 'all' }"
            type="button"
            @click="inviteStatusFilter = 'all'"
          >
            全部记录
          </button>
          <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loadingInvites" @click="void loadInviteRecords(selectedUserId || undefined)">
            {{ loadingInvites ? '刷新中...' : '刷新邀请记录' }}
          </button>
        </div>
      </div>
      <div v-if="inviteRecords.length === 0" class="user-admin__empty">暂无邀请记录</div>
      <div v-else-if="visibleInviteRecords.length === 0" class="user-admin__empty">没有待处理的邀请</div>
      <div v-else class="user-admin__role-list user-admin__invite-list">
        <article v-for="record in visibleInviteRecords" :key="record.id" class="user-admin__role-card">
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
    </div>

    <div
      class="user-admin__modal"
      :class="{ 'user-admin__modal--open': inviteOpen }"
      role="dialog"
      aria-modal="true"
      aria-label="邀请用户"
      :aria-hidden="inviteOpen ? 'false' : 'true'"
    >
      <button class="user-admin__modal-backdrop" type="button" aria-label="关闭邀请" @click="closeInvite()" />
      <section class="user-admin__panel user-admin__panel--create">
        <div class="user-admin__section-head">
          <div>
            <h2>邀请用户</h2>
            <p class="user-admin__hint">一次邀请一名成员：填写邮箱和角色后创建账号。邀请文案可复制，并在「待处理邀请」里重发或撤销。</p>
            <p class="user-admin__hint">可选择自动生成临时密码，后续再在权限页补充直接权限。</p>
            <p class="user-admin__hint" data-create-user-rule="login-name">{{ createUserRuleHints.loginName }}</p>
            <p class="user-admin__hint" data-create-user-rule="password">{{ createUserRuleHints.password }}</p>
          </div>
          <button class="user-admin__button user-admin__button--secondary" type="button" @click="closeInvite()">关闭</button>
        </div>
      <div class="user-admin__create-grid">
        <input v-model.trim="createForm.name" class="user-admin__search" type="text" placeholder="姓名" />
        <input v-model.trim="createForm.email" class="user-admin__search" type="email" placeholder="邮箱（可选）" />
        <input
          v-model.trim="createForm.username"
          class="user-admin__search"
          type="text"
          placeholder="登录名（可选，小写字母/数字）"
          aria-label="登录名（可选）"
        />
        <input v-model.trim="createForm.mobile" class="user-admin__search" type="text" placeholder="手机号（可选）" />
        <input v-model.trim="createForm.employeeNo" class="user-admin__search" type="text" placeholder="员工号（可选）" />
        <input v-model.trim="createForm.department" class="user-admin__search" type="text" placeholder="部门（可选）" />
        <input v-model.trim="createForm.position" class="user-admin__search" type="text" placeholder="岗位（可选）" />
        <input v-model="createForm.hireDate" class="user-admin__search" type="date" aria-label="入职日期（可选）" />
        <select
          v-model="createForm.attendanceGroupId"
          class="user-admin__select"
          :disabled="attendanceSetupLoading || attendanceGroups.length === 0"
          aria-label="考勤组（可选）"
        >
          <option value="">考勤组（可选）</option>
          <option v-for="group in attendanceGroups" :key="group.id" :value="group.id">
            {{ group.name }}{{ group.code ? ` · ${group.code}` : '' }}
          </option>
        </select>
        <select
          v-model="createForm.defaultShiftId"
          class="user-admin__select"
          :disabled="attendanceSetupLoading || attendanceShifts.length === 0"
          aria-label="默认班次（可选）"
        >
          <option value="">默认班次（可选）</option>
          <option v-for="shift in attendanceShifts" :key="shift.id" :value="shift.id">
            {{ shift.name }}{{ formatShiftOptionTime(shift) }}
          </option>
        </select>
        <input
          v-model="createForm.defaultShiftStartDate"
          class="user-admin__search"
          type="date"
          aria-label="默认班次生效日期（可选）"
          :disabled="!createForm.defaultShiftId"
        />
        <div class="user-admin__org-field" data-create-user-org-field>
          <select
            v-model="createForm.attendanceOrgId"
            class="user-admin__select"
            :disabled="attendanceOrgOptionsLoading"
            aria-label="所属组织（可选）"
            data-create-user-org-select
          >
            <option value="">不指定组织（不写入组织归属）</option>
            <option v-for="orgId in attendanceOrgOptions" :key="orgId" :value="orgId">
              {{ orgId }}
            </option>
          </select>
          <button
            v-if="createForm.attendanceOrgId"
            class="user-admin__button user-admin__button--secondary"
            type="button"
            data-create-user-org-clear
            @click="createForm.attendanceOrgId = ''"
          >
            清除组织
          </button>
        </div>
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
      <p v-if="attendanceSetupLoadError" class="user-admin__hint">
        {{ attendanceSetupLoadError }}
      </p>
      <p class="user-admin__hint" data-create-user-org-hint>{{ attendanceOrgHint }}</p>
      <p v-if="attendanceOnboardingOrgNote" class="user-admin__hint" data-create-user-attendance-org-note>
        {{ attendanceOnboardingOrgNote }}
      </p>
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
      <div v-if="createdAttendanceOnboardingTarget" class="user-admin__preset user-admin__attendance-next" data-attendance-onboarding-next-step>
        <strong>下一步：补齐考勤配置</strong>
        <p>{{ createdAttendanceOnboardingSummary }}</p>
        <div class="user-admin__role-actions">
          <router-link
            class="user-admin__button user-admin__button--secondary user-admin__button-link"
            :to="buildAttendanceAdminSectionLocation('attendance-admin-groups')"
          >
            考勤组成员
          </router-link>
          <router-link
            class="user-admin__button user-admin__button--secondary user-admin__button-link"
            :to="buildAttendanceAdminSectionLocation('attendance-admin-assignments')"
          >
            班次分配
          </router-link>
          <router-link
            class="user-admin__button user-admin__button--secondary user-admin__button-link"
            :to="buildAttendanceAdminSectionLocation('attendance-admin-approval-flows')"
          >
            审批流
          </router-link>
        </div>
      </div>
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
        <label class="user-admin__note-label">
          <span>附言（可选）</span>
          <textarea
            v-model="inviteNote"
            class="user-admin__search user-admin__note"
            rows="3"
            placeholder="只附在复制的邀请文案末尾，不会提交到服务器"
            aria-label="邀请附言（可选）"
          />
        </label>
      </section>
    </div>

    <div v-show="surface === 'members'">
    <div class="user-admin__layout">
      <aside class="user-admin__panel">
        <div class="user-admin__toolbar">
          <input
            v-model.trim="search"
            class="user-admin__search"
            type="search"
            placeholder="搜索邮箱、用户名、手机号、姓名、员工号、部门或用户 ID"
            aria-label="搜索成员"
            @keyup.enter="void loadUsers()"
          />
          <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="loading" @click="void loadUsers()">
            {{ loading ? '加载中...' : '查询' }}
          </button>
          <select v-model="roleFilter" class="user-admin__select" aria-label="角色筛选">
            <option value="">全部角色</option>
            <option v-for="role in roleFilterOptions" :key="role" :value="role">{{ role }}</option>
          </select>
          <select v-model="accountStatusFilter" class="user-admin__select" aria-label="账号状态">
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
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
        <details class="user-admin__governance">
        <summary>治理工具</summary>
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
        </details>
        <div v-if="visibleUsers.length > 0" class="user-admin__bulkbar" :class="{ 'user-admin__bulkbar--idle': selectedUserIds.length === 0 }">
          <div>
            <strong>批量操作</strong>
            <p class="user-admin__hint">
              已选择 {{ selectedUserIds.length }} / {{ displayedUsers.length }} 个当前筛选结果。
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
        <div v-if="loading && users.length === 0" class="user-admin__empty">正在加载成员…</div>
        <div v-else-if="displayedUsers.length === 0" class="user-admin__empty">暂无用户数据</div>
        <div v-else class="user-admin__table" role="table" aria-label="成员列表">
          <div class="user-admin__table-head" role="row">
            <span role="columnheader" />
            <button type="button" role="columnheader" @click="toggleSort('name')">
              成员{{ sortMark('name') }}
            </button>
            <button type="button" role="columnheader" @click="toggleSort('role')">
              角色{{ sortMark('role') }}
            </button>
            <button type="button" role="columnheader" @click="toggleSort('status')">
              状态{{ sortMark('status') }}
            </button>
            <button type="button" role="columnheader" @click="toggleSort('lastLogin')">
              最近登录{{ sortMark('lastLogin') }}
            </button>
            <span role="columnheader" />
          </div>
        <article
          v-for="user in pagedUsers"
          :key="user.id"
          class="user-admin__user"
          :class="{ 'user-admin__user--active': selectedUserId === user.id }"
          role="row"
        >
          <label class="user-admin__user-select">
            <input
              :checked="selectedUserIdSet.has(user.id)"
              type="checkbox"
              :aria-label="`选择 ${user.name || formatManagedUserLabel(user)}`"
              @change="void handleUserSelectionChange(user.id, $event)"
            />
            <span>选择</span>
          </label>
          <button class="user-admin__user-body" type="button" @click="void openUserDetail(user.id)">
            <span class="user-admin__identity">
              <span class="user-admin__avatar" aria-hidden="true">{{ userInitials(user) }}</span>
              <span class="user-admin__identity-text">
                <strong>{{ user.name || formatManagedUserLabel(user) }}</strong>
                <span>{{ formatManagedUserIdentifier(user) }}</span>
              </span>
            </span>
            <span class="user-admin__meta">{{ user.role }}</span>
            <span class="user-admin__row-badges">
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
            </span>
            <span class="user-admin__meta">{{ formatLastLogin(user.last_login_at) }}</span>
          </button>
          <div class="user-admin__row-menu">
            <button
              type="button"
              :aria-expanded="rowMenuUserId === user.id"
              aria-haspopup="menu"
              @click="toggleRowMenu(user.id)"
            >
              操作
            </button>
            <div v-show="rowMenuUserId === user.id" class="user-admin__row-menu-panel" role="menu">
              <button type="button" role="menuitem" @click="void openUserDetail(user.id)">编辑</button>
            </div>
          </div>
          <p v-if="user.dingtalkOpenIdMissing" class="user-admin__hint">
            {{ readMissingOpenIdGovernanceHint(user) }}
          </p>
        </article>
        </div>
        <div v-if="displayedUsers.length > pageSize" class="user-admin__pager">
          <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="page <= 1" @click="page -= 1">上一页</button>
          <span>第 {{ page }} / {{ pageCount }} 页 · 共 {{ displayedUsers.length }} 人</span>
          <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="page >= pageCount" @click="page += 1">下一页</button>
        </div>
      </aside>

      <button
        v-show="detailOpen"
        class="user-admin__drawer-backdrop"
        type="button"
        aria-label="关闭用户详情"
        @click="closeUserDetail()"
      />
      <section class="user-admin__panel user-admin__panel--detail" :class="{ 'user-admin__panel--detail-open': detailOpen }">
        <template v-if="access">
          <div class="user-admin__detail-head">
            <div>
              <h2 data-testid="selected-user-heading">{{ access.user.name || formatManagedUserLabel(access.user) }}</h2>
              <p>{{ formatManagedUserIdentifier(access.user) }}</p>
              <p v-if="access.user.mobile" class="user-admin__hint">手机号：{{ access.user.mobile }}</p>
              <p v-if="profileSummaryLine" class="user-admin__hint">{{ profileSummaryLine }}</p>
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
            <button class="user-admin__button user-admin__button--secondary user-admin__detail-close" type="button" @click="closeUserDetail()">关闭</button>
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
              <input
                v-model.trim="profileDraftEmployeeNo"
                class="user-admin__search"
                type="text"
                placeholder="员工号，可留空"
              />
              <input
                v-model.trim="profileDraftDepartment"
                class="user-admin__search"
                type="text"
                placeholder="部门，可留空"
              />
              <input
                v-model.trim="profileDraftPosition"
                class="user-admin__search"
                type="text"
                placeholder="岗位，可留空"
              />
              <input
                v-model="profileDraftHireDate"
                class="user-admin__search"
                type="date"
                aria-label="入职日期，可留空"
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
            <div v-if="memberAdmissionLoadFailure" class="user-admin__block-error" data-testid="member-admission-load-failure">
              <p>成员准入信息暂时无法加载，请刷新页面后重试。</p>
              <small v-if="memberAdmissionLoadFailure.correlationId">排查编号：{{ memberAdmissionLoadFailure.correlationId }}</small>
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
            <!-- Slice B (owner ruling on #6079): read-only view of the user's active organizations, the same
                 rows the login tenant claim reads. Nothing here writes; an older backend without the field
                 renders nothing, and a disabled account is already explained by its chip above. -->
            <div v-if="memberAdmissionOrganizations" class="user-admin__org-context" data-testid="member-admission-organizations">
              <div class="user-admin__chips">
                <strong class="user-admin__org-label">所属组织</strong>
                <span
                  v-for="org in memberAdmissionOrganizations.active"
                  :key="org.orgId"
                  class="user-admin__chip"
                  :class="{ 'user-admin__chip--success': memberAdmissionOrganizations.hasTenantContext }"
                  data-testid="member-admission-org-chip"
                >
                  {{ org.orgId }}
                </span>
              </div>
              <template v-if="memberAdmissionOrganizations.active.length === 0">
                <p class="user-admin__warning" data-testid="member-admission-org-none">
                  未归属任何组织：该账号无法使用云课堂等按组织隔离的应用；请用目录管理或新建账号时的「所属组织」补齐
                </p>
                <!-- Slice C: one-click 加入默认组织 via the local-directory-account route. Shown only when the
                     backend positively says the user has no membership row at all and no applied deprovision
                     (an older backend without those two booleans keeps it hidden) and the admission on screen
                     belongs to the selected user; a disabled account never reaches this block (see
                     memberAdmissionOrganizations). -->
                <div v-if="canJoinDefaultOrg" class="user-admin__chips">
                  <button
                    class="user-admin__button"
                    type="button"
                    data-testid="join-default-org-button"
                    :disabled="joiningDefaultOrg"
                    @click="openJoinDefaultOrgConfirm"
                  >
                    {{ joiningDefaultOrg ? '加入中...' : '加入默认组织' }}
                  </button>
                </div>
                <div
                  v-if="canJoinDefaultOrg && joinDefaultOrgConfirmUserId !== null && joinDefaultOrgConfirmUserId === memberAdmission?.userId"
                  class="user-admin__confirm"
                  role="dialog"
                  aria-label="确认加入默认组织"
                  data-testid="join-default-org-confirm"
                >
                  <strong>确认将该账号加入默认组织？</strong>
                  <ol>
                    <li>会为该账号创建一条本地目录账号与链接（目录管理里可见）；</li>
                    <li>加入组织后该用户进入考勤全员名册（自动缺勤 / 年假累计 / 考勤报表 / 汇总会计入）；</li>
                    <li>用户需重新登录或刷新后，云课堂等按组织隔离的应用才可用。</li>
                  </ol>
                  <p data-testid="join-default-org-confirm-undo">此操作不能在本页撤销；撤销需运维调用目录接口归档该本地目录账号（界面暂无），归档后也不能再经本按钮加入。</p>
                  <div class="user-admin__chips">
                    <button class="user-admin__button" type="button" data-testid="join-default-org-confirm-submit" @click="void confirmJoinDefaultOrg()">
                      确认加入
                    </button>
                    <button class="user-admin__button user-admin__button--secondary" type="button" data-testid="join-default-org-confirm-cancel" @click="closeJoinDefaultOrgConfirm">
                      取消
                    </button>
                  </div>
                </div>
              </template>
              <p v-else-if="memberAdmissionOrganizations.active.length >= 2" class="user-admin__warning" data-testid="member-admission-org-multiple">
                属于多个组织：登录后需在页面顶部选择组织
              </p>
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
            <div v-else-if="memberAdmissionLoadFailure" class="user-admin__block-error" data-testid="namespace-admission-load-failure">
              <p>插件使用准入信息暂时无法加载，请刷新页面后重试。</p>
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
              <span
                class="user-admin__chip"
                data-testid="platform-admin-chip"
                :class="{ 'user-admin__chip--success': hasPlatformAdminAccess, 'user-admin__chip--danger': !hasPlatformAdminAccess }"
              >
                {{ hasPlatformAdminAccess ? '已开通平台管理员' : '未开通平台管理员' }}
              </span>
              <span
                class="user-admin__chip"
                data-testid="attendance-admin-chip"
                :class="{ 'user-admin__chip--success': hasAttendanceAdminAccess, 'user-admin__chip--danger': !hasAttendanceAdminAccess }"
              >
                {{ hasAttendanceAdminAccess ? '已开通考勤管理员' : '未开通考勤管理员' }}
              </span>
            </div>
            <div class="user-admin__role-actions">
              <button
                class="user-admin__button"
                type="button"
                data-testid="promote-platform-admin-button"
                :disabled="busy || !roleSnapshotReady || hasPlatformAdminAccess"
                @click="void updateNamedRole('admin', true)"
              >
                提升为平台管理员
              </button>
              <button
                class="user-admin__button user-admin__button--secondary"
                type="button"
                data-testid="revoke-platform-admin-button"
                :disabled="busy || !roleSnapshotReady || !hasPlatformAdminAccess"
                @click="void updateNamedRole('admin', false)"
              >
                取消平台管理员
              </button>
              <button
                class="user-admin__button"
                type="button"
                data-testid="enable-attendance-admin-button"
                :disabled="busy || !roleSnapshotReady || hasAttendanceAdminAccess"
                @click="void updateNamedRole('attendance_admin', true)"
              >
                开通考勤管理员
              </button>
              <button
                class="user-admin__button user-admin__button--secondary"
                type="button"
                data-testid="disable-attendance-admin-button"
                :disabled="busy || !roleSnapshotReady || !hasAttendanceAdminAccess"
                @click="void updateNamedRole('attendance_admin', false)"
              >
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
            <div v-if="dingtalkAccessLoadFailure" class="user-admin__block-error" data-testid="dingtalk-access-load-failure">
              <p>钉钉扫码登录信息暂时无法加载，请刷新页面后重试。</p>
              <small v-if="dingtalkAccessLoadFailure.correlationId">排查编号：{{ dingtalkAccessLoadFailure.correlationId }}</small>
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
              当前钉钉身份缺少 openId：暂时拿不到该成员的 openId，暂不能开通钉钉扫码。
            </p>
            <p v-if="shouldWarnMissingDingTalkOpenId(dingtalkAccess)" class="user-admin__hint">
              修复建议：确认账号已激活并已绑定钉钉身份 → 让成员用钉钉扫码登录一次（登录会补齐 openId）→ 刷新本页后再开通钉钉扫码。
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

          <div class="user-admin__section user-admin__section--danger">
            <h3>账号操作</h3>
            <p class="user-admin__hint">停用、重置密码和全部下线会影响该用户的现有会话，与上方的资料、角色分开操作。</p>
            <div class="user-admin__role-actions">
              <button class="user-admin__button" type="button" :disabled="busy" @click="void toggleUserStatus()">
                {{ access.user.is_active ? '停用账号' : '启用账号' }}
              </button>
              <input
                v-model.trim="manualPassword"
                class="user-admin__search"
                type="text"
                placeholder="可选：设置临时密码"
                data-testid="admin-temporary-password"
                aria-label="临时密码"
                :aria-invalid="passwordResetInlineError ? 'true' : 'false'"
                :aria-describedby="passwordResetInlineError ? 'admin-temporary-password-rule admin-temporary-password-error' : 'admin-temporary-password-rule'"
              />
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy" @click="void resetPassword()">
                重置密码
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" :disabled="busy" @click="void revokeSessions()">
                全部下线
              </button>
            </div>
            <p id="admin-temporary-password-rule" data-testid="admin-temporary-password-rule" class="user-admin__hint">
              {{ adminTemporaryPasswordRuleHint }}
            </p>
            <p
              v-if="passwordResetInlineError"
              id="admin-temporary-password-error"
              data-testid="admin-temporary-password-error"
              class="user-admin__status user-admin__status--error"
              role="alert"
            >
              {{ passwordResetInlineError }}
            </p>
            <p class="user-admin__hint">重置密码或停用账号会让该用户的现有会话失效。</p>
            <p v-if="temporaryPassword" class="user-admin__status" data-testid="admin-reset-temporary-password">
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
              <select v-model="selectedRoleId" class="user-admin__select" data-testid="user-role-select" aria-label="选择要分配或撤销的角色">
                <option value="">请选择角色</option>
                <option v-for="role in roleCatalog" :key="role.id" :value="role.id">
                  {{ role.name }} ({{ role.id }})
                </option>
              </select>
              <button class="user-admin__button" type="button" data-testid="assign-role-button" :disabled="busy || !roleSnapshotReady || !selectedRoleId" @click="void assignRole()">
                分配角色
              </button>
              <button class="user-admin__button user-admin__button--secondary" type="button" data-testid="unassign-role-button" :disabled="busy || !roleSnapshotReady || !selectedRoleId" @click="void unassignRole()">
                撤销角色
              </button>
            </div>
            <p data-testid="selected-role-membership" class="user-admin__hint">{{ selectedRoleMembership.text }}</p>
            <p
              v-if="roleActionFeedback"
              data-testid="role-action-feedback"
              class="user-admin__status"
              :class="{ 'user-admin__status--error': roleActionFeedback.tone === 'error' }"
              aria-live="polite"
            >
              {{ roleActionFeedback.message }}
            </p>
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

        <div v-else-if="selectedUserId" class="user-admin__empty" data-testid="user-access-unread">
          该用户的访问快照未读，不能把上一名用户的角色或空列表当作当前状态。
        </div>
        <div v-else class="user-admin__empty">
          请选择一个用户查看访问详情
        </div>
      </section>
    </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { copyText } from '../utils/clipboard'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'
import { subscribeToLocationChanges } from '../utils/browserLocation'
import { describeCreateUserError, getCreateUserRuleHints } from '../utils/createUserValidationCopy'
import {
  accessReadStillCurrent,
  describeRoleMembershipWrite,
  nextAccessReadGeneration,
  roleWriteOutcomeFromPayload,
  selectedRoleMembershipHint,
  userAccessSnapshotMatches,
  type RoleMembershipSnapshot,
  type RoleMembershipWriteOutcome,
} from './adminUserRoleAction'
import {
  ADMIN_TEMPORARY_PASSWORD_RULE_HINT,
  ADMIN_TEMPORARY_PASSWORD_TOO_SHORT,
  classifyManualTemporaryPassword,
  describeAdminResetPasswordInlineError,
} from './adminTemporaryPasswordFeedback'

type ManagedUser = {
  id: string
  email: string | null
  username?: string | null
  name: string | null
  mobile?: string | null
  employeeNo?: string | null
  department?: string | null
  position?: string | null
  hireDate?: string | null
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
  /**
   * null = render nothing: the field is absent (older backend), the server sent null (its
   * user_orgs read failed, "unknown"), or the payload is malformed.
   */
  organizations: MemberOrganizations | null
}

type MemberOrganizations = {
  active: Array<{ orgId: string }>
  /** Mirrors the no-hint login rule (exactly one active row); a login carrying a stored tenant hint takes another branch. */
  hasTenantContext: boolean
  /**
   * Slice C: whether the user has ANY user_orgs row (active or not) / any applied deprovision event.
   * null = unknown (an older backend without the field, the server sent null because that read failed
   * (#6389), or a non-boolean value); unknown never shows
   * the 加入默认组织 button.
   */
  hasAnyRow: boolean | null
  deprovisionApplied: boolean | null
}

type NamespaceAdmission = {
  namespace: string
  enabled: boolean
  effective: boolean
  hasRole: boolean
  updatedAt: string | null
}

type SidePanelLoadFailure = {
  correlationId: string | null
}

type CreateUserForm = {
  name: string
  email: string
  username: string
  mobile: string
  employeeNo: string
  department: string
  position: string
  hireDate: string
  attendanceGroupId: string
  defaultShiftId: string
  defaultShiftStartDate: string
  attendanceOrgId: string
  password: string
  presetId: string
  role: string
  roleId: string
  isActive: boolean
}

type AttendanceGroupOption = {
  id: string
  name: string
  code: string
  /** The org the group belongs to, as the group list reports it; '' when the payload has none. */
  orgId: string
}

type AttendanceShiftOption = {
  id: string
  name: string
  workStartTime: string
  workEndTime: string
  /** The org the shift belongs to, as the shift list reports it; '' when the payload has none. */
  orgId: string
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

type AttendanceOnboardingTarget = {
  id: string
  name: string
  employeeNo: string
  department: string
  position: string
  hireDate: string
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
const attendanceSetupLoading = ref(false)
const bulkBusy = ref(false)
const busy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const surface = ref<'members' | 'invites'>('members')
const inviteOpen = ref(false)
const inviteNote = ref('')
const inviteStatusFilter = ref<'pending' | 'all'>('pending')
const detailOpen = ref(false)
const rowMenuUserId = ref('')
const roleFilter = ref('')
const accountStatusFilter = ref<'' | 'active' | 'inactive'>('')
const sortKey = ref<'' | 'name' | 'role' | 'status' | 'lastLogin'>('')
const sortDir = ref<'asc' | 'desc'>('asc')
const page = ref(1)
const pageSize = 20
const users = ref<ManagedUser[]>([])
const selectedUserIds = ref<string[]>([])
const userListFilter = ref<UserListFilter>(readInitialUserNavigation().filter)
const roleCatalog = ref<RoleCatalogItem[]>([])
const accessPresets = ref<AccessPreset[]>([])
const attendanceGroups = ref<AttendanceGroupOption[]>([])
const attendanceShifts = ref<AttendanceShiftOption[]>([])
const attendanceSetupLoadError = ref('')
// W1-6 (owner ruling 2026-10-10): the create form's org selector. Options come from the EXISTING
// read endpoint GET /api/auth/session-orgs (the signed-in admin's own active memberships). The
// selector is never pre-filled -- not even with a single option -- and an empty choice sends no
// `attendanceOrgId`, so no org membership is written. The server still validates the chosen org
// against an existing org anchor (404 ATTENDANCE_ORG_NOT_FOUND otherwise).
const attendanceOrgOptions = ref<string[]>([])
const attendanceOrgOptionsLoading = ref(false)
const attendanceOrgOptionsFailed = ref(false)
const presetModeFilter = ref<'' | 'platform' | 'attendance' | 'plm-workbench'>('')
const selectedNamespace = ref('')
const selectedUserId = ref('')
const userAccessReadGeneration = ref(0)
const selectedRoleId = ref('')
const roleActionFeedback = ref<{ tone: 'info' | 'error'; message: string } | null>(null)
const manualPassword = ref('')
const passwordResetInlineError = ref('')
const adminTemporaryPasswordRuleHint = ADMIN_TEMPORARY_PASSWORD_RULE_HINT
const temporaryPassword = ref('')
const createdTemporaryPassword = ref('')
const createdInviteMessage = ref('')
const createdOnboarding = ref<OnboardingPacket | null>(null)
const createdAttendanceOnboardingTarget = ref<AttendanceOnboardingTarget | null>(null)
const inviteRecords = ref<InviteLedgerRecord[]>([])
const userSessions = ref<UserSessionRecord[]>([])
const access = ref<UserAccess | null>(null)
const selectedRoleMembership = computed(() => selectedRoleMembershipHint(selectedRoleId.value, access.value?.roles || []))
const dingtalkAccess = ref<DingTalkAccess | null>(null)
const memberAdmission = ref<MemberAdmission | null>(null)
// Hidden for a disabled account: the server reads memberships with the login predicate
// (u.is_active = true), so a disabled account always reads as "no organization", which would
// send the admin to add memberships it may already have.
const memberAdmissionOrganizations = computed<MemberOrganizations | null>(() => {
  const admission = memberAdmission.value
  if (!admission || !admission.accountEnabled) return null
  return admission.organizations ?? null
})
// Slice C: every condition must be positively known; the server re-checks them (409) anyway. "No active
// organization" is enforced by the template: the button lives only inside the active.length === 0 branch.
const canJoinDefaultOrg = computed<boolean>(() => {
  const organizations = memberAdmissionOrganizations.value
  if (!organizations) return false
  // The admission on screen must be the selected user's (the header and the POST both follow the selection).
  if (memberAdmission.value?.userId !== selectedUserId.value) return false
  return organizations.hasAnyRow === false
    && organizations.deprovisionApplied === false
})
// Users whose join request is in flight; only the one on screen shows 加入中....
const joiningDefaultOrgUserIds = ref<string[]>([])
const joiningDefaultOrg = computed<boolean>(() => {
  const userId = memberAdmission.value?.userId
  return typeof userId === 'string' && joiningDefaultOrgUserIds.value.includes(userId)
})
// The user the confirm panel was opened for; the panel only renders while that user's admission is shown.
const joinDefaultOrgConfirmUserId = ref<string | null>(null)
// #6163: a failed load of these two side-panel reads is shown inside its own block, with this page's
// sentence and (when the server sent one) the request's correlation id — never in the top banner and
// never with the server's error text.
const dingtalkAccessLoadFailure = ref<SidePanelLoadFailure | null>(null)
const memberAdmissionLoadFailure = ref<SidePanelLoadFailure | null>(null)
const profileDraftName = ref('')
const profileDraftMobile = ref('')
const profileDraftEmployeeNo = ref('')
const profileDraftDepartment = ref('')
const profileDraftPosition = ref('')
const profileDraftHireDate = ref('')
const appliedUserNavigationKey = ref('')
const createUserRuleHints = getCreateUserRuleHints('zh')
const createForm = ref<CreateUserForm>({
  name: '',
  email: '',
  username: '',
  mobile: '',
  employeeNo: '',
  department: '',
  position: '',
  hireDate: '',
  attendanceGroupId: '',
  defaultShiftId: '',
  defaultShiftStartDate: '',
  attendanceOrgId: '',
  password: '',
  presetId: '',
  role: 'user',
  roleId: '',
  isActive: true,
})
const selectedPreset = computed(() => accessPresets.value.find((preset) => preset.id === createForm.value.presetId) || null)
const attendanceOrgHint = computed(() => {
  if (attendanceOrgOptionsFailed.value) return '组织列表暂不可用；不指定组织时不会写入组织归属。'
  if (!attendanceOrgOptionsLoading.value && attendanceOrgOptions.value.length === 0) {
    return '当前账号没有可选的组织；不指定组织时不会写入组织归属。'
  }
  return '所属组织：选择后新用户会加入该组织；不指定则不写入组织归属。'
})
// W1-6 (owner ruling 2026-10-10, "顺带显示考勤组所属组织"): when an attendance group or default shift is
// picked, the create route's existing group/shift branch (unchanged) writes the new user's org
// membership into the org that group / shift belongs to -- it looks the group / shift up inside that
// org and refuses the create otherwise. Say which org that is, from the group / shift list's own
// `orgId`. Display only: the value is never copied into `createForm.attendanceOrgId`, so nothing is
// sent that the admin did not pick. If a picked item's org is unknown, say nothing rather than guess.
const attendanceOnboardingOrgNote = computed(() => {
  const { attendanceGroupId, defaultShiftId, attendanceOrgId } = createForm.value
  if (!attendanceGroupId && !defaultShiftId) return ''
  const groupOrgId = attendanceGroupId
    ? attendanceGroups.value.find((group) => group.id === attendanceGroupId)?.orgId ?? ''
    : ''
  const shiftOrgId = defaultShiftId
    ? attendanceShifts.value.find((shift) => shift.id === defaultShiftId)?.orgId ?? ''
    : ''
  if ((attendanceGroupId && !groupOrgId) || (defaultShiftId && !shiftOrgId)) return ''
  if (groupOrgId && shiftOrgId && groupOrgId !== shiftOrgId) {
    return '所选考勤组和默认班次属于不同的组织，创建会被拒绝；请改选其中之一。'
  }
  const onboardingOrgId = groupOrgId || shiftOrgId
  const source = attendanceGroupId && defaultShiftId
    ? '所选考勤组和默认班次'
    : attendanceGroupId ? '所选考勤组' : '所选默认班次'
  if (attendanceOrgId && attendanceOrgId !== onboardingOrgId) {
    return `${source}属于组织 ${onboardingOrgId}，与上面选择的组织不一致，创建会被拒绝；请改选组织或清除组织。`
  }
  return `新用户将加入组织 ${onboardingOrgId}（${source}所属的组织）。`
})
const createdAttendanceOnboardingSummary = computed(() => {
  const target = createdAttendanceOnboardingTarget.value
  if (!target) return ''
  const details = [
    target.employeeNo ? `员工号 ${target.employeeNo}` : '',
    target.department || '',
    target.position || '',
    target.hireDate ? `入职 ${target.hireDate}` : '',
  ].filter(Boolean)
  return details.length > 0
    ? `${target.name || target.id} · ${details.join(' · ')}`
    : `${target.name || target.id}`
})
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
const roleFilterOptions = computed(() => {
  const roles = new Set<string>()
  for (const user of users.value) {
    if (user.role) roles.add(user.role)
  }
  return [...roles].sort((left, right) => left.localeCompare(right, 'zh'))
})
const displayedUsers = computed(() => {
  let rows = visibleUsers.value
  if (roleFilter.value) rows = rows.filter((user) => user.role === roleFilter.value)
  if (accountStatusFilter.value === 'active') rows = rows.filter((user) => user.is_active)
  if (accountStatusFilter.value === 'inactive') rows = rows.filter((user) => !user.is_active)
  if (!sortKey.value) return rows
  const direction = sortDir.value === 'asc' ? 1 : -1
  const valueOf = (user: ManagedUser): string => {
    if (sortKey.value === 'name') return user.name || formatManagedUserLabel(user)
    if (sortKey.value === 'role') return user.role || ''
    if (sortKey.value === 'status') return user.is_active ? '0' : '1'
    return user.last_login_at || ''
  }
  return [...rows].sort((left, right) => valueOf(left).localeCompare(valueOf(right), 'zh') * direction)
})
const pageCount = computed(() => Math.max(1, Math.ceil(displayedUsers.value.length / pageSize)))
const pagedUsers = computed(() => {
  const current = Math.min(page.value, pageCount.value)
  const start = (current - 1) * pageSize
  return displayedUsers.value.slice(start, start + pageSize)
})
const pendingInviteCount = computed(() => inviteRecords.value.filter((record) => record.status === 'pending').length)
const visibleInviteRecords = computed(() => {
  if (inviteStatusFilter.value === 'all') return inviteRecords.value
  return inviteRecords.value.filter((record) => record.status === 'pending' || record.status === 'expired')
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
const roleSnapshotReady = computed(() => userAccessSnapshotMatches(access.value, selectedUserId.value))
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
  return profileDraftName.value !== (access.value.user.name || '')
    || profileDraftMobile.value !== (access.value.user.mobile || '')
    || profileDraftEmployeeNo.value !== (access.value.user.employeeNo || '')
    || profileDraftDepartment.value !== (access.value.user.department || '')
    || profileDraftPosition.value !== (access.value.user.position || '')
    || profileDraftHireDate.value !== (access.value.user.hireDate || '')
})

const profileSummaryLine = computed(() => {
  const user = access.value?.user
  if (!user) return ''
  const parts = [
    user.employeeNo ? `员工号：${user.employeeNo}` : '',
    user.department ? `部门：${user.department}` : '',
    user.position ? `岗位：${user.position}` : '',
    user.hireDate ? `入职：${user.hireDate}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
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
    '- [ ] 成员用钉钉扫码登录一次后已补齐 openId（目录同步本身不返回 openId）/ 或确认仍缺失原因',
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
    '- [ ] 成员用钉钉扫码登录一次后，目录同步页刷新可见 openId 已补齐 / 或确认仍缺失原因',
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
  profileDraftEmployeeNo.value = access.value?.user.employeeNo || ''
  profileDraftDepartment.value = access.value?.user.department || ''
  profileDraftPosition.value = access.value?.user.position || ''
  profileDraftHireDate.value = access.value?.user.hireDate || ''
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
  selectedUserIds.value = displayedUsers.value.map((user) => user.id)
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

function userInitials(user: ManagedUser): string {
  const source = (user.name || user.email || user.username || '?').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]?.charAt(0) || ''}${parts[1]?.charAt(0) || ''}`.toUpperCase()
  return source.slice(0, 1).toUpperCase()
}

function formatLastLogin(value: string | null | undefined): string {
  if (!value) return '从未登录'
  return formatDate(value)
}

function sortMark(key: 'name' | 'role' | 'status' | 'lastLogin'): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ↑' : ' ↓'
}

function toggleSort(key: 'name' | 'role' | 'status' | 'lastLogin'): void {
  page.value = 1
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDir.value = 'asc'
    return
  }
  sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
}

function toggleRowMenu(userId: string): void {
  rowMenuUserId.value = rowMenuUserId.value === userId ? '' : userId
}

function openInvite(): void {
  inviteOpen.value = true
  surface.value = 'members'
}

function closeInvite(): void {
  inviteOpen.value = false
}

function closeUserDetail(): void {
  detailOpen.value = false
  rowMenuUserId.value = ''
}

async function openUserDetail(userId: string): Promise<void> {
  detailOpen.value = true
  rowMenuUserId.value = ''
  surface.value = 'members'
  if (selectedUserId.value === userId && access.value?.user.id === userId) return
  await selectUser(userId)
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

// Any shape problem makes the whole field "unknown" (null, render nothing) rather than dropping the
// bad items: dropping them could turn a list of unreadable ids into an empty list, and the empty
// list tells the admin 「未归属任何组织」, which would be a claim the payload does not support.
function normalizeMemberOrganizations(value: unknown): MemberOrganizations | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.active) || typeof record.hasTenantContext !== 'boolean') return null
  const active: Array<{ orgId: string }> = []
  for (const item of record.active) {
    const orgId = item && typeof item === 'object' ? (item as Record<string, unknown>).orgId : null
    if (typeof orgId !== 'string' || !orgId.trim()) return null
    active.push({ orgId: orgId.trim() })
  }
  return {
    active,
    hasTenantContext: record.hasTenantContext,
    hasAnyRow: typeof record.hasAnyRow === 'boolean' ? record.hasAnyRow : null,
    deprovisionApplied: typeof record.deprovisionApplied === 'boolean' ? record.deprovisionApplied : null,
  }
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

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The only thing this page takes from a failed side-panel read's body: `error.correlationId`, and
 * only when it has the shape the backend's correlation middleware gives it. The error text is never
 * read (#6163).
 */
function readSidePanelLoadFailure(payload: Record<string, unknown>): SidePanelLoadFailure {
  const error = payload.error
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>).correlationId : undefined
  return {
    correlationId: typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate) ? candidate : null,
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function firstOptionalString(...values: unknown[]): string {
  for (const value of values) {
    const text = readOptionalString(value)
    if (text) return text
  }
  return ''
}

function normalizeAttendanceGroupOptions(payload: Record<string, unknown>): AttendanceGroupOption[] {
  const data = payload.data as { items?: Array<Record<string, unknown>> } | undefined
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .map((item) => ({
      id: readOptionalString(item.id),
      name: firstOptionalString(item.name, item.code, item.id),
      code: readOptionalString(item.code),
      orgId: firstOptionalString(item.orgId, item.org_id),
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0)
}

function normalizeAttendanceShiftOptions(payload: Record<string, unknown>): AttendanceShiftOption[] {
  const data = payload.data as { items?: Array<Record<string, unknown>> } | undefined
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .map((item) => ({
      id: readOptionalString(item.id),
      name: firstOptionalString(item.name, item.id),
      workStartTime: firstOptionalString(item.workStartTime, item.work_start_time),
      workEndTime: firstOptionalString(item.workEndTime, item.work_end_time),
      orgId: firstOptionalString(item.orgId, item.org_id),
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0)
}

function formatShiftOptionTime(shift: AttendanceShiftOption): string {
  if (!shift.workStartTime || !shift.workEndTime) return ''
  return ` · ${shift.workStartTime}-${shift.workEndTime}`
}

async function loadAttendanceOnboardingOptions(): Promise<void> {
  attendanceSetupLoading.value = true
  attendanceSetupLoadError.value = ''
  try {
    const [groupsResponse, shiftsResponse] = await Promise.all([
      apiFetch('/api/attendance/groups?page=1&pageSize=100'),
      apiFetch('/api/attendance/shifts?page=1&pageSize=100'),
    ])
    const [groupsPayload, shiftsPayload] = await Promise.all([
      readJson(groupsResponse),
      readJson(shiftsResponse),
    ])
    if (!groupsResponse.ok || groupsPayload.ok !== true) {
      throw new Error(String((groupsPayload.error as Record<string, unknown> | undefined)?.message || '加载考勤组失败'))
    }
    if (!shiftsResponse.ok || shiftsPayload.ok !== true) {
      throw new Error(String((shiftsPayload.error as Record<string, unknown> | undefined)?.message || '加载班次失败'))
    }

    attendanceGroups.value = normalizeAttendanceGroupOptions(groupsPayload)
    attendanceShifts.value = normalizeAttendanceShiftOptions(shiftsPayload)
  } catch {
    attendanceGroups.value = []
    attendanceShifts.value = []
    attendanceSetupLoadError.value = '考勤配置选项暂不可用，可创建后从下一步进入考勤管理配置。'
  } finally {
    attendanceSetupLoading.value = false
  }
}

function normalizeAttendanceOrgOptions(payload: Record<string, unknown>): string[] | null {
  if (payload.success !== true) return null
  const data = payload.data as Record<string, unknown> | undefined
  const orgs = data?.orgs
  if (!Array.isArray(orgs)) return null
  const normalized = orgs.filter((orgId): orgId is string => typeof orgId === 'string' && orgId.trim().length > 0)
  return Array.from(new Set(normalized))
}

async function loadAttendanceOrgOptions(): Promise<void> {
  attendanceOrgOptionsLoading.value = true
  attendanceOrgOptionsFailed.value = false
  try {
    const response = await apiFetch('/api/auth/session-orgs')
    const payload = await readJson(response)
    const options = response.ok ? normalizeAttendanceOrgOptions(payload) : null
    if (!options) throw new Error('SESSION_ORGS_UNAVAILABLE')
    attendanceOrgOptions.value = options
  } catch {
    attendanceOrgOptions.value = []
    attendanceOrgOptionsFailed.value = true
  } finally {
    // Loaded once at mount; the response's currentOrgId is deliberately ignored (never a default).
    attendanceOrgOptionsLoading.value = false
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
      if (requestedUser) detailOpen.value = true
      await selectUser((requestedUser || users.value[0]).id)
    } else if (userNavigation.value.userId) {
      const navigationKey = buildUserNavigationKey(userNavigation.value)
      const requestedUser = users.value.find((item) => item.id === userNavigation.value.userId)
      if (
        requestedUser
        && (selectedUserId.value !== requestedUser.id || appliedUserNavigationKey.value !== navigationKey)
      ) {
        detailOpen.value = true
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
    if (userId && userId !== selectedUserId.value) return
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
    if (userId && userId !== selectedUserId.value) return
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
    if (userId !== selectedUserId.value) return
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
    if (userId !== selectedUserId.value) return
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
  const generation = nextAccessReadGeneration(userAccessReadGeneration.value)
  userAccessReadGeneration.value = generation
  selectedUserId.value = userId
  selectedRoleId.value = ''
  roleActionFeedback.value = null
  manualPassword.value = ''
  passwordResetInlineError.value = ''
  temporaryPassword.value = ''
  createdTemporaryPassword.value = ''
  dingtalkAccess.value = null
  memberAdmission.value = null
  dingtalkAccessLoadFailure.value = null
  memberAdmissionLoadFailure.value = null
  access.value = null
  try {
    const snapshot = await fetchUserAccessOrThrow(userId)
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    if (!userAccessSnapshotMatches(snapshot, userId)) {
      setStatus('用户访问快照与当前选择不一致，未覆盖角色状态', 'error')
      return
    }
    access.value = snapshot
    syncProfileDraftFromAccess()
    const navigationKey = buildUserNavigationKey(userNavigation.value)
    if (userNavigation.value.userId === userId && appliedUserNavigationKey.value !== navigationKey) {
      if (userNavigation.value.source === 'directory-sync') {
        setStatus(`已从目录同步定位到用户 ${formatManagedUserLabel(access.value.user)}`)
      }
      appliedUserNavigationKey.value = navigationKey
    }
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    await Promise.all([loadInviteRecords(userId), loadUserSessions(userId), loadDingTalkAccess(userId), loadMemberAdmission(userId)])
  } catch (error) {
    if (!accessReadStillCurrent(generation, userAccessReadGeneration.value, userId, selectedUserId.value)) return
    access.value = null
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

  detailOpen.value = true
  await selectUser(requestedUser.id)
}

async function loadDingTalkAccess(userId?: string): Promise<void> {
  if (!userId) {
    dingtalkAccess.value = null
    dingtalkAccessLoadFailure.value = null
    return
  }

  loadingDingTalk.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/dingtalk-access`)
    const payload = await readJson(response)
    if (userId !== selectedUserId.value) return
    if (!response.ok || payload.ok !== true) {
      dingtalkAccess.value = null
      dingtalkAccessLoadFailure.value = readSidePanelLoadFailure(payload)
      return
    }

    dingtalkAccess.value = payload.data as DingTalkAccess
    dingtalkAccessLoadFailure.value = null
  } catch {
    if (userId !== selectedUserId.value) return
    dingtalkAccess.value = null
    dingtalkAccessLoadFailure.value = { correlationId: null }
  } finally {
    loadingDingTalk.value = false
  }
}

async function loadMemberAdmission(userId?: string): Promise<void> {
  if (!userId) {
    memberAdmission.value = null
    memberAdmissionLoadFailure.value = null
    return
  }

  loadingAdmission.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/member-admission`)
    const payload = await readJson(response)
    // A late answer for a user who is no longer selected must not overwrite the selected user's panel.
    if (userId !== selectedUserId.value) return
    if (!response.ok || payload.ok !== true) {
      memberAdmission.value = null
      memberAdmissionLoadFailure.value = readSidePanelLoadFailure(payload)
      return
    }

    const data = payload.data as Record<string, unknown> | undefined
    memberAdmission.value = {
      ...(data as MemberAdmission),
      namespaceAdmissions: normalizeNamespaceAdmissions(data?.namespaceAdmissions),
      organizations: normalizeMemberOrganizations(data?.organizations),
    }
    memberAdmissionLoadFailure.value = null
  } catch {
    if (userId !== selectedUserId.value) return
    memberAdmission.value = null
    memberAdmissionLoadFailure.value = { correlationId: null }
  } finally {
    loadingAdmission.value = false
  }
}

// Slice C: the 409 codes POST /api/admin/directory/local/accounts can answer with, in this page's words.
// The server's message text is never shown (values-free UI); any other failure gets the generic sentence.
const JOIN_DEFAULT_ORG_FAILURE = '加入默认组织失败，请稍后重试'
const JOIN_DEFAULT_ORG_CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  // createLocalAccount: an account already exists for this user in this org, or the user is inactive.
  DIRECTORY_LOCAL_CONFLICT: '该账号已有本地目录账号或已停用，不能再加入默认组织；请到目录管理查看',
  // Guard added by #6389: any user_orgs row (active or not, any org) or an applied deprovision event.
  DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY: '该账号在默认组织已有归属记录或离职记录，不能从本页加入；活跃归属无需处理，停用归属或离职记录请按目录管理 / 离职证据流程处理。',
}

// The route answers 404 DIRECTORY_LOCAL_NOT_FOUND when the platform user no longer exists.
const JOIN_DEFAULT_ORG_USER_GONE = '该账号已不存在，请刷新列表'

type JoinDefaultOrgResult = { ok: true } | { ok: false; status: number; code: string | null }

async function postJoinDefaultOrg(userId: string): Promise<JoinDefaultOrgResult> {
  const response = await apiFetch('/api/admin/directory/local/accounts', {
    method: 'POST',
    body: JSON.stringify({ localUserId: userId }),
  })
  const payload = await readJson(response)
  if (response.ok && payload.ok === true) {
    const data = payload.data
    const account = data && typeof data === 'object' ? (data as Record<string, unknown>).account : null
    if (account && typeof account === 'object' && typeof (account as Record<string, unknown>).id === 'string') {
      return { ok: true }
    }
    return { ok: false, status: response.status, code: null }
  }
  const error = payload.error
  const code = error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined
  return { ok: false, status: response.status, code: typeof code === 'string' ? code : null }
}

function describeJoinDefaultOrgFailure(result: { status: number; code: string | null }): string {
  if (result.status === 409 && result.code && Object.prototype.hasOwnProperty.call(JOIN_DEFAULT_ORG_CONFLICT_MESSAGES, result.code)) {
    return JOIN_DEFAULT_ORG_CONFLICT_MESSAGES[result.code]
  }
  if (result.status === 404 && result.code === 'DIRECTORY_LOCAL_NOT_FOUND') return JOIN_DEFAULT_ORG_USER_GONE
  return JOIN_DEFAULT_ORG_FAILURE
}

function openJoinDefaultOrgConfirm(): void {
  const userId = memberAdmission.value?.userId
  if (!userId) return
  joinDefaultOrgConfirmUserId.value = userId
}

function closeJoinDefaultOrgConfirm(): void {
  joinDefaultOrgConfirmUserId.value = null
}

async function confirmJoinDefaultOrg(): Promise<void> {
  const confirmedUserId = joinDefaultOrgConfirmUserId.value
  closeJoinDefaultOrgConfirm()
  const userId = selectedUserId.value
  // Only the selected user, and only when the confirmed panel and the admission on screen are that user's.
  if (!userId || userId !== confirmedUserId || userId !== memberAdmission.value?.userId) {
    setStatus(JOIN_DEFAULT_ORG_FAILURE, 'error')
    return
  }
  joiningDefaultOrgUserIds.value = [...joiningDefaultOrgUserIds.value, userId]
  try {
    const result = await postJoinDefaultOrg(userId)
    if (!result.ok) {
      setStatus(describeJoinDefaultOrgFailure(result), 'error')
      return
    }
    // The admin moved on to another user: that user's panel is not reloaded or told 已加入.
    if (selectedUserId.value !== userId) return
    await refreshCurrentDetailMemberAdmissionIfNeeded([userId])
    setStatus('已加入默认组织')
  } catch {
    setStatus(JOIN_DEFAULT_ORG_FAILURE, 'error')
  } finally {
    joiningDefaultOrgUserIds.value = joiningDefaultOrgUserIds.value.filter((id) => id !== userId)
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
    setStatus('当前钉钉身份缺少 openId：暂时拿不到该成员的 openId，暂不能开通钉钉扫码。', 'error')
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

function buildAttendanceOnboardingTarget(user: ManagedUser | undefined): AttendanceOnboardingTarget | null {
  if (!user?.id) return null
  return {
    id: user.id,
    name: String(user.name || user.username || user.email || user.id),
    employeeNo: String(user.employeeNo || ''),
    department: String(user.department || ''),
    position: String(user.position || ''),
    hireDate: String(user.hireDate || ''),
  }
}

function buildAttendanceAdminSectionLocation(sectionId: string): string {
  const params = new URLSearchParams({
    tab: 'admin',
    section: sectionId,
  })
  const target = createdAttendanceOnboardingTarget.value
  if (target?.id) params.set('userId', target.id)
  const query = target?.employeeNo || target?.name || target?.id || ''
  if (query) params.set('q', query)
  return `/attendance?${params.toString()}`
}

async function createUser(): Promise<void> {
  busy.value = true
  createdTemporaryPassword.value = ''
  createdInviteMessage.value = ''
  createdOnboarding.value = null
  createdAttendanceOnboardingTarget.value = null
  try {
    const response = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: createForm.value.name,
        email: createForm.value.email,
        username: createForm.value.username || undefined,
        mobile: createForm.value.mobile || undefined,
        employeeNo: createForm.value.employeeNo || undefined,
        department: createForm.value.department || undefined,
        position: createForm.value.position || undefined,
        hireDate: createForm.value.hireDate || undefined,
        attendanceGroupId: createForm.value.attendanceGroupId || undefined,
        defaultShiftId: createForm.value.defaultShiftId || undefined,
        defaultShiftStartDate: createForm.value.defaultShiftStartDate || undefined,
        attendanceOrgId: createForm.value.attendanceOrgId || undefined,
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
      // Known validation codes render Chinese copy; anything else keeps the server message.
      const localizedError = describeCreateUserError(errorPayload, 'zh')
      if (localizedError) throw new Error(localizedError)
      const detailText = Array.isArray(errorPayload?.details) ? `：${(errorPayload?.details as string[]).join('；')}` : ''
      throw new Error(String(errorPayload?.message || '创建用户失败') + detailText)
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    selectedUserId.value = access.value.user.id
    createdTemporaryPassword.value = String((payload.data as Record<string, unknown>).temporaryPassword || '')
    createdOnboarding.value = ((payload.data as Record<string, unknown>).onboarding as OnboardingPacket | undefined) || null
    createdInviteMessage.value = String(createdOnboarding.value?.inviteMessage || '')
    createdAttendanceOnboardingTarget.value = buildAttendanceOnboardingTarget(access.value.user)
    createForm.value = {
      name: '',
      email: '',
      username: '',
      mobile: '',
      employeeNo: '',
      department: '',
      position: '',
      hireDate: '',
      attendanceGroupId: '',
      defaultShiftId: '',
      defaultShiftStartDate: '',
      attendanceOrgId: '',
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
  const note = inviteNote.value.trim()
  const text = note ? `${createdInviteMessage.value}\n\n${note}` : createdInviteMessage.value
  if (await copyText(text)) {
    setStatus('邀请文案已复制')
  } else {
    setStatus('复制邀请文案失败', 'error')
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

watch(() => createForm.value.defaultShiftId, (shiftId) => {
  if (shiftId && !createForm.value.defaultShiftStartDate && createForm.value.hireDate) {
    createForm.value.defaultShiftStartDate = createForm.value.hireDate
  }
  if (!shiftId) {
    createForm.value.defaultShiftStartDate = ''
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
  const requestedUserId = access.value.user.id
  const intent = classifyManualTemporaryPassword(manualPassword.value)
  if (intent.kind === 'too-short') {
    passwordResetInlineError.value = ADMIN_TEMPORARY_PASSWORD_TOO_SHORT
    return
  }
  passwordResetInlineError.value = ''
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(requestedUserId)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({
        password: intent.kind === 'submit' ? intent.password : undefined,
      }),
    })
    const payload = await readJson(response)
    if (selectedUserId.value !== requestedUserId) return
    if (!response.ok || payload.ok !== true) {
      const errorPayload = payload.error as { code?: unknown; message?: unknown } | undefined
      const inlineError = describeAdminResetPasswordInlineError(errorPayload)
      if (inlineError) {
        passwordResetInlineError.value = inlineError
        return
      }
      throw new Error(String(errorPayload?.message || '重置密码失败'))
    }

    temporaryPassword.value = String((payload.data as Record<string, unknown> | undefined)?.temporaryPassword || '')
    manualPassword.value = ''
    passwordResetInlineError.value = ''
    setStatus('密码已重置')
  } catch (error) {
    if (selectedUserId.value !== requestedUserId) return
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

function finishRoleWrite(
  generation: number,
  requestedUserId: string,
  outcome: RoleMembershipWriteOutcome,
  snapshot: RoleMembershipSnapshot | null,
): boolean {
  const stillCurrent = accessReadStillCurrent(
    generation,
    userAccessReadGeneration.value,
    requestedUserId,
    selectedUserId.value,
  )
  if (!stillCurrent) {
    if (selectedUserId.value !== requestedUserId) {
      roleActionFeedback.value = { tone: outcome.tone, message: outcome.message }
      setStatus(outcome.message, outcome.tone)
    }
    return false
  }

  roleActionFeedback.value = { tone: outcome.tone, message: outcome.message }
  setStatus(outcome.message, outcome.tone)
  if (!outcome.applySnapshot || !snapshot || snapshot.user.id !== requestedUserId) {
    access.value = null
    return false
  }

  access.value = {
    user: snapshot.user as UserAccess['user'],
    roles: snapshot.roles,
    permissions: snapshot.permissions,
    isAdmin: snapshot.isAdmin,
  }
  syncProfileDraftFromAccess()
  return true
}

async function updateRole(action: 'assign' | 'unassign'): Promise<void> {
  if (!selectedUserId.value || !selectedRoleId.value || !roleSnapshotReady.value) return
  const requestedUserId = selectedUserId.value
  const requestedRoleId = selectedRoleId.value
  const generation = userAccessReadGeneration.value
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(requestedUserId)}/roles/${action}`, {
      method: 'POST',
      body: JSON.stringify({ roleId: requestedRoleId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存角色失败'))
    }

    const result = roleWriteOutcomeFromPayload(payload.data, {
      action,
      requestedUserId,
      selectedUserId: selectedUserId.value,
      roleId: requestedRoleId,
    })
    if (!finishRoleWrite(generation, requestedUserId, result.outcome, result.snapshot)) return
    await loadRoles()
    await loadUsers()
    if (accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)) {
      await loadMemberAdmission(requestedUserId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存角色失败'
    const outcome = describeRoleMembershipWrite({
      action,
      requestedUserId,
      selectedUserId: selectedUserId.value,
      roleId: requestedRoleId,
      persistedRoleIds: [],
      ok: false,
      errorMessage: message,
    })
    finishRoleWrite(generation, requestedUserId, outcome, null)
  } finally {
    busy.value = false
  }
}

async function updateNamedRole(roleId: string, enabled: boolean): Promise<void> {
  if (!selectedUserId.value || !roleSnapshotReady.value) return
  const requestedUserId = selectedUserId.value
  const requestedRoleId = roleId
  const action: 'assign' | 'unassign' = enabled ? 'assign' : 'unassign'
  const generation = userAccessReadGeneration.value
  busy.value = true
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(requestedUserId)}/roles/${action}`, {
      method: 'POST',
      body: JSON.stringify({ roleId: requestedRoleId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存管理员角色失败'))
    }

    const result = roleWriteOutcomeFromPayload(payload.data, {
      action,
      requestedUserId,
      selectedUserId: selectedUserId.value,
      roleId: requestedRoleId,
    })
    if (!finishRoleWrite(generation, requestedUserId, result.outcome, result.snapshot)) return
    await loadRoles()
    await loadUsers()
    if (accessReadStillCurrent(generation, userAccessReadGeneration.value, requestedUserId, selectedUserId.value)) {
      await loadMemberAdmission(requestedUserId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存管理员角色失败'
    const outcome = describeRoleMembershipWrite({
      action,
      requestedUserId,
      selectedUserId: selectedUserId.value,
      roleId: requestedRoleId,
      persistedRoleIds: [],
      ok: false,
      errorMessage: message,
    })
    finishRoleWrite(generation, requestedUserId, outcome, null)
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
        employeeNo: profileDraftEmployeeNo.value,
        department: profileDraftDepartment.value,
        position: profileDraftPosition.value,
        hireDate: profileDraftHireDate.value,
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

watch([userListFilter, roleFilter, accountStatusFilter, search], () => {
  page.value = 1
})

function onUserAdminKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (inviteOpen.value) {
    closeInvite()
    return
  }
  if (detailOpen.value) closeUserDetail()
}

const stopUserLocationSync = subscribeToLocationChanges(() => {
  if (!syncUserNavigationFromLocation()) return
  void handleUserNavigationChange()
})

onMounted(async () => {
  window.addEventListener('keydown', onUserAdminKeydown)
  await Promise.all([loadRoles(), loadUsers(), loadAccessPresets(), loadInviteRecords(), loadAttendanceOnboardingOptions(), loadAttendanceOrgOptions()])
})

onUnmounted(() => {
  window.removeEventListener('keydown', onUserAdminKeydown)
  stopUserLocationSync()
})
</script>

<style scoped>
.user-admin__org-field {
  display: flex;
  gap: 8px;
  align-items: center;
}

.user-admin__org-field .user-admin__select {
  flex: 1;
  min-width: 0;
}

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

.user-admin__org-context {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.user-admin__org-label {
  align-self: center;
  font-size: 13px;
}

.user-admin__confirm {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  background: #fffbeb;
  color: #92400e;
}

.user-admin__confirm ol {
  margin: 0;
  padding-left: 20px;
}

.user-admin__block-error {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fef2f2;
  color: #dc2626;
}

.user-admin__block-error p {
  margin: 0;
}

.user-admin__block-error small {
  display: block;
  margin-top: 4px;
  color: #6b7280;
  font-size: 12px;
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
  /* Single full-width track (customer field report 2026-10-21, updated with the member-table
     redesign): a plain `1fr` is minmax(auto, 1fr) and grows to min-content, so one long
     unbreakable identifier could widen the page. The detail editor is an overlay drawer, not a
     second column, so it cannot be pushed off or drawn over the table. */
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-height: 0;
}

.user-admin__layout > * {
  min-width: 0;
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
  /* Explicit single track capped at the card width (customer field report 2026-10-21). The implicit
     track was `auto`, which grows to the widest child's min-content (e.g. a long unbreakable account
     identifier in a user row): every block in the left card was then laid out wider than the card,
     the export buttons were clipped at its edge and the bulk-action buttons were drawn over the
     right panel. */
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
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
  /* In the 320px left card the export buttons do not fit beside the heading: wrap them onto their
     own line instead of squeezing the heading into a one-word-per-line column. */
  flex-wrap: wrap;
}

.user-admin__section-head--workbench > * {
  min-width: 0;
}

/* Long button labels wrap inside the card instead of overflowing it. */
.user-admin__role-actions > .user-admin__button {
  max-width: 100%;
  height: auto;
  min-height: 38px;
  white-space: normal;
}

/* Account identifiers (e.g. directory-synced ids) are one unbreakable token; let them break. */
.user-admin__user-body > strong,
.user-admin__user-body > span,
.user-admin__detail-head h2,
.user-admin__detail-head p {
  overflow-wrap: anywhere;
}

/* The missing-OpenID hint carries the whole corpId (one unbreakable token): full row, may break. */
.user-admin__user > .user-admin__hint {
  grid-column: 1 / -1;
  grid-row: 2;
  flex-basis: 100%;
  min-width: 0;
  margin: 2px 0 0;
  padding-top: 6px;
  border-top: 1px dashed var(--ms-border-light);
  overflow-wrap: anywhere;
}

.user-admin__panel--detail {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 30;
  width: min(640px, 100%);
  height: 100%;
  max-height: 100vh;
  margin: 0;
  overflow: auto;
  border-radius: 0;
  transform: translateX(105%);
  visibility: hidden;
  gap: 16px;
}

.user-admin__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
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
  display: grid;
  grid-template-columns: 28px minmax(0, 2.4fr) minmax(0, 0.7fr) minmax(0, 1.5fr) minmax(88px, 0.8fr) 64px;
  /* The missing-OpenID governance hint (a <p> after the user-body button) takes its own line instead
     of squeezing the button and running past the card. */
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  text-align: left;
  width: 100%;
  /* width: 100% plus padding/border must still fit the card. */
  box-sizing: border-box;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  padding: 10px 12px;
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
  grid-column: 2 / 6;
  display: grid;
  grid-template-columns: subgrid;
  align-items: center;
  text-align: left;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  min-width: 0;
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

.user-admin__panel--detail-open {
  transform: translateX(0);
  visibility: visible;
}

.user-admin__detail-close,
.user-admin__panel--detail .user-admin__section-head > .user-admin__button,
.user-admin__panel--detail .user-admin__role-actions > .user-admin__button {
  flex: none;
  width: auto;
  white-space: nowrap;
}

.user-admin__invite-list {
  display: grid;
  gap: var(--ms-space-3);
}

.user-admin__invite-list .user-admin__role-card {
  width: min(520px, 100%);
}

.user-admin__drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 25;
  border: 0;
  background: color-mix(in srgb, var(--ms-text-1) 28%, transparent);
}

.user-admin__modal {
  display: none;
}

.user-admin__modal--open {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--ms-space-5);
}

.user-admin__modal-backdrop {
  position: absolute;
  inset: 0;
  border: 0;
  background: color-mix(in srgb, var(--ms-text-1) 35%, transparent);
}

.user-admin__modal--open .user-admin__panel--create {
  position: relative;
  z-index: 1;
  width: min(960px, 100%);
  max-height: min(860px, calc(100vh - 48px));
  overflow: auto;
}

.user-admin__note-label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-2);
  font-size: 13px;
}

.user-admin__note {
  width: 100%;
  min-height: 72px;
  height: auto;
  padding: 8px 12px;
}

.user-admin__tabs {
  display: flex;
  gap: var(--ms-space-1);
  border-bottom: 1px solid var(--ms-border-light);
}

.user-admin__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ms-text-2);
  font-weight: 600;
  padding: 8px 12px;
  cursor: pointer;
}

.user-admin__tab--active {
  color: var(--ms-text-1);
  border-bottom-color: var(--ms-color-primary);
}

.user-admin__tab-count {
  min-width: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.user-admin__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.user-admin__toolbar .user-admin__search {
  flex: 1 1 280px;
}

.user-admin__toolbar .user-admin__select {
  min-width: 140px;
}

.user-admin__governance {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  padding: 8px 12px;
  background: var(--ms-bg-card);
}

.user-admin__governance summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--ms-text-1);
}

.user-admin__bulkbar--idle {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.user-admin__table-head {
  display: grid;
  grid-template-columns: 28px minmax(0, 2.4fr) minmax(0, 0.7fr) minmax(0, 1.5fr) minmax(88px, 0.8fr) 64px;
  gap: 10px;
  padding: 0 12px 8px;
  color: var(--ms-text-3);
  font-size: 12px;
  font-weight: 600;
}

.user-admin__table-head button {
  border: 0;
  background: transparent;
  padding: 0;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.user-admin__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.user-admin__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
  font-size: 13px;
  font-weight: 600;
}

.user-admin__identity-text {
  display: grid;
  min-width: 0;
}

.user-admin__identity-text span {
  color: var(--ms-text-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.user-admin__user-select span {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.user-admin__row-menu {
  position: relative;
  justify-self: end;
}

.user-admin__row-menu > button,
.user-admin__row-menu-panel button {
  border: 1px solid var(--ms-border);
  background: var(--ms-bg-card);
  border-radius: var(--ms-radius-sm);
  height: 32px;
  padding: 0 8px;
  cursor: pointer;
  color: var(--ms-text-1);
}

.user-admin__row-menu-panel {
  position: absolute;
  right: 0;
  top: 36px;
  z-index: 5;
  min-width: 96px;
  padding: 4px;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
}

.user-admin__row-menu-panel button {
  width: 100%;
  border: 0;
  text-align: left;
}

.user-admin__pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
}

.user-admin__section--danger {
  margin-top: var(--ms-space-2);
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
}

.user-admin {
  background: var(--ms-bg-page);
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

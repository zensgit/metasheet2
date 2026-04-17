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
          placeholder="搜索邮箱、姓名或用户 ID"
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
    <article v-if="directoryFailureNotice" class="user-admin__status user-admin__status--error user-admin__source-banner">
      <strong>目录页返回</strong>
      <p>{{ directoryFailureNotice.message }}</p>
      <p v-if="directoryFailureNotice.integrationId">目标集成：{{ directoryFailureNotice.integrationId }}</p>
      <p v-if="directoryFailureNotice.accountId">目标成员：{{ directoryFailureNotice.accountId }}</p>
      <p>你可以继续检查当前用户的目录绑定状态，再决定是否重新跳转目录页处理。</p>
      <div v-if="directoryFailureDirectoryLocation" class="user-admin__source-actions">
        <router-link
          class="user-admin__button user-admin__button--secondary user-admin__button-link"
          :to="directoryFailureDirectoryLocation"
        >
          重新前往目录页
        </router-link>
        <router-link
          v-if="directoryFailureRecoveryLocation"
          class="user-admin__button user-admin__button--secondary user-admin__button-link"
          :to="directoryFailureRecoveryLocation"
        >
          前往当前已链接成员
        </router-link>
        <button
          class="user-admin__button user-admin__button--secondary"
          type="button"
          @click="clearDirectoryFailureContext()"
        >
          保留当前用户
        </button>
      </div>
    </article>

    <section class="user-admin__panel user-admin__panel--create">
      <div class="user-admin__section-head">
        <div>
          <h2>创建用户</h2>
          <p class="user-admin__hint">可选择自动生成临时密码，后续再在权限页补充直接权限。密码需至少 8 位，包含大小写字母和数字。</p>
        </div>
      </div>
      <div class="user-admin__create-grid">
        <input v-model.trim="createForm.name" class="user-admin__search" type="text" placeholder="姓名" />
        <input v-model.trim="createForm.email" class="user-admin__search" type="email" placeholder="邮箱" />
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
            <strong>{{ user.name || user.email }}</strong>
            <span>{{ user.email }}</span>
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
        </article>
      </aside>

      <section class="user-admin__panel user-admin__panel--detail">
        <template v-if="access">
          <div class="user-admin__detail-head">
            <div>
              <h2>{{ access.user.name || access.user.email }}</h2>
              <p>{{ access.user.email }}</p>
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
                <router-link
                  v-if="access"
                  class="user-admin__link"
                  :to="buildDirectoryLocation(membership, access.user.id)"
                >
                  前往目录成员
                </router-link>
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
            <p v-if="dingtalkAccess?.identity.lastLoginAt" class="user-admin__hint">
              最近钉钉登录：{{ formatDate(dingtalkAccess.identity.lastLoginAt) }}
            </p>
            <p v-if="dingtalkAccess?.grant.updatedAt" class="user-admin__hint">
              开通状态更新时间：{{ formatDate(dingtalkAccess.grant.updatedAt) }}
            </p>
            <div class="user-admin__role-actions">
              <button class="user-admin__button" type="button" :disabled="busy || loadingDingTalk || dingtalkAccess?.grant.enabled === true" @click="void updateDingTalkGrant(true)">
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
  email: string
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
  directoryLinked?: boolean
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

type DingTalkAccess = {
  provider: 'dingtalk'
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
  server?: DingTalkRuntimeStatus
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

type InitialUserNavigation = {
  userId: string
  source: string
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
const userListFilter = ref<'all' | 'account-disabled' | 'dingtalk-disabled' | 'directory-unlinked' | 'platform-admin'>('all')
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
}))
const visibleUsers = computed(() => {
  return users.value.filter((user) => {
    if (userListFilter.value === 'account-disabled') return !user.is_active
    if (userListFilter.value === 'dingtalk-disabled') return user.dingtalkLoginEnabled === false
    if (userListFilter.value === 'directory-unlinked') return user.directoryLinked !== true
    if (userListFilter.value === 'platform-admin') return user.platformAdminEnabled === true
    return true
  })
})
const selectedUserIdSet = computed(() => new Set(selectedUserIds.value))
const userFilterOptions = [
  { value: 'all', label: '全部' },
  { value: 'account-disabled', label: '账号停用' },
  { value: 'dingtalk-disabled', label: '钉钉停用' },
  { value: 'directory-unlinked', label: '目录未链接' },
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

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
}

function readInitialUserNavigation(): InitialUserNavigation {
  if (typeof window === 'undefined') {
    return { userId: '', source: '', integrationId: '', accountId: '', directoryFailure: '' }
  }
  const params = new URL(window.location.href).searchParams
  return {
    userId: params.get('userId')?.trim() || '',
    source: params.get('source')?.trim() || '',
    integrationId: params.get('integrationId')?.trim() || '',
    accountId: params.get('accountId')?.trim() || '',
    directoryFailure: params.get('directoryFailure')?.trim() || '',
  }
}

function buildUserNavigationKey(navigation: InitialUserNavigation): string {
  return [
    navigation.userId.trim(),
    navigation.source.trim(),
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
  if (navigation.integrationId.trim().length > 0) params.set('integrationId', navigation.integrationId.trim())
  if (navigation.accountId.trim().length > 0) params.set('accountId', navigation.accountId.trim())
  if (navigation.directoryFailure.trim().length > 0) params.set('directoryFailure', navigation.directoryFailure.trim())
  const search = params.toString()
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}

function replaceUserNavigation(navigation: InitialUserNavigation): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', buildUserLocation(navigation))
}

const directoryFailureNotice = computed(() => {
  const navigation = userNavigation.value
  if (navigation.source !== 'directory-sync') return null
  const failureKind = navigation.directoryFailure.trim()
  if (failureKind !== 'missing_integration' && failureKind !== 'missing_account') return null
  const targetId = failureKind === 'missing_integration' ? navigation.integrationId.trim() : navigation.accountId.trim()
  const message = failureKind === 'missing_integration'
    ? `目录页未找到目录集成 ${targetId || '--'}。`
    : `目录页未找到目录成员 ${targetId || '--'}。`
  return {
    kind: failureKind,
    message,
    integrationId: navigation.integrationId.trim(),
    accountId: navigation.accountId.trim(),
  }
})
const directoryFailureDirectoryLocation = computed(() => {
  const navigation = userNavigation.value
  if (navigation.source !== 'directory-sync') return ''
  const userId = navigation.userId.trim()
  const integrationId = navigation.integrationId.trim()
  if (!userId || !integrationId) return ''
  return buildDirectoryNavigationLocation({
    userId,
    integrationId,
    accountId: navigation.accountId.trim(),
  })
})
const directoryFailureRecoveryLocation = computed(() => {
  if (!directoryFailureNotice.value || !access.value) return ''
  const memberships = memberAdmission.value?.directoryMemberships || []
  if (memberships.length === 0) return ''
  const targetIntegrationId = directoryFailureNotice.value.integrationId.trim()
  const matchedMembership = memberships.find((membership) => membership.integrationId === targetIntegrationId) || memberships[0]
  if (!matchedMembership) return ''
  const location = buildDirectoryLocation(matchedMembership, access.value.user.id)
  return location === directoryFailureDirectoryLocation.value ? '' : location
})

function clearDirectoryFailureContext(): void {
  const fallbackUserId = selectedUserId.value || access.value?.user.id || userNavigation.value.userId.trim()
  replaceUserNavigation({
    userId: fallbackUserId,
    source: '',
    integrationId: '',
    accountId: '',
    directoryFailure: '',
  })
  const fallbackUserName = access.value?.user.name || access.value?.user.email || fallbackUserId
  setStatus(fallbackUserName ? `已清除目录失败提示，保留当前用户 ${fallbackUserName}` : '已清除目录失败提示')
}

function syncUserNavigationFromLocation(): boolean {
  const next = readInitialUserNavigation()
  const currentKey = buildUserNavigationKey(userNavigation.value)
  const nextKey = buildUserNavigationKey(next)
  userNavigation.value = next
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
          directoryLinked: item.directoryLinked ?? false,
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

async function selectUser(userId: string): Promise<void> {
  selectedUserId.value = userId
  selectedRoleId.value = ''
  manualPassword.value = ''
  temporaryPassword.value = ''
  createdTemporaryPassword.value = ''
  dingtalkAccess.value = null
  memberAdmission.value = null
  try {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/access`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载用户权限失败'))
    }

    access.value = payload.data as UserAccess
    syncProfileDraftFromAccess()
    const navigationKey = buildUserNavigationKey(userNavigation.value)
    if (userNavigation.value.userId === userId && appliedUserNavigationKey.value !== navigationKey) {
      if (userNavigation.value.source === 'directory-sync') {
        setStatus(`已从目录同步定位到用户 ${access.value.user.name || access.value.user.email}`)
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

function buildDirectoryNavigationLocation({
  userId,
  integrationId,
  accountId,
}: {
  userId: string
  integrationId: string
  accountId: string
}): string {
  const params = new URLSearchParams()
  params.set('integrationId', integrationId)
  if (accountId.trim().length > 0) params.set('accountId', accountId)
  params.set('source', 'user-management')
  params.set('userId', userId)
  return `/admin/directory?${params.toString()}`
}

function buildDirectoryLocation(membership: MemberDirectoryMembership, userId: string): string {
  return buildDirectoryNavigationLocation({
    userId,
    integrationId: membership.integrationId,
    accountId: membership.directoryAccountId,
  })
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
        await selectUser(baselineUserId)
        const latest = access.value?.user.mobile ?? null
        const latestLabel = latest === null || latest === '' ? '（空）' : latest
        setStatus(`用户手机号已被其他操作更新为 ${latestLabel}，请确认最新值后重新保存`, 'error')
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

.user-admin__panel--detail {
  gap: 16px;
}

.user-admin__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.user-admin__metric {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f8fafc;
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

  .user-admin__create-grid {
    grid-template-columns: 1fr;
  }

  .user-admin__actions {
    flex-wrap: wrap;
  }
}
</style>

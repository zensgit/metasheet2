<template>
  <section class="delegation-page">
    <header class="delegation-page__header">
      <div>
        <h1>管理范围</h1>
        <p data-testid="scope-explanation">部门范围可以选择是否包含下级部门。成员集是共享成员组。同一命名空间内，部门范围与共享成员组取并集；不同命名空间不合并。平台管理员配置管理范围；委派管理员只能给允许的成员分配允许的角色。插件使用准入不是管理委派的前提。</p>
      </div>
      <div class="delegation-page__actions">
        <router-link v-if="summary?.isPlatformAdmin === true" class="delegation-page__link" to="/admin/users">成员与授权</router-link>
        <input
          v-model.trim="search"
          class="delegation-page__input"
          type="search"
          placeholder="搜索邮箱、姓名或用户 ID"
          aria-label="搜索邮箱、姓名或用户 ID"
          @keyup.enter="void loadUsers()"
        />
        <button class="delegation-page__button" type="button" @click="void loadUsers()">
          {{ loading ? '加载中...' : '查询' }}
        </button>
      </div>
    </header>

    <DelegationConfirmationPanel
      v-if="pendingConfirmation"
      :confirmation="pendingConfirmation"
      :phase="confirmationPhase"
      :impact="confirmationImpact"
      :confirm-ready="confirmationConfirmReady"
      :admission-enabled="pendingAdmissionEnabled"
      :read-again="confirmationReadAgain"
      @confirm="void submitDelegationConfirmation($event)"
      @cancel="cancelDelegationConfirmation()"
      @read-again="void rereadDelegationAuthorization()"
    />

    <section
      v-if="activationConfirming"
      ref="activationDialogRef"
      class="scope-activation-confirm"
      data-testid="scope-activation-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scope-activation-confirm-title"
      tabindex="-1"
      @keydown="onActivationDialogKey"
    >
      <h3 id="scope-activation-confirm-title">{{ activationConfirming.enabled ? '确认启用委派' : '确认停止委派' }}</h3>
      <p>{{ selectedAccess?.user.name || selectedAccess?.user.email || activationConfirming.userId }}</p>
      <p>{{ activationConfirming.namespace }}</p>
      <p data-testid="scope-activation-confirm-effect">{{ activationConfirming.enabled ? activationEnableEffect : activationStopEffect }}</p>
      <div class="delegation-page__role-actions">
        <button
          class="delegation-page__button delegation-page__button--secondary"
          type="button"
          data-testid="scope-activation-confirm-cancel"
          :disabled="activationWriting"
          @click="dismissActivationConfirmation()"
        >
          取消
        </button>
        <button
          class="delegation-page__button"
          type="button"
          data-testid="scope-activation-confirm-submit"
          :disabled="activationWriting"
          @click="void submitScopeActivation()"
        >
          {{ activationWriting ? '提交中...' : (activationConfirming.enabled ? '确认启用' : '确认停止') }}
        </button>
      </div>
    </section>

    <p v-if="status" class="delegation-page__status" :class="{ 'delegation-page__status--error': statusTone === 'error' }">
      {{ status }}
    </p>
    <button
      v-if="restoredReadAgain && !pendingConfirmation"
      class="delegation-page__button"
      type="button"
      data-testid="delegation-restored-read-again"
      @click="void rereadRestoredAuthorization()"
    >
      重新读取
    </button>

    <section class="delegation-page__panel">
      <div class="delegation-page__chips">
        <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': summary?.isPlatformAdmin }">
          {{ summary?.isPlatformAdmin ? '平台管理员模式' : '插件管理员模式' }}
        </span>
        <span v-for="namespace in summary?.delegableNamespaces || []" :key="namespace" class="delegation-page__chip">
          {{ namespace }}
        </span>
        <span v-if="summary && summary.delegableNamespaces.length === 0 && !summary.isPlatformAdmin" class="delegation-page__chip delegation-page__chip--danger">
          无可委派命名空间
        </span>
      </div>
      <div v-if="summary && !summary.isPlatformAdmin" class="delegation-page__section">
        <h3>当前管理范围</h3>
        <div v-if="summary.scopeAssignments.length > 0" class="delegation-page__scope-list">
          <article v-for="scope in summary.scopeAssignments" :key="scope.id" class="delegation-page__scope-card">
            <strong>{{ scope.namespace }}</strong>
            <span>{{ scope.integrationName }}</span>
            <p>{{ scope.departmentFullPath || scope.departmentName }}</p>
            <p data-testid="department-scope-choice">{{ departmentScopeChoiceLabel(scope.includeChildren) }}</p>
          </article>
        </div>
        <div v-if="summary.groupAssignments.length > 0" class="delegation-page__scope-list">
          <article v-for="group in summary.groupAssignments" :key="group.id" class="delegation-page__scope-card">
            <strong>{{ group.namespace }}</strong>
            <span>{{ group.name }}</span>
            <p>{{ group.description || `成员 ${group.memberCount}` }}</p>
          </article>
        </div>
        <div
          v-if="summary.scopeAssignments.length === 0 && summary.groupAssignments.length === 0"
          class="delegation-page__empty"
        >
          当前插件管理员尚未配置任何部门或成员集范围，因此不能委派成员。
        </div>
      </div>
    </section>

    <div class="delegation-page__layout">
      <aside class="delegation-page__panel">
        <h2>成员</h2>
        <div v-if="usersForbidden" class="delegation-page__empty" data-testid="delegation-users-forbidden">当前账号没有可管理的范围。</div>
        <div v-else-if="users.length === 0" class="delegation-page__empty">暂无成员</div>
        <button
          v-for="user in users"
          :key="user.id"
          class="delegation-page__user"
          :class="{
            'delegation-page__user--active': selectedUserId === user.id && user.selectable !== false,
            'delegation-page__user--disabled': user.selectable === false,
          }"
          :disabled="user.selectable === false"
          :data-testid="user.selectable === false ? 'delegation-user-disabled' : undefined"
          type="button"
          @click="void selectUser(user.id)"
        >
          <strong>{{ candidatePrimaryLabel(user) }}</strong>
          <span v-if="candidateEmail(user)">{{ candidateEmail(user) }}</span>
          <small v-if="user.selectable !== false">{{ candidateMeta(user) }}</small>
          <small v-else :data-testid="`delegation-disabled-reason-${user.id}`">{{ candidateDisabledReason(user) }}</small>
        </button>
      </aside>

      <section class="delegation-page__panel delegation-page__panel--detail">
        <template v-if="selectedAccess && !selectedUserDisabled">
          <div class="delegation-page__detail-head">
            <div>
              <h2>{{ selectedAccess.user.name || selectedAccess.user.email }}</h2>
              <p>{{ selectedAccess.user.email }}</p>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>当前可委派角色</h3>
            <div class="delegation-page__chips">
              <span v-for="roleId in selectedAccess.delegableRoles" :key="roleId" class="delegation-page__chip delegation-page__chip--success">
                {{ roleId }}
              </span>
              <span v-if="selectedAccess.delegableRoles.length === 0" class="delegation-page__empty">未分配当前委派范围内的角色</span>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>成员集归属</h3>
            <div class="delegation-page__chips">
              <span v-for="group in selectedAccess.memberGroups" :key="group.id" class="delegation-page__chip">
                {{ group.name }}
              </span>
              <span v-if="selectedAccess.memberGroups.length === 0" class="delegation-page__empty">该成员尚未加入任何平台成员集</span>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>插件使用准入</h3>
            <p class="delegation-page__hint">这里控制成员是否可进入对应插件命名空间。角色和开通状态同时满足，插件才可用。钉钉登录是平台准入，和插件使用是两层不同的开关。插件使用准入不是管理委派成员的前提。</p>
            <div v-if="selectedAccess.namespaceAdmissions?.length > 0" class="delegation-page__role-list">
              <article v-for="admission in selectedAccess.namespaceAdmissions || []" :key="admission.namespace" class="delegation-page__role-card delegation-page__role-card--namespace">
                <strong>{{ admission.namespace }}</strong>
                <span v-if="admission.updatedAt">更新时间：{{ admission.updatedAt }}</span>
                <div class="delegation-page__chips">
                  <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': admission.hasRole, 'delegation-page__chip--danger': !admission.hasRole }">
                    {{ admission.hasRole ? '已分配角色' : '未分配角色' }}
                  </span>
                  <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': admission.enabled, 'delegation-page__chip--danger': !admission.enabled }">
                    {{ admission.enabled ? '插件使用已开通' : '插件使用未开通' }}
                  </span>
                  <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': admission.effective, 'delegation-page__chip--danger': !admission.effective }">
                    {{ admission.effective ? '当前实际可用' : '当前不可用' }}
                  </span>
                </div>
                <p>只有角色和开通状态同时满足，插件才算真正可用。</p>
                <p v-if="!namespaceIsManaged(admission.namespace)" data-testid="admission-namespace-locked">当前命名空间不在可管理范围内</p>
                <div class="delegation-page__role-actions">
                  <button class="delegation-page__button" type="button" :disabled="busy || !memberWritesReady || admission.enabled || !namespaceIsManaged(admission.namespace)" @click="openAdmissionConfirmation(admission)">
                    开通插件使用
                  </button>
                  <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="busy || !memberWritesReady || !admission.enabled || !namespaceIsManaged(admission.namespace)" @click="openAdmissionConfirmation(admission, false)">
                    关闭插件使用
                  </button>
                </div>
              </article>
            </div>
            <div v-else class="delegation-page__empty">
              暂无插件使用准入信息
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>委派操作</h3>
            <!--
              Two lists on purpose. The server answers two different sets: `roleCatalog` is what
              this delegate may ASSIGN, `delegableRoles` is the member's roles this delegate may
              REVOKE. They differ (a role carrying ordinary codes outside the namespace may be
              revoked but not granted), so a single dropdown fed by the catalog hid revocable roles.
            -->
            <div class="delegation-page__role-actions">
              <select v-model="selectedRoleId" class="delegation-page__input" data-testid="delegation-assign-role">
                <option value="">请选择要分配的角色</option>
                <option v-for="role in selectedAccess.roleCatalog" :key="role.id" :value="role.id">
                  {{ roleTitle(role) }} ({{ role.id }})
                </option>
              </select>
              <button class="delegation-page__button" type="button" :disabled="busy || !memberWritesReady || !selectedRoleId || !roleActionAllowed(selectedRoleId, 'assign')" @click="openGrantConfirmation()">
                分配角色
              </button>
            </div>
            <div class="delegation-page__role-actions">
              <select v-model="selectedRevokeRoleId" class="delegation-page__input" data-testid="delegation-revoke-role">
                <option value="">请选择要撤销的角色</option>
                <option v-for="roleId in selectedAccess.delegableRoles" :key="roleId" :value="roleId">
                  {{ revocableRoleLabel(roleId) }}
                </option>
              </select>
              <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="busy || !memberWritesReady || !selectedRevokeRoleId || !roleActionAllowed(selectedRevokeRoleId, 'unassign')" @click="openRevokeConfirmation()">
                撤销角色
              </button>
            </div>
          </div>

          <div class="delegation-page__section">
            <h3>可委派角色目录</h3>
            <div class="delegation-page__role-list">
              <article v-for="role in selectedAccess.roleCatalog" :key="role.id" class="delegation-page__role-card">
                <strong>{{ roleTitle(role) }}</strong>
                <span class="delegation-page__code">{{ role.id }}</span>
                <p class="delegation-page__code">{{ rolePermissionLabel(role) }}</p>
              </article>
            </div>
          </div>

          <div v-if="summary?.isPlatformAdmin" class="delegation-page__section">
            <h3>平台成员集</h3>
            <p class="delegation-page__hint">平台管理员可维护一组共享成员组，再将该成员集直接分配给插件管理员命名空间或组织范围模板。</p>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="memberGroupName"
                class="delegation-page__input"
                type="text"
                placeholder="成员集名称，例如 制造中心"
              />
              <input
                v-model.trim="memberGroupDescription"
                class="delegation-page__input"
                type="text"
                placeholder="成员集说明，可选"
              />
              <button class="delegation-page__button" type="button" :disabled="groupBusy || !memberGroupName" @click="void createMemberGroup()">
                创建成员集
              </button>
            </div>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="memberGroupSearch"
                class="delegation-page__input"
                type="search"
                placeholder="搜索成员集"
                @keyup.enter="void loadMemberGroups()"
              />
              <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="groupBusy" @click="void loadMemberGroups()">
                查询成员集
              </button>
              <select v-model="selectedMemberGroupId" class="delegation-page__input" @change="void selectMemberGroup(selectedMemberGroupId)">
                <option value="">请选择成员集</option>
                <option v-for="group in memberGroups" :key="group.id" :value="group.id">
                  {{ group.name }} ({{ group.memberCount }})
                </option>
              </select>
              <button
                class="delegation-page__button"
                type="button"
                :disabled="groupBusy || !memberWritesReady || !hasSelectedMemberGroup || !selectedUserId"
                @click="void updateUserMemberGroup('assign')"
              >
                将当前成员加入成员集
              </button>
            </div>

            <template v-if="selectedMemberGroup">
              <div class="delegation-page__section">
                <h3>{{ selectedMemberGroup.name }}</h3>
                <p class="delegation-page__hint">{{ selectedMemberGroup.description || '暂无说明' }}</p>
                <div v-if="selectedMemberGroup.members.length > 0" class="delegation-page__role-list">
                  <article v-for="member in selectedMemberGroup.members" :key="member.id" class="delegation-page__role-card">
                    <strong>{{ member.name || member.email }}</strong>
                    <span>{{ member.email }}</span>
                    <p>{{ member.role }} · {{ member.isActive ? '启用' : '停用' }}</p>
                    <div class="delegation-page__chips">
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.platformAdminEnabled }">
                        {{ member.platformAdminEnabled ? '平台管理员' : '非平台管理员' }}
                      </span>
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.attendanceAdminEnabled }">
                        {{ member.attendanceAdminEnabled ? '考勤管理员' : '非考勤管理员' }}
                      </span>
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.dingtalkLoginEnabled }">
                        {{ member.dingtalkLoginEnabled ? '钉钉已开通' : '钉钉未开通' }}
                      </span>
                      <span class="delegation-page__chip" :class="{ 'delegation-page__chip--success': member.directoryLinked }">
                        {{ member.directoryLinked ? '目录已链接' : '目录未链接' }}
                      </span>
                    </div>
                    <p v-if="member.businessRoleIds.length > 0">业务角色：{{ member.businessRoleIds.join(', ') }}</p>
                    <button
                      class="delegation-page__button delegation-page__button--danger"
                      type="button"
                      :disabled="groupBusy"
                      @click="void updateUserMemberGroup('unassign', member.id)"
                    >
                      移出成员集
                    </button>
                  </article>
                </div>
                <div v-else class="delegation-page__empty">
                  该成员集还没有成员。
                </div>
              </div>
            </template>
          </div>

          <div v-if="summary?.isPlatformAdmin && selectedScopeConfig" class="delegation-page__section">
            <h3>插件管理员范围配置</h3>
            <p class="delegation-page__hint">平台管理员配置管理范围。部门范围可以选择是否包含下级部门。成员集是共享成员组。同一命名空间内，部门范围与共享成员组取并集。委派管理员只能给允许的成员分配允许的角色。</p>
            <div v-if="selectedScopeConfig.adminNamespaces.length === 0" class="delegation-page__empty">
              该成员尚未持有任何插件管理员角色。
            </div>
            <template v-else>
              <div class="delegation-page__role-actions">
                <select v-model="selectedScopeNamespace" class="delegation-page__input">
                  <option value="">请选择管理员命名空间</option>
                  <option v-for="namespace in selectedScopeConfig.adminNamespaces" :key="namespace" :value="namespace">
                    {{ namespace }}
                  </option>
                </select>
                <input
                  v-model.trim="departmentSearch"
                  class="delegation-page__input"
                  type="search"
                  placeholder="搜索部门路径、部门名或集成名"
                  @keyup.enter="void loadDepartments()"
                />
                <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="scopeBusy" @click="void loadDepartments()">
                  查询部门
                </button>
              </div>
              <div v-if="scopeActivationFieldPresent" data-testid="scope-activation">
                <p class="delegation-page__hint">命名空间委派启停</p>
                <p data-testid="scope-activation-namespace">{{ selectedScopeNamespace || '未选择命名空间' }}</p>
                <p v-if="!readyScopeActivation" data-testid="scope-activation-unavailable">当前命名空间没有唯一的启停状态，不能启用或停止。</p>
                <template v-else>
                  <p data-testid="scope-activation-state">{{ activationStateText }}</p>
                  <p v-if="readyScopeActivation && readyScopeActivation.hasConfiguredScope !== true" data-testid="scope-activation-empty-scope">还没有可启用的范围。保存范围或套用模板不会自动启用委派。</p>
                  <div class="delegation-page__role-actions">
                    <button
                      v-if="canEnableScopeActivation"
                      class="delegation-page__button"
                      type="button"
                      data-testid="scope-activation-enable"
                      :disabled="scopeBusy || activationWriting || !memberWritesReady"
                      @click="openScopeActivation(true)"
                    >
                      启用委派
                    </button>
                    <button
                      v-if="canStopScopeActivation"
                      class="delegation-page__button delegation-page__button--danger"
                      type="button"
                      data-testid="scope-activation-stop"
                      :disabled="scopeBusy || activationWriting || !memberWritesReady"
                      @click="openScopeActivation(false)"
                    >
                      停止委派
                    </button>
                  </div>
                </template>
              </div>
              <p v-if="activationPendingAttempt" data-testid="scope-activation-pending">{{ activationPendingMessage }}</p>
              <button
                v-if="activationPendingAttempt"
                class="delegation-page__button delegation-page__button--secondary"
                type="button"
                data-testid="scope-activation-reread"
                :disabled="scopeBusy || activationWriting"
                @click="void rereadScopeActivation()"
              >
                只读刷新委派启停
              </button>
              <div class="delegation-page__role-actions">
                <select v-model="selectedDepartmentId" class="delegation-page__input">
                  <option value="">请选择部门</option>
                  <option v-for="department in departments" :key="department.directoryDepartmentId" :value="department.directoryDepartmentId">
                    {{ department.integrationName }} / {{ department.departmentFullPath || department.departmentName }}
                  </option>
                </select>
                <label class="delegation-page__check">
                  <input
                    data-testid="scope-include-children"
                    type="checkbox"
                    :checked="includeChildren"
                    :disabled="exactDepartmentChoiceLocked(includeChildren)"
                    @change="onIncludeChildrenChange($event, 'scope')"
                  />
                  包含下级部门
                </label>
                <span data-testid="scope-include-children-value">{{ departmentScopeChoiceLabel(includeChildren) }}</span>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !memberWritesReady || !selectedScopeNamespace || !selectedDepartmentId || directExactAssignBlocked" @click="void updateScope('assign')">
                  添加部门范围
                </button>
              </div>
              <p v-if="!exactDepartmentWritesEnabled" class="delegation-page__hint" data-testid="exact-department-unavailable">{{ exactDepartmentUnavailableText }}</p>
              <div class="delegation-page__role-actions">
                <select v-model="selectedAudienceGroupId" class="delegation-page__input">
                  <option value="">请选择平台成员集</option>
                  <option v-for="group in memberGroups" :key="group.id" :value="group.id">
                    {{ group.name }} ({{ group.memberCount }})
                  </option>
                </select>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !memberWritesReady || !selectedScopeNamespace || !selectedAudienceGroupId" @click="void updateScopeGroup('assign')">
                  添加成员集范围
                </button>
              </div>
              <div v-if="selectedScopeConfig.scopeAssignments.length > 0" class="delegation-page__scope-list">
                <article v-for="scope in selectedScopeConfig.scopeAssignments" :key="scope.id" class="delegation-page__scope-card">
                  <strong>{{ scope.namespace }}</strong>
                  <span>{{ scope.integrationName }}</span>
                  <p>{{ scope.departmentFullPath || scope.departmentName }}</p>
                  <p data-testid="department-scope-choice">{{ departmentScopeChoiceLabel(scope.includeChildren) }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy || !memberWritesReady"
                    @click="void updateScope('unassign', scope)"
                  >
                    移除部门范围
                  </button>
                </article>
              </div>
              <div v-if="selectedScopeConfig.groupAssignments.length > 0" class="delegation-page__scope-list">
                <article v-for="group in selectedScopeConfig.groupAssignments" :key="group.id" class="delegation-page__scope-card">
                  <strong>{{ group.namespace }}</strong>
                  <span>{{ group.name }}</span>
                  <p>{{ group.description || `成员 ${group.memberCount}` }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy || !memberWritesReady"
                    @click="void updateScopeGroup('unassign', group)"
                  >
                    移除成员集范围
                  </button>
                </article>
              </div>
              <div
                v-if="selectedScopeConfig.scopeAssignments.length === 0 && selectedScopeConfig.groupAssignments.length === 0"
                class="delegation-page__empty"
              >
                该成员尚未配置任何插件管理员范围。
              </div>
            </template>
          </div>

          <div v-if="summary?.isPlatformAdmin" class="delegation-page__section">
            <h3>组织范围模板</h3>
            <p class="delegation-page__hint">模板用于复用一组部门范围与平台成员集，再一键覆盖到某个插件管理员命名空间。</p>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="templateName"
                class="delegation-page__input"
                type="text"
                placeholder="模板名称，例如 华东销售"
              />
              <input
                v-model.trim="templateDescription"
                class="delegation-page__input"
                type="text"
                placeholder="模板说明，可选"
              />
              <button class="delegation-page__button" type="button" :disabled="scopeBusy || !templateName" @click="void createTemplate()">
                创建模板
              </button>
            </div>
            <div class="delegation-page__role-actions">
              <input
                v-model.trim="templateSearch"
                class="delegation-page__input"
                type="search"
                placeholder="搜索模板"
                @keyup.enter="void loadTemplates()"
              />
              <button class="delegation-page__button delegation-page__button--secondary" type="button" :disabled="scopeBusy" @click="void loadTemplates(true)">
                查询模板
              </button>
              <select v-model="selectedTemplateId" class="delegation-page__input" :disabled="scopeBusy" @change="void selectTemplate(selectedTemplateId)">
                <option value="">请选择模板</option>
                <option v-for="template in templates" :key="template.id" :value="template.id">
                  {{ template.name }} ({{ template.departmentCount }})
                </option>
              </select>
              <button
                class="delegation-page__button"
                type="button"
                :disabled="scopeBusy || !memberWritesReady || !selectedTemplateScopeVersion || !selectedScopeNamespace || !selectedScopeConfig?.adminNamespaces.length || exactDepartmentApplyBlocked"
                @click="void applyTemplate()"
              >
                覆盖应用到当前命名空间
              </button>
            </div>
            <p v-if="selectedTemplate && !selectedTemplateScopeVersion" class="delegation-page__hint">未读取到模板版本。请重新查询模板后再应用。</p>
            <p v-if="exactDepartmentApplyBlocked" class="delegation-page__hint" data-testid="exact-department-apply-unavailable">{{ exactDepartmentApplyUnavailableText }}</p>

            <template v-if="selectedTemplate">
              <div class="delegation-page__role-actions">
                <select v-model="selectedTemplateDepartmentId" class="delegation-page__input">
                  <option value="">选择部门加入模板</option>
                  <option v-for="department in departments" :key="department.directoryDepartmentId" :value="department.directoryDepartmentId">
                    {{ department.integrationName }} / {{ department.departmentFullPath || department.departmentName }}
                  </option>
                </select>
                <label class="delegation-page__check">
                  <input
                    data-testid="template-include-children"
                    type="checkbox"
                    :checked="templateIncludeChildren"
                    :disabled="exactDepartmentChoiceLocked(templateIncludeChildren)"
                    @change="onIncludeChildrenChange($event, 'template')"
                  />
                  包含下级部门
                </label>
                <span data-testid="template-include-children-value">{{ departmentScopeChoiceLabel(templateIncludeChildren) }}</span>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !selectedTemplateDepartmentId || templateExactAssignBlocked" @click="void updateTemplateDepartment('assign')">
                  添加模板部门
                </button>
              </div>
              <p v-if="!exactDepartmentWritesEnabled" class="delegation-page__hint" data-testid="exact-department-unavailable">{{ exactDepartmentUnavailableText }}</p>
              <div class="delegation-page__role-actions">
                <select v-model="selectedTemplateMemberGroupId" class="delegation-page__input">
                  <option value="">选择成员集加入模板</option>
                  <option v-for="group in memberGroups" :key="group.id" :value="group.id">
                    {{ group.name }} ({{ group.memberCount }})
                  </option>
                </select>
                <button class="delegation-page__button" type="button" :disabled="scopeBusy || !selectedTemplateMemberGroupId" @click="void updateTemplateMemberGroup('assign')">
                  添加模板成员集
                </button>
              </div>

              <div v-if="selectedTemplate.departments.length > 0" class="delegation-page__scope-list">
                <article v-for="department in selectedTemplate.departments" :key="department.directoryDepartmentId" class="delegation-page__scope-card">
                  <strong>{{ selectedTemplate.name }}</strong>
                  <span>{{ department.integrationName }}</span>
                  <p>{{ department.departmentFullPath || department.departmentName }}</p>
                  <p data-testid="department-scope-choice">{{ departmentScopeChoiceLabel(department.includeChildren) }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy"
                    @click="void updateTemplateDepartment('unassign', department.directoryDepartmentId)"
                  >
                    移除模板部门
                  </button>
                </article>
              </div>
              <div v-if="selectedTemplate.memberGroups.length > 0" class="delegation-page__scope-list">
                <article v-for="group in selectedTemplate.memberGroups" :key="group.id" class="delegation-page__scope-card">
                  <strong>{{ selectedTemplate.name }}</strong>
                  <span>{{ group.name }}</span>
                  <p>{{ group.description || `成员 ${group.memberCount}` }}</p>
                  <button
                    class="delegation-page__button delegation-page__button--danger"
                    type="button"
                    :disabled="scopeBusy"
                    @click="void updateTemplateMemberGroup('unassign', group.id)"
                  >
                    移除模板成员集
                  </button>
                </article>
              </div>
              <div
                v-if="selectedTemplate.departments.length === 0 && selectedTemplate.memberGroups.length === 0"
                class="delegation-page__empty"
              >
                当前模板还没有任何部门或成员集范围。
              </div>
            </template>
          </div>
        </template>

        <div v-else class="delegation-page__empty">
          请选择一个成员
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAdminAuthorizationOperation } from '../composables/useAdminAuthorizationOperation'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'
import type {
  AdminAuthorizationAction,
  AdminAuthorizationImpact,
  AdminAuthorizationReceipt,
  AdminAuthorizationRequest,
  AdminAuthorizationScopeCleanup,
  AdminAuthorizationTransportRequest,
  AdminAuthorizationTransportResponse,
} from '../utils/adminAuthorizationOperation'
import DelegationConfirmationPanel from './DelegationConfirmationPanel.vue'
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AUTHORIZATION_NOT_CHECKED_MESSAGE,
  AUTHORIZATION_PENDING_MESSAGE,
  AUTHORIZATION_PREVIEW_FAILED_MESSAGE,
  AUTHORIZATION_PRINCIPAL_MISSING_MESSAGE,
  LAST_PLATFORM_ADMIN_MESSAGE,
  ROLE_VERSION_MISMATCH_MESSAGE,
  describeVerifiedAuthorization,
} from './AdminAuthorizationConfirm'
import {
  delegationConfirmationStillValid,
  openDelegationConfirmation,
  PLATFORM_ADMIN_REVOKE_PHRASE,
  PLATFORM_ADMIN_ROLE_ID,
  readCatalogExpectedUpdatedAt,
  type DelegationConfirmation,
  type DelegationPermissionListing,
} from './delegationConfirmation'
import { presentRoleTitle } from './builtinCatalogPresentation'

type ManagedUser = {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
}

type SelectableCandidate = ManagedUser & { selectable: true }

type DisabledCandidate = {
  id: string
  name: string | null
  selectable: false
  disabledReason: string
}

type UserCandidate = SelectableCandidate | DisabledCandidate

type RoleCatalogItem = {
  id: string
  name: string
  permissions?: unknown
  updatedAt?: string
}

type ScopeAssignment = {
  id: string
  namespace: string
  directoryDepartmentId: string
  integrationId: string
  integrationName: string
  provider: string
  corpId: string | null
  externalDepartmentId: string
  departmentName: string
  departmentFullPath: string | null
  departmentActive: boolean
  includeChildren?: boolean
}

type GroupAssignment = {
  id: string
  namespace: string
  groupId: string
  name: string
  description: string | null
  memberCount: number
}

type DepartmentCatalogItem = {
  directoryDepartmentId: string
  integrationId: string
  integrationName: string
  provider: string
  corpId: string | null
  externalDepartmentId: string
  departmentName: string
  departmentFullPath: string | null
  departmentActive: boolean
  includeChildren?: boolean
}

type MemberGroupSummary = {
  id: string
  name: string
  description: string | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  memberCount: number
}

type MemberGroupMember = {
  id: string
  email: string
  name: string | null
  role: string
  isActive: boolean
  isAdmin: boolean
  roles: string[]
  platformAdminEnabled: boolean
  attendanceAdminEnabled: boolean
  businessRoleIds: string[]
  dingtalkLoginEnabled: boolean
  directoryLinked: boolean
}

type MemberGroupDetail = MemberGroupSummary & {
  members: MemberGroupMember[]
}

type DelegationSummary = {
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
  exactDepartmentScopeAvailable?: unknown
  roleCatalog: RoleCatalogItem[]
  scopeAssignments: ScopeAssignment[]
  groupAssignments: GroupAssignment[]
}

type DelegatedUserAccess = {
  actorId: string
  isPlatformAdmin: boolean
  delegableNamespaces: string[]
  roleCatalog: RoleCatalogItem[]
  scopeAssignments: ScopeAssignment[]
  groupAssignments: GroupAssignment[]
  memberGroups: MemberGroupSummary[]
  user: ManagedUser
  roles: string[]
  delegableRoles: string[]
  namespaceAdmissions: NamespaceAdmission[]
  manageableNamespaces?: string[]
}

type NamespaceAdmission = {
  namespace: string
  enabled: boolean
  effective: boolean
  hasRole: boolean
  updatedAt: string | null
}

type ScopeActivation = {
  namespace: string
  enabled: boolean
  hasConfiguredScope: boolean
  version: string
}

type ScopeActivationAttempt = {
  actorId: string
  userId: string
  namespace: string
  enabled: boolean
  expectedVersion: string
  accessGeneration: number
  namespaceGeneration: number
}

type DelegatedAdminScopeConfig = {
  actorId: string
  user: ManagedUser
  adminNamespaces: string[]
  scopeAssignments: ScopeAssignment[]
  groupAssignments: GroupAssignment[]
  scopeActivations?: unknown
}

type ScopeTemplateSummary = {
  id: string
  name: string
  description: string | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  departmentCount: number
}

type ScopeTemplateDetail = ScopeTemplateSummary & {
  scopeVersion?: string
  departments: DepartmentCatalogItem[]
  memberGroups: MemberGroupSummary[]
}

const loading = ref(false)
const busy = ref(false)
const scopeBusy = ref(false)
const groupBusy = ref(false)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
const search = ref('')
const departmentSearch = ref('')
const templateSearch = ref('')
const templateName = ref('')
const templateDescription = ref('')
const memberGroupSearch = ref('')
const memberGroupName = ref('')
const memberGroupDescription = ref('')
const users = ref<UserCandidate[]>([])
const usersForbidden = ref(false)
const includeChildren = ref(true)
const templateIncludeChildren = ref(true)
const exactDepartmentBlocked = ref(false)
const pendingConfirmation = ref<DelegationConfirmation | null>(null)
const pendingAdmissionEnabled = ref<boolean | null>(null)
const confirmationSubmission = ref<{ token: number, phase: 'pending' | 'completed' } | null>(null)
const confirmationReadAgain = ref(false)
const restoredReadAgain = ref(false)
const submittedAuthorization = ref<AdminAuthorizationRequest | null>(null)
let authorizationFaultCode = ''
let authorizationFaultMessage = ''
const confirmationPhase = computed(() => (
  confirmationSubmission.value && pendingConfirmation.value
  && confirmationSubmission.value.token === pendingConfirmation.value.token
    ? confirmationSubmission.value.phase
    : 'review'
))
const auth = useAuth()
const departments = ref<DepartmentCatalogItem[]>([])
const templates = ref<ScopeTemplateSummary[]>([])
const memberGroups = ref<MemberGroupSummary[]>([])
const selectedUserId = ref('')

function currentPrincipalId(): string {
  const reader = auth.getCurrentUser
  if (typeof reader !== 'function') return ''
  const user = reader()
  if (!user || typeof user !== 'object') return ''
  const id = (user as { id?: unknown }).id
  return typeof id === 'string' ? id.trim() : ''
}

async function authorizationTransport(
  request: AdminAuthorizationTransportRequest,
): Promise<AdminAuthorizationTransportResponse> {
  const token = currentMemberToken()
  const response = await apiFetch(request.path, {
    method: request.method,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
  })
  const body = await readJson(response)
  if (request.method === 'POST' && response.status >= 400 && memberTokenCurrent(token)) {
    authorizationFaultCode = readErrorCode(body)
    authorizationFaultMessage = readErrorMessage(body)
  }
  return { status: response.status, body }
}

const authorizationOperation = useAdminAuthorizationOperation({
  transport: authorizationTransport,
  getPrincipalId: () => currentPrincipalId(),
  getTargetId: () => selectedUserId.value.trim(),
  verifyLive: () => verifyDelegationAuthorization(),
})

function currentAuthorizationPhase() {
  return authorizationOperation.phase.value
}
const confirmationImpact = computed<AdminAuthorizationImpact | null>(() => (
  pendingConfirmation.value ? authorizationOperation.impact.value : null
))
const confirmationConfirmReady = computed(() => (
  confirmationPhase.value === 'review'
  && authorizationOperation.phase.value === 'awaiting_confirmation'
  && pendingConfirmation.value?.targetUserId === selectedUserId.value
))

const selectedRoleId = ref('')
const selectedRevokeRoleId = ref('')
const selectedScopeNamespace = ref('')
const selectedDepartmentId = ref('')
const selectedAudienceGroupId = ref('')
const selectedTemplateDepartmentId = ref('')
const selectedTemplateMemberGroupId = ref('')
const selectedTemplateId = ref('')
const selectedMemberGroupId = ref('')
const summary = ref<DelegationSummary | null>(null)
const selectedAccess = ref<DelegatedUserAccess | null>(null)
const selectedScopeConfig = ref<DelegatedAdminScopeConfig | null>(null)
const activationConfirming = ref<ScopeActivationAttempt | null>(null)
const activationPendingAttempt = ref<ScopeActivationAttempt | null>(null)
const activationWriting = ref(false)
const activationDialogRef = ref<HTMLElement | null>(null)
let activationFlight: ScopeActivationAttempt | null = null
let activationReturnFocus: HTMLElement | null = null
let activationReadSerial = 0
const selectedTemplate = ref<ScopeTemplateDetail | null>(null)
const selectedTemplateScopeVersion = computed(() => {
  const item = selectedTemplate.value
  if (!item || item.id !== selectedTemplateId.value) return null
  return typeof item.scopeVersion === 'string' && /^[a-f0-9]{64}$/.test(item.scopeVersion) ? item.scopeVersion : null
})
const selectedMemberGroup = ref<MemberGroupDetail | null>(null)

const hasSelectedMemberGroup = computed(() => (
  !!selectedMemberGroupId.value
  && memberGroups.value.some((group) => group.id === selectedMemberGroupId.value)
))

const memberWritesReady = computed(() => {
  const userId = selectedUserId.value
  if (!userId || selectedAccess.value?.user.id !== userId) return false
  if (summary.value?.isPlatformAdmin && selectedScopeConfig.value?.user.id !== userId) return false
  return true
})

const selectedUserDisabled = computed(() => {
  const row = users.value.find((user) => user.id === selectedUserId.value)
  return row?.selectable === false
})

const EXACT_DEPARTMENT_DISABLED_CODE = 'DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED'
const exactDepartmentUnavailableText = '当前不能新建仅本部门的范围。新的部门范围需要包含下级部门。已经保存的仅本部门仍会按原样显示，可以改为包含下级，也可以移除。'
const exactDepartmentApplyUnavailableText = '这个模板含有仅本部门的范围，当前不能覆盖应用。已经保存的仅本部门仍会按原样显示，可以改为包含下级，也可以从模板中移除。'
const activationEnableEffect = '启用后，该成员可以在此命名空间内按已保存的范围委派。启用不会修改角色、插件使用准入或已保存的范围。'
const activationStopEffect = '停止后仍可以保存范围，但不能委派。角色、插件使用准入和已保存的范围都保持不变。'
const activationPendingMessage = '委派启停已提交，但结果尚未核对。请只读刷新当前成员的这一命名空间，不会自动重新提交。'

const exactDepartmentWritesEnabled = computed(() => (
  summary.value?.exactDepartmentScopeAvailable === true && exactDepartmentBlocked.value === false
))
const directExactAssignBlocked = computed(() => (
  !exactDepartmentWritesEnabled.value && includeChildren.value !== true
))
const templateExactAssignBlocked = computed(() => (
  !exactDepartmentWritesEnabled.value && templateIncludeChildren.value !== true
))
const exactDepartmentApplyBlocked = computed(() => (
  !exactDepartmentWritesEnabled.value && templateContainsExactDepartment(selectedTemplate.value)
))

watch(selectedUserId, (userId, previous) => {
  if (previous !== userId) resetMemberScopedState()
  const pending = pendingConfirmation.value
  if (pending && pending.targetUserId !== userId && confirmationPhase.value !== 'pending') {
    pendingConfirmation.value = null
    confirmationReadAgain.value = false
  }
  authorizationOperation.syncContext()
  presentAdoptedDelegation()
}, { flush: 'sync' })

watch(busy, (isBusy) => {
  if (!isBusy) presentAdoptedDelegation()
})

watch(selectedScopeNamespace, () => {
  scopeNamespaceGeneration += 1
  activationPendingAttempt.value = null
  dismissActivationConfirmation()
})

watch(() => authorizationOperation.phase.value, () => {
  presentAdoptedDelegation()
})

watch(delegationPermissionFingerprint, (next, previous) => {
  if (!previous || next === previous) return
  const pending = pendingConfirmation.value
  if (!pending || confirmationPhase.value !== 'review') return
  if (!next.startsWith(`${pending.targetUserId}|`)) {
    pendingConfirmation.value = null
    return
  }
  const request = requestForConfirmation(pending)
  if (!request) {
    pendingConfirmation.value = null
    return
  }
  submittedAuthorization.value = request
  void previewDelegationRequest(request)
})

watch(selectedRoleId, (roleId) => {
  const pending = pendingConfirmation.value
  if (confirmationPhase.value === 'review' && pending?.kind === 'grant' && pending.roleId !== roleId) pendingConfirmation.value = null
})

watch(selectedRevokeRoleId, (roleId) => {
  const pending = pendingConfirmation.value
  if (confirmationPhase.value === 'review' && pending?.kind === 'revoke' && pending.roleId !== roleId) pendingConfirmation.value = null
})

let statusScope: 'page' | 'member' = 'page'
let statusMemberId = ''
let busyToken: MemberToken | null = null

type MemberToken = { userId: string; generation: number }

function currentMemberToken(): MemberToken {
  return { userId: selectedUserId.value, generation: delegationAccessGeneration }
}

function memberTokenCurrent(token: MemberToken): boolean {
  return token.userId.length > 0 && delegationReadStillCurrent(token.generation, token.userId)
}

function claimMemberBusy(token: MemberToken): void {
  busyToken = token
  busy.value = true
}

function releaseMemberBusy(token: MemberToken): void {
  if (!busyToken || busyToken.generation !== token.generation || busyToken.userId !== token.userId) return
  busy.value = false
  busyToken = null
}

function memberBusyBlocksRecovery(): boolean {
  return busy.value && busyToken !== null && memberTokenCurrent(busyToken)
}

function presentAdoptedDelegation(): void {
  if (confirmationSubmission.value || pendingConfirmation.value || memberBusyBlocksRecovery()) return
  const phase = currentAuthorizationPhase()
  if (phase !== 'pending' && phase !== 'unverified_no_read' && phase !== 'committed') return
  if (!authorizationOperation.clientOperationId.value) return
  if (phase === 'committed' && authorizationOperation.verified.value) return
  const receipt = authorizationOperation.receipt.value
  if (receipt && receipt.targetUserId !== selectedUserId.value) return
  if (phase === 'committed' && receipt) {
    void publishVerifiedDelegation(delegationAccessGeneration, receipt.targetUserId)
    return
  }
  restoredReadAgain.value = true
  setMemberStatus(currentMemberToken(), AUTHORIZATION_PENDING_MESSAGE, 'error')
}

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  status.value = message
  statusTone.value = tone
  statusScope = 'page'
  statusMemberId = ''
}

function setMemberStatus(token: MemberToken, message: string, tone: 'info' | 'error' = 'info'): void {
  if (!memberTokenCurrent(token)) return
  status.value = message
  statusTone.value = tone
  statusScope = 'member'
  statusMemberId = token.userId
}

function noteMemberLeftScope(token: MemberToken, message: string): void {
  if (token.userId.length === 0 || selectedUserId.value !== '') return
  if (delegationAccessGeneration !== token.generation + 1) return
  status.value = message
  statusTone.value = 'error'
  statusScope = 'member'
  statusMemberId = token.userId
}

function resetMemberScopedState(): void {
  delegationAccessGeneration += 1
  if (busyToken && !memberTokenCurrent(busyToken)) {
    busy.value = false
    busyToken = null
  }
  if (statusScope === 'member' && statusMemberId !== selectedUserId.value) {
    status.value = ''
    statusTone.value = 'info'
    statusScope = 'page'
    statusMemberId = ''
  }
  submittedAuthorization.value = null
  confirmationReadAgain.value = false
  restoredReadAgain.value = false
  authorizationFaultCode = ''
  authorizationFaultMessage = ''
  if (!pendingConfirmation.value || pendingConfirmation.value.targetUserId !== selectedUserId.value) {
    confirmationSubmission.value = null
  }
  activationPendingAttempt.value = null
  dismissActivationConfirmation()
}

function readLocationUserId(): string {
  if (typeof window === 'undefined') return ''
  return new URL(window.location.href).searchParams.get('userId')?.trim() || ''
}

let delegationAccessGeneration = 0
let scopeNamespaceGeneration = 0
let usersRequestGeneration = 0
let summaryRequestGeneration = 0
const initialPinnedUserId = readLocationUserId()
let pinnedUserPending = initialPinnedUserId.length > 0

function departmentScopeChoiceLabel(value: unknown): string {
  if (value === true) return '包含下级部门'
  if (value === false) return '仅本部门'
  return '未返回是否包含下级'
}

function templateContainsExactDepartment(template: ScopeTemplateDetail | null): boolean {
  if (!template || !Array.isArray(template.departments)) return false
  return template.departments.some((department) => department.includeChildren === false)
}

function exactDepartmentChoiceLocked(checked: boolean): boolean {
  return !exactDepartmentWritesEnabled.value && checked === true
}

function noteExactDepartmentDisabledByServer(): void {
  exactDepartmentBlocked.value = true
  summaryRequestGeneration += 1
}

function isExactDepartmentDisabledResponse(response: { status?: number }, payload: Record<string, unknown>): boolean {
  if (response.status !== 403) return false
  const error = payload.error
  if (!error || typeof error !== 'object') return false
  return (error as { code?: unknown }).code === EXACT_DEPARTMENT_DISABLED_CODE
}

function onIncludeChildrenChange(event: Event, target: 'scope' | 'template'): void {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const current = target === 'scope' ? includeChildren.value : templateIncludeChildren.value
  if (!input.checked && !exactDepartmentWritesEnabled.value) {
    input.checked = current
    setStatus(exactDepartmentUnavailableText, 'error')
    return
  }
  if (target === 'scope') includeChildren.value = input.checked
  else templateIncludeChildren.value = input.checked
}

function candidatePrimaryLabel(user: UserCandidate): string {
  if (user.selectable === false) return user.name || user.id
  return user.name || user.email
}

function candidateEmail(user: UserCandidate): string {
  return user.selectable === false ? '' : user.email
}

function candidateMeta(user: UserCandidate): string {
  if (user.selectable === false) return ''
  return `${user.role} · ${user.is_active ? '启用' : '停用'}`
}

const OUT_OF_MANAGEMENT_SCOPE_CODE = 'ROLE_DELEGATION_USER_OUT_OF_SCOPE'
const OUT_OF_MANAGEMENT_SCOPE_REASON = '这个人不在您可管理的部门或成员组里。'

function candidateDisabledReason(user: UserCandidate): string {
  if (user.selectable !== false) return ''
  const reason = user.disabledReason.trim()
  if (reason === OUT_OF_MANAGEMENT_SCOPE_CODE) return OUT_OF_MANAGEMENT_SCOPE_REASON
  return reason ? user.disabledReason : ''
}

function normalizeUserCandidate(raw: unknown): UserCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id) return null
  const name = typeof record.name === 'string' ? record.name : null
  if ('selectable' in record && typeof record.selectable !== 'boolean') {
    return {
      id: record.id,
      name,
      selectable: false,
      disabledReason: '成员标记无效',
    }
  }
  if (record.selectable === false) {
    return {
      id: record.id,
      name,
      selectable: false,
      disabledReason: typeof record.disabledReason === 'string' ? record.disabledReason : '',
    }
  }
  return {
    id: record.id,
    email: typeof record.email === 'string' ? record.email : '',
    name,
    role: typeof record.role === 'string' ? record.role : '',
    is_active: record.is_active !== false,
    selectable: true,
  }
}

function permissionListingFor(role: RoleCatalogItem | undefined): { permissions: string[]; permissionListing: DelegationPermissionListing } {
  if (!role || !Array.isArray(role.permissions)) return { permissions: [], permissionListing: 'unknown' }
  const permissions = role.permissions.filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
  if (role.permissions.length === 0) return { permissions: [], permissionListing: 'empty' }
  if (permissions.length === 0) return { permissions: [], permissionListing: 'unknown' }
  return { permissions, permissionListing: 'listed' }
}

function rolePermissionLabel(role: RoleCatalogItem): string {
  const listing = permissionListingFor(role)
  if (listing.permissionListing === 'empty') return '无权限映射'
  if (listing.permissionListing === 'unknown') return '目录未提供权限码'
  return listing.permissions.join(', ')
}

function namespaceIsManaged(namespace: string): boolean {
  if (selectedAccess.value?.isPlatformAdmin === true) return true
  const managed = selectedAccess.value?.manageableNamespaces
  if (!Array.isArray(managed)) return false
  return managed.includes(namespace)
}

function roleActionAllowed(roleId: string, action: 'assign' | 'unassign'): boolean {
  const access = selectedAccess.value
  if (!access || !roleId) return false
  if (action === 'unassign') {
    return Array.isArray(access.delegableRoles) && access.delegableRoles.includes(roleId)
  }
  const role = Array.isArray(access.roleCatalog)
    ? access.roleCatalog.find((candidate) => candidate.id === roleId)
    : undefined
  if (!role) return false
  if (access.isPlatformAdmin === true) return true
  return Array.isArray(role.permissions)
}

function assignmentEchoesIncludeChildren(
  assignments: unknown,
  directoryDepartmentId: string,
  requested: boolean,
  namespace?: string,
): boolean {
  if (!Array.isArray(assignments)) return false
  const match = assignments.find((item) => {
    if (!item || typeof item !== 'object') return false
    const record = item as { directoryDepartmentId?: unknown; namespace?: unknown }
    if (record.directoryDepartmentId !== directoryDepartmentId) return false
    // Template departments are not namespaced. Direct scopes repeat one department across namespaces.
    return namespace === undefined || record.namespace === namespace
  }) as { includeChildren?: unknown } | undefined
  return match?.includeChildren === requested
}

function targetLabelFor(user: ManagedUser): string {
  return user.name || user.email || user.id
}

function invalidateSelection(): void {
  selectedUserId.value = ''
  selectedAccess.value = null
  selectedScopeConfig.value = null
  selectedRoleId.value = ''
  selectedRevokeRoleId.value = ''
  selectedDepartmentId.value = ''
  selectedAudienceGroupId.value = ''
  pendingConfirmation.value = null
}

function clearUnpinnedSelection(): void {
  selectedUserId.value = ''
  selectedAccess.value = null
  selectedScopeConfig.value = null
  selectedRoleId.value = ''
  selectedRevokeRoleId.value = ''
  selectedDepartmentId.value = ''
  selectedAudienceGroupId.value = ''
  pendingConfirmation.value = null
}

function roleTitle(role: { id: string; name: string }): string {
  return presentRoleTitle(role)
}

function delegationReadStillCurrent(generation: number, userId: string): boolean {
  return generation === delegationAccessGeneration && selectedUserId.value === userId
}

function sameDelegationActor(actorId: string, generation: number, targetUserId: string): boolean {
  return actorId.length > 0
    && currentPrincipalId() === actorId
    && delegationReadStillCurrent(generation, targetUserId)
}

function delegationPermissionFingerprint(): string {
  const access = selectedAccess.value
  if (!access) return ''
  const roles = [...access.roles].sort().join(',')
  const admissions = access.namespaceAdmissions
    .map((item) => `${item.namespace}:${item.enabled ? '1' : '0'}`)
    .join(',')
  return `${access.user.id}|${roles}|${admissions}`
}

function readErrorCode(payload: Record<string, unknown>): string {
  const error = payload.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code
    if (typeof code === 'string') return code
  }
  return typeof payload.code === 'string' ? payload.code : ''
}

function readErrorMessage(payload: Record<string, unknown>): string {
  const error = payload.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return ''
}

function readSubjectMatches(payload: Record<string, unknown>, userId: string): boolean {
  const data = payload.data
  if (!data || typeof data !== 'object') return false
  const user = (data as { user?: { id?: unknown } }).user
  return typeof user?.id === 'string' && user.id === userId
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function loadSummary(): Promise<void> {
  const requestGeneration = ++summaryRequestGeneration
  const response = await apiFetch('/api/admin/role-delegation/summary')
  const payload = await readJson(response)
  if (requestGeneration !== summaryRequestGeneration) return
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载角色委派摘要失败'))
  }
  summary.value = payload.data as DelegationSummary
  exactDepartmentBlocked.value = false
}

async function loadDepartments(): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  scopeBusy.value = true
  try {
    const params = new URLSearchParams()
    if (departmentSearch.value) params.set('q', departmentSearch.value)
    const response = await apiFetch(`/api/admin/role-delegation/departments${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载部门目录失败'))
    }
    const data = payload.data as { items?: DepartmentCatalogItem[] } | undefined
    departments.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载部门目录失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function loadMemberGroups(): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  groupBusy.value = true
  try {
    const params = new URLSearchParams()
    if (memberGroupSearch.value) params.set('q', memberGroupSearch.value)
    const response = await apiFetch(`/api/admin/role-delegation/member-groups${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载平台成员集失败'))
    }
    const data = payload.data as { items?: MemberGroupSummary[] } | undefined
    memberGroups.value = Array.isArray(data?.items) ? data.items : []
    const selectedStillExists = memberGroups.value.some((group) => group.id === selectedMemberGroupId.value)
    if (selectedMemberGroupId.value && !selectedStillExists) {
      selectedMemberGroupId.value = ''
      selectedMemberGroup.value = null
    }
    if (selectedMemberGroupId.value && selectedStillExists) {
      await selectMemberGroup(selectedMemberGroupId.value)
    } else if (memberGroups.value.length > 0) {
      await selectMemberGroup(memberGroups.value[0].id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载平台成员集失败', 'error')
  } finally {
    groupBusy.value = false
  }
}

async function selectMemberGroup(groupId: string): Promise<void> {
  selectedMemberGroupId.value = groupId
  if (!summary.value?.isPlatformAdmin || !groupId) {
    selectedMemberGroup.value = null
    return
  }
  const response = await apiFetch(`/api/admin/role-delegation/member-groups/${encodeURIComponent(groupId)}`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载平台成员集详情失败'))
  }
  selectedMemberGroup.value = (payload.data as { item: MemberGroupDetail }).item
}

async function createMemberGroup(): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !memberGroupName.value.trim()) return
  groupBusy.value = true
  try {
    const response = await apiFetch('/api/admin/role-delegation/member-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: memberGroupName.value,
        description: memberGroupDescription.value,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '创建平台成员集失败'))
    }
    const item = (payload.data as { item: MemberGroupDetail }).item
    memberGroupName.value = ''
    memberGroupDescription.value = ''
    await loadMemberGroups()
    await selectMemberGroup(item.id)
    setStatus('平台成员集已创建')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建平台成员集失败', 'error')
  } finally {
    groupBusy.value = false
  }
}

async function loadTemplates(refreshSelected = false): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  scopeBusy.value = true
  try {
    const params = new URLSearchParams()
    if (templateSearch.value) params.set('q', templateSearch.value)
    const response = await apiFetch(`/api/admin/role-delegation/scope-templates${params.size ? `?${params.toString()}` : ''}`)
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载范围模板失败'))
    }
    const data = payload.data as { items?: ScopeTemplateSummary[] } | undefined
    templates.value = Array.isArray(data?.items) ? data.items : []
    const selectedStillExists = templates.value.some((template) => template.id === selectedTemplateId.value)
    if (selectedTemplateId.value && !selectedStillExists) {
      selectedTemplateId.value = ''
      selectedTemplate.value = null
      selectedTemplateDepartmentId.value = ''
      selectedTemplateMemberGroupId.value = ''
    }
    const templateToLoad = selectedTemplateId.value || templates.value[0]?.id
    if (templateToLoad && (refreshSelected || !selectedTemplate.value)) await selectTemplate(templateToLoad)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载范围模板失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function selectTemplate(templateId: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin) return
  selectedTemplateId.value = templateId
  selectedTemplateDepartmentId.value = ''
  selectedTemplateMemberGroupId.value = ''
  selectedTemplate.value = null
  if (!templateId) return
  const response = await apiFetch(`/api/admin/role-delegation/scope-templates/${encodeURIComponent(templateId)}`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载范围模板详情失败'))
  }
  if (selectedTemplateId.value === templateId) {
    selectedTemplate.value = (payload.data as { item: ScopeTemplateDetail }).item
  }
}

async function createTemplate(): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !templateName.value.trim()) return
  scopeBusy.value = true
  try {
    const response = await apiFetch('/api/admin/role-delegation/scope-templates', {
      method: 'POST',
      body: JSON.stringify({
        name: templateName.value,
        description: templateDescription.value,
      }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '创建范围模板失败'))
    }
    const item = (payload.data as { item: ScopeTemplateDetail }).item
    templateName.value = ''
    templateDescription.value = ''
    await loadTemplates()
    await selectTemplate(item.id)
    setStatus('组织范围模板已创建')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建范围模板失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateTemplateDepartment(action: 'assign' | 'unassign', directoryDepartmentId?: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedTemplateId.value) return
  const departmentId = directoryDepartmentId || selectedTemplateDepartmentId.value
  if (!departmentId) return
  if (action === 'assign' && templateIncludeChildren.value !== true && !exactDepartmentWritesEnabled.value) {
    setStatus(exactDepartmentUnavailableText, 'error')
    return
  }
  scopeBusy.value = true
  try {
    const requestedIncludeChildren = templateIncludeChildren.value === true
    const templateDepartmentBody: { directoryDepartmentId: string; includeChildren?: boolean } = {
      directoryDepartmentId: departmentId,
    }
    if (action === 'assign') templateDepartmentBody.includeChildren = requestedIncludeChildren
    const response = await apiFetch(`/api/admin/role-delegation/scope-templates/${encodeURIComponent(selectedTemplateId.value)}/departments/${action}`, {
      method: 'POST',
      body: JSON.stringify(templateDepartmentBody),
    })
    const payload = await readJson(response)
    if (isExactDepartmentDisabledResponse(response, payload)) {
      noteExactDepartmentDisabledByServer()
      throw new Error(exactDepartmentUnavailableText)
    }
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新模板部门失败'))
    }
    const templateItem = (payload.data as { item?: ScopeTemplateDetail } | undefined)?.item
    if (action === 'assign' && !assignmentEchoesIncludeChildren(templateItem?.departments, departmentId, requestedIncludeChildren)) {
      setStatus('返回的是否包含下级与提交不一致', 'error')
      return
    }
    if (!templateItem) {
      setStatus('更新模板部门失败', 'error')
      return
    }
    selectedTemplate.value = templateItem
    if (action === 'assign') {
      selectedTemplateDepartmentId.value = ''
      setStatus('模板部门已添加')
    } else {
      setStatus('模板部门已移除')
    }
    await loadTemplates()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新模板部门失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateTemplateMemberGroup(action: 'assign' | 'unassign', groupId?: string): Promise<void> {
  if (!summary.value?.isPlatformAdmin || !selectedTemplateId.value) return
  const effectiveGroupId = groupId || selectedTemplateMemberGroupId.value
  if (!effectiveGroupId) return
  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/scope-templates/${encodeURIComponent(selectedTemplateId.value)}/member-groups/${action}`, {
      method: 'POST',
      body: JSON.stringify({ groupId: effectiveGroupId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '更新模板成员集失败'))
    }
    selectedTemplate.value = (payload.data as { item: ScopeTemplateDetail }).item
    if (action === 'assign') {
      selectedTemplateMemberGroupId.value = ''
      setStatus('模板成员集已添加')
    } else {
      setStatus('模板成员集已移除')
    }
    await loadTemplates()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '更新模板成员集失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function loadUsers(options?: { reselectPinned?: boolean }): Promise<void> {
  const reselectPinned = options?.reselectPinned !== false
  const requestGeneration = ++usersRequestGeneration
  const selectionGenerationAtStart = delegationAccessGeneration
  const selectedUserIdAtStart = selectedUserId.value
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (search.value) params.set('q', search.value)
    params.set('includeIneligible', 'true')
    const response = await apiFetch(`/api/admin/role-delegation/users?${params.toString()}`)
    const payload = await readJson(response)
    if (requestGeneration !== usersRequestGeneration) return
    if (response.status === 403) {
      users.value = []
      usersForbidden.value = true
      pinnedUserPending = false
      invalidateSelection()
      setStatus('当前账号没有可管理的范围。', 'error')
      return
    }
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载成员失败'))
    }

    usersForbidden.value = false
    const data = payload.data as { items?: unknown[] } | undefined
    const items = Array.isArray(data?.items) ? data.items : []
    users.value = items.map((item) => normalizeUserCandidate(item)).filter((item): item is UserCandidate => item !== null)
    // A choice made while this list was in flight stays. This response must not clear it or select someone else.
    if (delegationAccessGeneration !== selectionGenerationAtStart || selectedUserId.value !== selectedUserIdAtStart) return
    if (reselectPinned && pinnedUserPending) {
      const pinned = initialPinnedUserId
      pinnedUserPending = false
      const pinnedRow = users.value.find((user) => user.id === pinned)
      if (pinnedRow?.selectable === false) return
      await selectUser(pinned)
      return
    }
    // A linked member stays selected when this page does not list them.
    // The access read is optional; a disabled row still drops the link.
    if (selectedUserId.value && selectedUserId.value === initialPinnedUserId) {
      const pinnedRow = users.value.find((user) => user.id === selectedUserId.value)
      if (pinnedRow?.selectable === false) {
        invalidateSelection()
        return
      }
      if (reselectPinned) await selectUser(selectedUserId.value)
      return
    }
    if (!selectedUserId.value && initialPinnedUserId) {
      const pinnedRow = users.value.find((user) => user.id === initialPinnedUserId)
      if (pinnedRow?.selectable === false) return
    }
    const selectedRow = users.value.find((user) => user.id === selectedUserId.value)
    if (selectedUserId.value && selectedRow?.selectable === false) {
      invalidateSelection()
      return
    }
    if (selectedUserId.value && !selectedRow) {
      clearUnpinnedSelection()
    }
  } catch (error) {
    if (requestGeneration !== usersRequestGeneration) return
    setStatus(error instanceof Error ? error.message : '加载成员失败', 'error')
  } finally {
    if (requestGeneration === usersRequestGeneration) loading.value = false
  }
}

function listedCandidateDisabled(userId: string): boolean {
  return users.value.some((user) => user.id === userId && user.selectable === false)
}

type OwnedSelection = { applied: boolean, generation: number | null }

async function selectUser(userId: string): Promise<OwnedSelection> {
  if (listedCandidateDisabled(userId)) return { applied: false, generation: null }
  const sameMember = selectedUserId.value === userId
  if (sameMember) delegationAccessGeneration += 1
  if (confirmationPhase.value === 'review' || pendingConfirmation.value?.targetUserId !== userId) {
    pendingConfirmation.value = null
  }
  selectedAccess.value = null
  selectedScopeConfig.value = null
  selectedRoleId.value = ''
  selectedRevokeRoleId.value = ''
  selectedDepartmentId.value = ''
  selectedAudienceGroupId.value = ''
  selectedUserId.value = userId
  const token = currentMemberToken()
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(userId)}/access`)
    const payload = await readJson(response)
    if (!memberTokenCurrent(token)) return { applied: false, generation: token.generation }
    if (listedCandidateDisabled(userId)) {
      selectedAccess.value = null
      selectedScopeConfig.value = null
      if (selectedUserId.value === userId) selectedUserId.value = ''
      return { applied: false, generation: token.generation }
    }
    if (response.status === 403) {
      selectedAccess.value = null
      selectedScopeConfig.value = null
      const deniedMessage = (payload.error as Record<string, unknown> | undefined)?.message
      setMemberStatus(token, typeof deniedMessage === 'string' && deniedMessage ? deniedMessage : '无权查看该成员的委派权限', 'error')
      return { applied: false, generation: token.generation }
    }
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载成员委派权限失败'))
    }
    const accessData = payload.data as DelegatedUserAccess
    if (!readSubjectMatches(payload, token.userId) || accessData?.user?.id !== token.userId) {
      setMemberStatus(token, '加载成员委派权限失败', 'error')
      return { applied: false, generation: token.generation }
    }

    selectedAccess.value = accessData
    if (listedCandidateDisabled(userId) || !memberTokenCurrent(token)) {
      selectedAccess.value = null
      selectedScopeConfig.value = null
      if (selectedUserId.value === userId) selectedUserId.value = ''
      return { applied: false, generation: token.generation }
    }
    if (summary.value?.isPlatformAdmin) {
      const scopeResult = await loadScopeConfig(userId)
      if (!memberTokenCurrent(token)) return { applied: false, generation: token.generation }
      return { applied: scopeResult.status === 'ok', generation: token.generation }
    }
    if (!memberTokenCurrent(token)) return { applied: false, generation: token.generation }
    selectedScopeConfig.value = null
    return { applied: true, generation: token.generation }
  } catch (error) {
    if (!memberTokenCurrent(token)) return { applied: false, generation: token.generation }
    selectedAccess.value = null
    selectedScopeConfig.value = null
    setMemberStatus(token, error instanceof Error ? error.message : '加载成员委派权限失败', 'error')
    return { applied: false, generation: token.generation }
  }
}

function requestForConfirmation(confirmation: DelegationConfirmation): AdminAuthorizationRequest | null {
  if (!confirmation.targetUserId) return null
  if ((confirmation.kind === 'grant' || confirmation.kind === 'revoke') && confirmation.roleId) {
    return {
      targetUserId: confirmation.targetUserId,
      action: {
        kind: confirmation.kind === 'grant' ? 'role.assign' : 'role.revoke',
        roleId: confirmation.roleId,
      },
      admissionChanges: [],
    }
  }
  if (confirmation.kind === 'admission-enable' && confirmation.namespace && pendingAdmissionEnabled.value !== null) {
    return {
      targetUserId: confirmation.targetUserId,
      action: { kind: 'admission.set' },
      admissionChanges: [{ namespace: confirmation.namespace, enabled: pendingAdmissionEnabled.value }],
    }
  }
  return null
}

function delegationCanVerifyAction(action: AdminAuthorizationAction): boolean {
  return action.kind === 'role.assign' || action.kind === 'role.revoke' || action.kind === 'admission.set'
}

function delegationActionLabel(action: AdminAuthorizationAction): string {
  switch (action.kind) {
    case 'role.assign':
      return `分配角色 ${action.roleId}`
    case 'role.revoke':
      return `撤销角色 ${action.roleId}`
    case 'admission.set':
      return '设置插件使用准入'
    case 'direct.grant':
      return `直接授权 ${action.code}`
    case 'direct.revoke':
      return `撤销直接授权 ${action.code}`
    case 'legacy.revoke':
      return `撤销历史来源 ${action.code}`
    case 'template.apply':
      return `应用范围模板 ${action.templateId}`
  }
}

function delegationLiveAgrees(
  access: DelegatedUserAccess,
  request: AdminAuthorizationRequest,
  impact: AdminAuthorizationImpact,
): boolean {
  if (!delegationCanVerifyAction(request.action)) return false
  if (access.user.id !== request.targetUserId) return false
  if (request.action.kind === 'role.assign' && !access.roles.includes(request.action.roleId)) return false
  if (request.action.kind === 'role.revoke' && access.roles.includes(request.action.roleId)) return false
  for (const change of request.admissionChanges) {
    const row = access.namespaceAdmissions.find((item) => item.namespace === change.namespace)
    if (!row || row.enabled !== change.enabled) return false
  }
  for (const change of impact.admissionChanges) {
    const row = access.namespaceAdmissions.find((item) => item.namespace === change.namespace)
    if (!row) {
      if (change.after) return false
      continue
    }
    if (row.enabled !== change.after) return false
  }
  return true
}

function scopeCleanupProvenAbsent(items: readonly AdminAuthorizationScopeCleanup[]): boolean {
  const scope = selectedScopeConfig.value
  if (!scope || scope.user.id !== selectedUserId.value || items.length === 0) return false
  return items.every((item) => {
    const id = item.id.trim()
    if (!id) return false
    if (item.kind === 'department') {
      return !scope.scopeAssignments.some((row) => (
        row.namespace === item.namespace && (row.id === id || row.directoryDepartmentId === id)
      ))
    }
    return !scope.groupAssignments.some((row) => (
      row.namespace === item.namespace && (row.id === id || row.groupId === id)
    ))
  })
}

function scopeCleanupNote(impact: AdminAuthorizationImpact, scopeChecked: boolean): string {
  if (impact.scopeCleanup.length === 0) return ''
  const labels = impact.scopeCleanup.map((item) => `${item.namespace} ${item.kind} ${item.id}`)
  if (scopeChecked && scopeCleanupProvenAbsent(impact.scopeCleanup)) {
    return `范围读取确认这些项已不在：${labels.join('、')}。`
  }
  return `提交时回执记录范围清理：${labels.join('、')}。当前的角色和准入读取不能确认这些范围是否已移除。`
}

function retainedReceiptNote(impact: AdminAuthorizationImpact, alreadySaid: string): string {
  if (alreadySaid.includes('提交时回执记录其他来源')) return ''
  const labels = impact.retainedOtherGrants.map((grant) => grant.code.trim()).filter((code) => code.length > 0)
  if (labels.length === 0) return ''
  return `提交时回执记录其他来源：${labels.join('、')}。当前的角色和准入读取不能确认这些来源是否仍在。`
}

function delegationVerifiedStatus(
  receipt: AdminAuthorizationReceipt,
  request: AdminAuthorizationRequest,
  scopeChecked: boolean,
): string {
  const base = describeVerifiedAuthorization({
    action: receipt.action,
    impact: receipt.impact,
    requestedAdmissionChanges: request.admissionChanges,
  })
  return `${base}${retainedReceiptNote(receipt.impact, base)}${scopeCleanupNote(receipt.impact, scopeChecked)}`
}

function explicitImpactAdmissions(impact: AdminAuthorizationImpact): Array<{ namespace: string, enabled: boolean }> {
  return impact.admissionChanges
    .filter((change) => change.cause === 'explicit')
    .map((change) => ({ namespace: change.namespace, enabled: change.after }))
}

function requestForReceiptReadback(receipt: AdminAuthorizationReceipt): AdminAuthorizationRequest | null {
  if (!delegationCanVerifyAction(receipt.action)) return null
  if (receipt.action.kind === 'admission.set') {
    const admissionChanges = explicitImpactAdmissions(receipt.impact)
    if (admissionChanges.length === 0) return null
    return { targetUserId: receipt.targetUserId, action: receipt.action, admissionChanges }
  }
  if (receipt.action.kind === 'role.assign' || receipt.action.kind === 'role.revoke') {
    return {
      targetUserId: receipt.targetUserId,
      action: receipt.action,
      admissionChanges: explicitImpactAdmissions(receipt.impact),
    }
  }
  return null
}

async function readDelegationAccess(userId: string): Promise<DelegatedUserAccess | null> {
  const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(userId)}/access`)
  const payload = await readJson(response)
  if (!response.ok || payload.ok !== true || !readSubjectMatches(payload, userId)) return null
  return payload.data as DelegatedUserAccess
}

async function verifyDelegationAuthorization(): Promise<boolean> {
  const receipt = authorizationOperation.receipt.value
  if (!receipt || !delegationCanVerifyAction(receipt.action)) return false
  const submitted = submittedAuthorization.value
  let request: AdminAuthorizationRequest | null
  if (submitted) {
    if (submitted.targetUserId !== receipt.targetUserId) return false
    if (!delegationCanVerifyAction(submitted.action) || submitted.action.kind !== receipt.action.kind) return false
    if (
      (receipt.action.kind === 'role.assign' || receipt.action.kind === 'role.revoke')
      && (submitted.action.kind === 'role.assign' || submitted.action.kind === 'role.revoke')
      && receipt.action.roleId !== submitted.action.roleId
    ) return false
    request = submitted
  } else {
    request = requestForReceiptReadback(receipt)
  }
  if (!request) return false
  const actorId = currentPrincipalId()
  const generation = delegationAccessGeneration
  const targetUserId = receipt.targetUserId
  if (!sameDelegationActor(actorId, generation, targetUserId)) return false
  let access: DelegatedUserAccess | null
  try {
    access = await readDelegationAccess(targetUserId)
  } catch {
    return false
  }
  if (!access || access.user?.id !== targetUserId || !delegationLiveAgrees(access, request, receipt.impact)) return false
  if (!sameDelegationActor(actorId, generation, targetUserId)) return false
  selectedAccess.value = access
  if (!access.delegableRoles.includes(selectedRevokeRoleId.value)) selectedRevokeRoleId.value = ''
  return true
}

async function previewDelegationRequest(request: AdminAuthorizationRequest): Promise<void> {
  const token = currentMemberToken()
  if (token.userId !== request.targetUserId) return
  if (!currentPrincipalId()) {
    setStatus(AUTHORIZATION_PRINCIPAL_MISSING_MESSAGE, 'error')
    return
  }
  authorizationFaultCode = ''
  authorizationFaultMessage = ''
  await authorizationOperation.preview(request)
  await authorizationOperation.whenSettled()
  if (!memberTokenCurrent(token)) return
  if (!pendingConfirmation.value || confirmationPhase.value !== 'review') return
  const phase = authorizationOperation.phase.value
  if (phase === 'awaiting_confirmation' || phase === 'previewing') return
  if (phase === 'forbidden') {
    setMemberStatus(token, AUTHORIZATION_FORBIDDEN_MESSAGE, 'error')
    return
  }
  if (authorizationFaultCode === 'LAST_PLATFORM_ADMIN') {
    setMemberStatus(token, LAST_PLATFORM_ADMIN_MESSAGE, 'error')
    return
  }
  if (authorizationFaultMessage) {
    setMemberStatus(token, authorizationFaultMessage, 'error')
    return
  }
  setMemberStatus(token, AUTHORIZATION_PREVIEW_FAILED_MESSAGE, 'error')
}

function beginDelegationPreview(confirmation: DelegationConfirmation): void {
  const request = requestForConfirmation(confirmation)
  if (!request) return
  submittedAuthorization.value = request
  confirmationReadAgain.value = false
  void previewDelegationRequest(request)
}

async function publishVerifiedDelegation(generation: number, targetUserId: string): Promise<void> {
  const token: MemberToken = { userId: targetUserId, generation }
  const actorId = currentPrincipalId()
  const initialReceipt = authorizationOperation.receipt.value
  if (
    initialReceipt
    && initialReceipt.targetUserId === targetUserId
    && !delegationCanVerifyAction(initialReceipt.action)
  ) {
    if (!memberTokenCurrent(token) || currentPrincipalId() !== actorId) return
    confirmationReadAgain.value = false
    restoredReadAgain.value = true
    setMemberStatus(token, `回执是${delegationActionLabel(initialReceipt.action)}。本页只重新读取角色和插件使用准入，不能确认这个回执。请不要再次提交。`, 'error')
    return
  }
  await authorizationOperation.verify()
  await authorizationOperation.whenSettled()
  if (!memberTokenCurrent(token) || currentPrincipalId() !== actorId) return
  const receipt = authorizationOperation.receipt.value
  const request = submittedAuthorization.value
  const statusRequest = request && request.targetUserId === targetUserId
    ? request
    : receipt && receipt.targetUserId === targetUserId
      ? requestForReceiptReadback(receipt)
      : null
  if (!authorizationOperation.verified.value || !receipt || receipt.targetUserId !== targetUserId || !statusRequest) {
    if (!memberTokenCurrent(token) || currentPrincipalId() !== actorId) return
    confirmationReadAgain.value = currentAuthorizationPhase() === 'committed'
    restoredReadAgain.value = confirmationReadAgain.value && !pendingConfirmation.value
    setMemberStatus(token, AUTHORIZATION_NOT_CHECKED_MESSAGE, 'error')
    return
  }
  let scopeChecked = false
  if (
    request
    && request.targetUserId === targetUserId
    && summary.value?.isPlatformAdmin
    && (request.action.kind === 'role.assign' || request.action.kind === 'role.revoke')
  ) {
    selectedScopeConfig.value = null
    try {
      const scopeResult = await loadScopeConfig(targetUserId)
      if (!memberTokenCurrent(token) || scopeResult.status !== 'ok') return
      scopeChecked = scopeResult.scope?.user.id === targetUserId
    } catch (scopeError) {
      if (!memberTokenCurrent(token)) return
      selectedScopeConfig.value = null
      setMemberStatus(token, scopeError instanceof Error ? scopeError.message : '加载管理员范围失败', 'error')
      return
    }
  }
  if (!memberTokenCurrent(token) || currentPrincipalId() !== actorId) return
  restoredReadAgain.value = false
  setMemberStatus(token, delegationVerifiedStatus(receipt, statusRequest, scopeChecked))
}

async function settleDelegationAuthorization(generation: number, targetUserId: string): Promise<void> {
  const token: MemberToken = { userId: targetUserId, generation }
  if (!memberTokenCurrent(token)) return
  const phase = authorizationOperation.phase.value
  if (phase === 'validation_failed') {
    if (authorizationFaultCode === 'LAST_PLATFORM_ADMIN') setMemberStatus(token, LAST_PLATFORM_ADMIN_MESSAGE, 'error')
    else setMemberStatus(token, authorizationFaultMessage || ROLE_VERSION_MISMATCH_MESSAGE, 'error')
    return
  }
  if (phase === 'forbidden') {
    setMemberStatus(token, authorizationFaultMessage || AUTHORIZATION_FORBIDDEN_MESSAGE, 'error')
    return
  }
  if (phase === 'pending' || phase === 'unverified_no_read') {
    await authorizationOperation.lookup()
    await authorizationOperation.whenSettled()
    if (!memberTokenCurrent(token)) return
    if (currentAuthorizationPhase() === 'committed') {
      await publishVerifiedDelegation(generation, targetUserId)
      return
    }
    confirmationReadAgain.value = true
    setMemberStatus(token, AUTHORIZATION_PENDING_MESSAGE, 'error')
    return
  }
  if (phase === 'committed') await publishVerifiedDelegation(generation, targetUserId)
}

async function loadScopeConfig(userId: string): Promise<
  | { status: 'ok', scope: DelegatedAdminScopeConfig | null }
  | { status: 'denied' | 'stale' | 'mismatch' }
> {
  if (!summary.value?.isPlatformAdmin) return { status: 'ok', scope: null }
  const token: MemberToken = { userId, generation: delegationAccessGeneration }

  const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(userId)}/scopes`)
  const payload = await readJson(response)
  if (!memberTokenCurrent(token)) return { status: 'stale' }
  if (response.status === 403) {
    selectedScopeConfig.value = null
    setMemberStatus(token, '无权查看该成员的管理范围', 'error')
    return { status: 'denied' }
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '加载管理员范围失败'))
  }
  if (!memberTokenCurrent(token)) return { status: 'stale' }
  const scopeUserId = (payload.data as { user?: { id?: unknown } } | undefined)?.user?.id
  if (!readSubjectMatches(payload, token.userId) || scopeUserId !== token.userId) {
    selectedScopeConfig.value = null
    setMemberStatus(token, '加载管理员范围失败', 'error')
    return { status: 'mismatch' }
  }

  const scope = payload.data as DelegatedAdminScopeConfig
  rememberScopeConfig(scope)
  return { status: 'ok', scope }
}

function rememberScopeConfig(scope: DelegatedAdminScopeConfig): void {
  selectedScopeConfig.value = scope
  if (!scope.adminNamespaces.includes(selectedScopeNamespace.value)) {
    selectedScopeNamespace.value = scope.adminNamespaces[0] || ''
  }
}

function scopeConfigKeepingActivation(
  incoming: DelegatedAdminScopeConfig,
  previous: DelegatedAdminScopeConfig | null,
): DelegatedAdminScopeConfig {
  if (!incoming || typeof incoming !== 'object') return incoming
  if (Object.prototype.hasOwnProperty.call(incoming, 'scopeActivations')) return incoming
  if (!previous || previous.user?.id !== incoming.user?.id) return incoming
  if (!Object.prototype.hasOwnProperty.call(previous, 'scopeActivations')) return incoming
  return { ...incoming, scopeActivations: previous.scopeActivations }
}

function scopeActivationFieldPresentFor(scope: DelegatedAdminScopeConfig | null): boolean {
  return !!scope && Object.prototype.hasOwnProperty.call(scope, 'scopeActivations')
}

function readyActivation(scope: DelegatedAdminScopeConfig | null, namespace: string): ScopeActivation | null {
  if (!scope || !namespace || !Array.isArray(scope.adminNamespaces) || !scope.adminNamespaces.includes(namespace)) return null
  if (!Array.isArray(scope.scopeActivations)) return null
  const claimed = scope.scopeActivations.filter((item) => (
    !!item && typeof item === 'object' && !Array.isArray(item)
    && (item as { namespace?: unknown }).namespace === namespace
  ))
  if (claimed.length !== 1) return null
  const row = claimed[0] as Record<string, unknown>
  if (typeof row.enabled !== 'boolean' || typeof row.hasConfiguredScope !== 'boolean') return null
  if (typeof row.version !== 'string' || row.version.trim() === '') return null
  return { namespace, enabled: row.enabled, hasConfiguredScope: row.hasConfiguredScope, version: row.version }
}

const scopeActivationFieldPresent = computed(() => scopeActivationFieldPresentFor(selectedScopeConfig.value))
const readyScopeActivation = computed(() => selectedScopeConfig.value?.actorId === currentPrincipalId()
  ? readyActivation(selectedScopeConfig.value, selectedScopeNamespace.value)
  : null)
function activationCopy(enabled: boolean): string {
  return enabled
    ? '此命名空间的委派已启用。'
    : '此命名空间的委派已停止。可以保存范围，但不能委派。'
}
const activationStateText = computed(() => activationCopy(readyScopeActivation.value?.enabled === true))
const canEnableScopeActivation = computed(() => {
  const entry = readyScopeActivation.value
  return !!entry && entry.enabled === false && entry.hasConfiguredScope === true && !activationPendingAttempt.value
})
const canStopScopeActivation = computed(() => (
  readyScopeActivation.value?.enabled === true && !activationPendingAttempt.value
))

function activationAttemptCurrent(attempt: ScopeActivationAttempt): boolean {
  return attempt.actorId.length > 0
    && currentPrincipalId() === attempt.actorId
    && delegationReadStillCurrent(attempt.accessGeneration, attempt.userId)
    && selectedScopeNamespace.value === attempt.namespace
    && scopeNamespaceGeneration === attempt.namespaceGeneration
}

function onActivationDialogKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || activationWriting.value) return
  event.preventDefault()
  dismissActivationConfirmation()
}

function bindActivationDialogFocus(): void {
  activationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => {
    activationDialogRef.value?.querySelector<HTMLElement>('[data-testid="scope-activation-confirm-cancel"]')?.focus()
  })
}

function dismissActivationConfirmation(): void {
  const hadDialog = activationConfirming.value !== null
  activationConfirming.value = null
  const back = activationReturnFocus
  activationReturnFocus = null
  if (hadDialog) back?.focus()
}

function activationToken(attempt: ScopeActivationAttempt): MemberToken {
  return { userId: attempt.userId, generation: attempt.accessGeneration }
}

function markActivationPending(attempt: ScopeActivationAttempt): void {
  const token = activationToken(attempt)
  if (!activationAttemptCurrent(attempt) || !memberTokenCurrent(token)) return
  activationPendingAttempt.value = attempt
  setMemberStatus(token, activationPendingMessage, 'error')
}

function activationEchoMatches(payload: Record<string, unknown>, attempt: ScopeActivationAttempt): boolean {
  const data = payload.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const row = data as Record<string, unknown>
  return row.actorId === attempt.actorId
    && row.userId === attempt.userId
    && row.namespace === attempt.namespace
    && row.enabled === attempt.enabled
}

function usableActivationScope(payload: Record<string, unknown>, attempt: ScopeActivationAttempt): DelegatedAdminScopeConfig | null {
  if (payload.ok !== true) return null
  const data = payload.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  const user = row.user
  if (row.actorId !== attempt.actorId) return null
  if (!user || typeof user !== 'object' || (user as { id?: unknown }).id !== attempt.userId) return null
  if (!Array.isArray(row.adminNamespaces) || row.adminNamespaces.some((item) => typeof item !== 'string')) return null
  if (!row.adminNamespaces.includes(attempt.namespace)) return null
  const assignmentsUsable = (value: unknown): boolean => (
    Array.isArray(value) && value.every((item) => !!item && typeof item === 'object' && !Array.isArray(item))
  )
  if (!assignmentsUsable(row.scopeAssignments) || !assignmentsUsable(row.groupAssignments)) return null
  return row as DelegatedAdminScopeConfig
}

async function fetchActivationScope(
  attempt: ScopeActivationAttempt,
  serial: number,
): Promise<DelegatedAdminScopeConfig | null | 'stale'> {
  const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(attempt.userId)}/scopes`)
  if (serial !== activationReadSerial) return 'stale'
  const payload = await readJson(response)
  if (serial !== activationReadSerial || !activationAttemptCurrent(attempt)) return 'stale'
  if (!response.ok) return null
  return usableActivationScope(payload, attempt)
}

function applyActivationScope(attempt: ScopeActivationAttempt, scope: DelegatedAdminScopeConfig): 'success' | 'pending' | 'different' | 'drop' {
  if (!activationAttemptCurrent(attempt)) return 'drop'
  rememberScopeConfig(scope)
  if (!activationAttemptCurrent(attempt)) return 'drop'
  const entry = readyActivation(selectedScopeConfig.value, attempt.namespace)
  if (entry?.enabled === attempt.enabled) return 'success'
  // The same expectedVersion means this write can still commit after the read.
  if (entry?.version === attempt.expectedVersion) return 'pending'
  return 'different'
}

function openScopeActivation(enabled: boolean): void {
  if (scopeBusy.value || activationPendingAttempt.value || activationFlight || activationWriting.value || activationConfirming.value) return
  const entry = readyScopeActivation.value
  const actorId = currentPrincipalId()
  const userId = selectedUserId.value
  if (!entry || !actorId || selectedScopeConfig.value?.actorId !== actorId || !summary.value?.isPlatformAdmin || !memberWritesReady.value) return
  if (entry.namespace !== selectedScopeNamespace.value || entry.enabled === enabled) return
  if (enabled && entry.hasConfiguredScope !== true) return
  activationConfirming.value = {
    actorId,
    userId,
    namespace: entry.namespace,
    enabled,
    expectedVersion: entry.version,
    accessGeneration: delegationAccessGeneration,
    namespaceGeneration: scopeNamespaceGeneration,
  }
  bindActivationDialogFocus()
}

async function submitScopeActivation(): Promise<void> {
  if (scopeBusy.value || activationPendingAttempt.value || activationFlight || activationWriting.value) return
  const attempt = activationConfirming.value
  if (!attempt || !activationAttemptCurrent(attempt) || selectedScopeConfig.value?.actorId !== attempt.actorId) {
    dismissActivationConfirmation()
    return
  }
  const entry = readyActivation(selectedScopeConfig.value, attempt.namespace)
  if (!entry || entry.version !== attempt.expectedVersion || entry.enabled === attempt.enabled) {
    dismissActivationConfirmation()
    return
  }
  if (attempt.enabled && entry.hasConfiguredScope !== true) {
    dismissActivationConfirmation()
    return
  }
  activationFlight = attempt
  activationWriting.value = true
  const serial = ++activationReadSerial
  let outcome: 'success' | 'pending' | 'different' | 'error' | 'drop' = 'drop'
  let errorMessage = ''
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(attempt.userId)}/scopes/activation`, {
      method: 'POST',
      body: JSON.stringify({
        namespace: attempt.namespace,
        enabled: attempt.enabled,
        expectedVersion: attempt.expectedVersion,
      }),
    })
    const payload = await readJson(response)
    if (serial !== activationReadSerial || !activationAttemptCurrent(attempt)) {
      outcome = 'drop'
    } else if (response.status >= 400 && response.status < 500) {
      outcome = 'error'
      errorMessage = readErrorMessage(payload) || '保存委派启停失败'
    } else if (!response.ok || payload.ok !== true || !activationEchoMatches(payload, attempt)) {
      outcome = 'pending'
    } else {
      const read = await fetchActivationScope(attempt, serial)
      if (read === 'stale' || !activationAttemptCurrent(attempt)) outcome = 'drop'
      else if (!read) outcome = 'pending'
      else outcome = applyActivationScope(attempt, read)
    }
  } catch {
    outcome = serial === activationReadSerial && activationAttemptCurrent(attempt) ? 'pending' : 'drop'
  } finally {
    if (serial === activationReadSerial) {
      activationFlight = null
      activationWriting.value = false
    }
    dismissActivationConfirmation()
  }
  const token = activationToken(attempt)
  if (serial !== activationReadSerial || !activationAttemptCurrent(attempt) || !memberTokenCurrent(token)) return
  if (outcome === 'error') {
    activationPendingAttempt.value = null
    setMemberStatus(token, errorMessage, 'error')
    return
  }
  if (outcome === 'pending') {
    markActivationPending(attempt)
    return
  }
  if (outcome === 'different') {
    activationPendingAttempt.value = null
    setMemberStatus(token, '已重新读取。当前命名空间的委派启停尚未确认与提交一致。', 'error')
    return
  }
  if (outcome === 'success') {
    activationPendingAttempt.value = null
    setMemberStatus(token, activationCopy(attempt.enabled))
  }
}

async function rereadScopeActivation(): Promise<void> {
  if (scopeBusy.value || activationFlight || activationWriting.value) return
  const attempt = activationPendingAttempt.value
  if (!attempt || !activationAttemptCurrent(attempt)) {
    activationPendingAttempt.value = null
    return
  }
  const token = activationToken(attempt)
  const serial = ++activationReadSerial
  activationWriting.value = true
  try {
    const read = await fetchActivationScope(attempt, serial)
    if (read === 'stale' || serial !== activationReadSerial || !activationAttemptCurrent(attempt) || !memberTokenCurrent(token)) return
    if (!read) {
      setMemberStatus(token, activationPendingMessage, 'error')
      return
    }
    const outcome = applyActivationScope(attempt, read)
    if (serial !== activationReadSerial || !activationAttemptCurrent(attempt) || !memberTokenCurrent(token)) return
    if (outcome === 'drop' || outcome === 'pending') {
      if (outcome === 'pending') setMemberStatus(token, activationPendingMessage, 'error')
      return
    }
    activationPendingAttempt.value = null
    setMemberStatus(token, outcome === 'success'
      ? activationCopy(attempt.enabled)
      : '已重新读取。当前命名空间的委派启停尚未确认与提交一致。', outcome === 'success' ? 'info' : 'error')
  } catch {
    if (serial !== activationReadSerial || !activationAttemptCurrent(attempt) || !memberTokenCurrent(token)) return
    setMemberStatus(token, activationPendingMessage, 'error')
  } finally {
    if (serial === activationReadSerial) activationWriting.value = false
  }
}

/** A revocable role id, named from the assignable catalog when it is there (it may not be). */
function revocableRoleLabel(roleId: string): string {
  const role = selectedAccess.value?.roleCatalog.find((candidate) => candidate.id === roleId)
  return role ? `${roleTitle(role)} (${role.id})` : roleId
}

function sameOpenConfirmation(kind: DelegationConfirmation['kind'], roleId: string | null, namespace: string | null, enabled: boolean | null): boolean {
  const pending = pendingConfirmation.value
  if (!pending || confirmationPhase.value !== 'review') return false
  return pending.kind === kind
    && pending.roleId === roleId
    && pending.namespace === namespace
    && pendingAdmissionEnabled.value === enabled
    && pending.targetUserId === selectedUserId.value
}

function openGrantConfirmation(): void {
  const targetUserId = selectedUserId.value
  const roleId = selectedRoleId.value
  const access = selectedAccess.value
  if (confirmationPhase.value === 'pending' || busy.value) return
  if (!targetUserId || !roleId || !memberWritesReady.value || !access || access.user.id !== targetUserId) return
  if (!currentPrincipalId()) {
    setStatus(AUTHORIZATION_PRINCIPAL_MISSING_MESSAGE, 'error')
    return
  }
  if (!roleActionAllowed(roleId, 'assign')) return
  const role = access.roleCatalog.find((candidate) => candidate.id === roleId)
  if (!role) {
    setMemberStatus(currentMemberToken(), '角色目录中没有该角色，不能分配', 'error')
    return
  }
  if (sameOpenConfirmation('grant', role.id, null, null)) return
  const listing = permissionListingFor(role)
  pendingAdmissionEnabled.value = null
  pendingConfirmation.value = openDelegationConfirmation({
    kind: 'grant',
    targetUserId,
    targetLabel: targetLabelFor(access.user),
    roleId: role.id,
    roleTitle: roleTitle(role),
    permissions: listing.permissions,
    permissionListing: listing.permissionListing,
    namespace: null,
    expectedUpdatedAt: readCatalogExpectedUpdatedAt(role),
  })
  beginDelegationPreview(pendingConfirmation.value)
}

function openRevokeConfirmation(): void {
  const targetUserId = selectedUserId.value
  const roleId = selectedRevokeRoleId.value
  const access = selectedAccess.value
  if (confirmationPhase.value === 'pending' || busy.value) return
  if (!targetUserId || !roleId || !memberWritesReady.value || !access || access.user.id !== targetUserId) return
  if (!currentPrincipalId()) {
    setStatus(AUTHORIZATION_PRINCIPAL_MISSING_MESSAGE, 'error')
    return
  }
  if (!roleActionAllowed(roleId, 'unassign')) return
  if (sameOpenConfirmation('revoke', roleId, null, null)) return
  const role = access.roleCatalog.find((candidate) => candidate.id === roleId)
  const listing = permissionListingFor(role)
  pendingAdmissionEnabled.value = null
  pendingConfirmation.value = openDelegationConfirmation({
    kind: 'revoke',
    targetUserId,
    targetLabel: targetLabelFor(access.user),
    roleId,
    roleTitle: role ? roleTitle(role) : roleId,
    permissions: listing.permissions,
    permissionListing: listing.permissionListing,
    namespace: null,
    expectedUpdatedAt: null,
  })
  beginDelegationPreview(pendingConfirmation.value)
}

function openAdmissionConfirmation(admission: NamespaceAdmission, enabled = true): void {
  const targetUserId = selectedUserId.value
  const access = selectedAccess.value
  if (confirmationPhase.value === 'pending' || busy.value) return
  if (!targetUserId || !memberWritesReady.value || !access || access.user.id !== targetUserId) return
  if (!currentPrincipalId()) {
    setStatus(AUTHORIZATION_PRINCIPAL_MISSING_MESSAGE, 'error')
    return
  }
  if (!namespaceIsManaged(admission.namespace) || admission.enabled === enabled) return
  if (sameOpenConfirmation('admission-enable', null, admission.namespace, enabled)) return
  pendingAdmissionEnabled.value = enabled
  pendingConfirmation.value = openDelegationConfirmation({
    kind: 'admission-enable',
    targetUserId,
    targetLabel: targetLabelFor(access.user),
    roleId: null,
    roleTitle: null,
    permissions: [],
    permissionListing: 'unknown',
    namespace: admission.namespace,
    expectedUpdatedAt: null,
  })
  beginDelegationPreview(pendingConfirmation.value)
}

function cancelDelegationConfirmation(): void {
  if (confirmationPhase.value === 'pending') return
  pendingConfirmation.value = null
  confirmationReadAgain.value = false
  confirmationSubmission.value = null
  submittedAuthorization.value = null
}

async function rereadRestoredAuthorization(): Promise<void> {
  if (memberBusyBlocksRecovery() || pendingConfirmation.value) return
  const token = currentMemberToken()
  if (!token.userId) return
  await authorizationOperation.lookup()
  await authorizationOperation.whenSettled()
  if (!memberTokenCurrent(token)) return
  if (currentAuthorizationPhase() === 'committed') {
    await publishVerifiedDelegation(token.generation, token.userId)
    return
  }
  restoredReadAgain.value = true
  setMemberStatus(token, AUTHORIZATION_PENDING_MESSAGE, 'error')
}

async function rereadDelegationAuthorization(): Promise<void> {
  const confirmation = pendingConfirmation.value
  if (!confirmation || confirmationPhase.value !== 'pending' || !confirmationReadAgain.value) return
  const token: MemberToken = { userId: confirmation.targetUserId, generation: delegationAccessGeneration }
  if (!memberTokenCurrent(token)) return
  if (currentAuthorizationPhase() !== 'committed') {
    await authorizationOperation.lookup()
    await authorizationOperation.whenSettled()
    if (!memberTokenCurrent(token)) return
  }
  if (currentAuthorizationPhase() === 'committed') {
    await publishVerifiedDelegation(token.generation, token.userId)
    if (memberTokenCurrent(token) && confirmationSubmission.value?.token === confirmation.token && authorizationOperation.verified.value) {
      confirmationReadAgain.value = false
      confirmationSubmission.value = { token: confirmation.token, phase: 'completed' }
    }
    return
  }
  confirmationReadAgain.value = true
  setMemberStatus(token, AUTHORIZATION_PENDING_MESSAGE, 'error')
}

async function submitDelegationConfirmation(typedText: string): Promise<void> {
  const confirmation = pendingConfirmation.value
  if (!confirmation || confirmationPhase.value !== 'review') return
  if (currentAuthorizationPhase() !== 'awaiting_confirmation') return
  if (
    confirmation.kind === 'revoke'
    && confirmation.roleId === PLATFORM_ADMIN_ROLE_ID
    && typedText.trim() !== PLATFORM_ADMIN_REVOKE_PHRASE
  ) return
  const currentRoleId = confirmation.kind === 'grant'
    ? selectedRoleId.value
    : confirmation.kind === 'revoke'
      ? selectedRevokeRoleId.value
      : null
  const admission = confirmation.kind === 'admission-enable'
    ? selectedAccess.value?.namespaceAdmissions.find((item) => item.namespace === confirmation.namespace)
    : undefined
  const admissionStillPresent = confirmation.kind === 'admission-enable'
    && admission !== undefined
    && namespaceIsManaged(admission.namespace)
    && admission.enabled !== pendingAdmissionEnabled.value
  if (!delegationConfirmationStillValid(confirmation, {
    targetUserId: selectedUserId.value,
    roleId: currentRoleId,
    namespace: admissionStillPresent ? confirmation.namespace : null,
  })) {
    pendingConfirmation.value = null
    return
  }
  if (confirmation.kind === 'admission-enable' && !admissionStillPresent) return
  const request = requestForConfirmation(confirmation)
  if (!request || request.targetUserId !== selectedUserId.value) {
    pendingConfirmation.value = null
    return
  }
  const token: MemberToken = { userId: confirmation.targetUserId, generation: delegationAccessGeneration }
  confirmationSubmission.value = { token: confirmation.token, phase: 'pending' }
  confirmationReadAgain.value = false
  submittedAuthorization.value = request
  authorizationFaultCode = ''
  authorizationFaultMessage = ''
  claimMemberBusy(token)
  try {
    await authorizationOperation.confirm()
    await authorizationOperation.whenSettled()
    if (!memberTokenCurrent(token)) return
    await settleDelegationAuthorization(token.generation, token.userId)
  } finally {
    releaseMemberBusy(token)
    if (confirmationSubmission.value?.token === confirmation.token) {
      const phase = currentAuthorizationPhase()
      const unresolved = phase === 'pending'
        || phase === 'committing'
        || phase === 'unverified_no_read'
        || (phase === 'committed' && !authorizationOperation.verified.value)
      confirmationSubmission.value = { token: confirmation.token, phase: unresolved ? 'pending' : 'completed' }
    }
  }
}

async function refreshAfterScopeWrite(targetUserId: string, successMessage: string, operationGeneration: number): Promise<void> {
  const token: MemberToken = { userId: targetUserId, generation: operationGeneration }
  if (!memberTokenCurrent(token)) return
  await loadSummary()
  if (!memberTokenCurrent(token)) return
  // The list reload must not spend the access read this write owns.
  await loadUsers({ reselectPinned: false })
  if (usersForbidden.value) return
  const candidate = users.value.find((user) => user.id === targetUserId)
  // Disabled is a denial. An unpinned member missing from this search page is too.
  // A pinned member missing from the page is not. loadUsers may already have cleared
  // the selection. The note still applies only when that clear advanced this
  // operation's generation by exactly one, so a real switch to someone else stays quiet.
  if (candidate?.selectable === false || (!candidate && targetUserId !== initialPinnedUserId)) {
    const stillCurrent = memberTokenCurrent(token)
    if (stillCurrent) invalidateSelection()
    noteMemberLeftScope(token, '该成员已不在可管理范围内')
    return
  }
  if (!memberTokenCurrent(token)) return
  const ownedGeneration = operationGeneration + 1
  const selected = await selectUser(targetUserId)
  if (!selected.applied || selected.generation !== ownedGeneration || selected.generation === null) return
  const refreshed: MemberToken = { userId: targetUserId, generation: selected.generation }
  if (!memberTokenCurrent(refreshed) || !selectedAccess.value || selectedAccess.value.user.id !== targetUserId) return
  if (summary.value?.isPlatformAdmin && selectedScopeConfig.value?.user.id !== targetUserId) return
  setMemberStatus(refreshed, successMessage)
}

async function updateScope(action: 'assign' | 'unassign', scope?: ScopeAssignment): Promise<void> {
  const targetUserId = selectedUserId.value
  const token: MemberToken = { userId: targetUserId, generation: delegationAccessGeneration }
  if (!summary.value?.isPlatformAdmin || !memberTokenCurrent(token) || !memberWritesReady.value) return
  const namespace = action === 'assign' ? selectedScopeNamespace.value : scope?.namespace || ''
  const directoryDepartmentId = action === 'assign' ? selectedDepartmentId.value : scope?.directoryDepartmentId || ''
  if (!namespace || !directoryDepartmentId) return
  if (action === 'assign' && includeChildren.value !== true && !exactDepartmentWritesEnabled.value) {
    setMemberStatus(token, exactDepartmentUnavailableText, 'error')
    return
  }

  scopeBusy.value = true
  try {
    const requestedIncludeChildren = includeChildren.value === true
    const scopeBody: { namespace: string; directoryDepartmentId: string; includeChildren?: boolean } = {
      namespace,
      directoryDepartmentId,
    }
    if (action === 'assign') scopeBody.includeChildren = requestedIncludeChildren
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(token.userId)}/scopes/${action}`, {
      method: 'POST',
      body: JSON.stringify(scopeBody),
    })
    const payload = await readJson(response)
    if (isExactDepartmentDisabledResponse(response, payload)) {
      noteExactDepartmentDisabledByServer()
      if (!memberTokenCurrent(token)) return
      throw new Error(exactDepartmentUnavailableText)
    }
    if (!memberTokenCurrent(token)) return
    if (response.status === 403 || !response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存管理员范围失败'))
    }
    const scopeUserId = (payload.data as { user?: { id?: unknown } } | undefined)?.user?.id
    if (!readSubjectMatches(payload, token.userId) || scopeUserId !== token.userId) {
      setMemberStatus(token, '保存管理员范围失败', 'error')
      return
    }
    if (
      action === 'assign'
      && !assignmentEchoesIncludeChildren(
        (payload.data as { scopeAssignments?: unknown } | undefined)?.scopeAssignments,
        directoryDepartmentId,
        requestedIncludeChildren,
        namespace,
      )
    ) {
      setMemberStatus(token, '返回的是否包含下级与提交不一致', 'error')
      return
    }

    if (!memberTokenCurrent(token)) return
    selectedScopeConfig.value = scopeConfigKeepingActivation(payload.data as DelegatedAdminScopeConfig, selectedScopeConfig.value)
    if (action === 'assign') selectedDepartmentId.value = ''
    await refreshAfterScopeWrite(
      token.userId,
      action === 'assign' ? '插件管理员部门范围已添加' : '插件管理员部门范围已移除',
      token.generation,
    )
  } catch (error) {
    if (!memberTokenCurrent(token)) return
    setMemberStatus(token, error instanceof Error ? error.message : '保存管理员范围失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateScopeGroup(action: 'assign' | 'unassign', assignment?: GroupAssignment): Promise<void> {
  const targetUserId = selectedUserId.value
  const token: MemberToken = { userId: targetUserId, generation: delegationAccessGeneration }
  if (!summary.value?.isPlatformAdmin || !memberTokenCurrent(token) || !memberWritesReady.value) return
  const namespace = action === 'assign' ? selectedScopeNamespace.value : assignment?.namespace || ''
  const groupId = action === 'assign' ? selectedAudienceGroupId.value : assignment?.groupId || ''
  if (!namespace || !groupId) return

  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(token.userId)}/scope-groups/${action}`, {
      method: 'POST',
      body: JSON.stringify({ namespace, groupId }),
    })
    const payload = await readJson(response)
    if (!memberTokenCurrent(token)) return
    if (response.status === 403 || !response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存成员集范围失败'))
    }
    const scopeUserId = (payload.data as { user?: { id?: unknown } } | undefined)?.user?.id
    if (!readSubjectMatches(payload, token.userId) || scopeUserId !== token.userId) {
      setMemberStatus(token, '保存成员集范围失败', 'error')
      return
    }
    selectedScopeConfig.value = scopeConfigKeepingActivation(payload.data as DelegatedAdminScopeConfig, selectedScopeConfig.value)
    if (action === 'assign') selectedAudienceGroupId.value = ''
    await refreshAfterScopeWrite(
      token.userId,
      action === 'assign' ? '插件管理员成员集范围已添加' : '插件管理员成员集范围已移除',
      token.generation,
    )
  } catch (error) {
    if (!memberTokenCurrent(token)) return
    setMemberStatus(token, error instanceof Error ? error.message : '保存成员集范围失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

async function updateUserMemberGroup(action: 'assign' | 'unassign', userIdOverride?: string): Promise<void> {
  const targetUserId = userIdOverride || selectedUserId.value
  const writesSelectedMember = !userIdOverride || userIdOverride === selectedUserId.value
  const accessToken: MemberToken | null = writesSelectedMember
    ? { userId: targetUserId, generation: delegationAccessGeneration }
    : null
  if (!summary.value?.isPlatformAdmin || !targetUserId || !selectedMemberGroupId.value || !hasSelectedMemberGroup.value) return
  if (writesSelectedMember && !memberWritesReady.value) return
  const groupId = selectedMemberGroupId.value
  groupBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(targetUserId)}/member-groups/${action}`, {
      method: 'POST',
      body: JSON.stringify({ groupId }),
    })
    const payload = await readJson(response)
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '保存成员集成员失败'))
    }
    const nextUser = (payload.data as { user?: ManagedUser } | undefined)?.user
    if (
      accessToken
      && memberTokenCurrent(accessToken)
      && selectedAccess.value
      && nextUser?.id === accessToken.userId
      && readSubjectMatches(payload, accessToken.userId)
    ) {
      selectedAccess.value = {
        ...selectedAccess.value,
        user: nextUser,
        roles: (payload.data as { roles: string[] }).roles,
        memberGroups: (payload.data as { memberGroups: MemberGroupSummary[] }).memberGroups,
      }
    }
    await loadMemberGroups()
    if (selectedMemberGroupId.value) {
      await selectMemberGroup(selectedMemberGroupId.value)
    }
    const message = action === 'assign' ? '成员已加入平台成员集' : '成员已移出平台成员集'
    if (accessToken) setMemberStatus(accessToken, message)
    else setStatus(message)
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存成员集成员失败'
    if (accessToken) setMemberStatus(accessToken, message, 'error')
    else setStatus(message, 'error')
  } finally {
    groupBusy.value = false
  }
}

async function applyTemplate(): Promise<void> {
  const targetUserId = selectedUserId.value
  const token: MemberToken = { userId: targetUserId, generation: delegationAccessGeneration }
  const templateId = selectedTemplateId.value
  const expectedScopeVersion = selectedTemplateScopeVersion.value
  if (scopeBusy.value || !summary.value?.isPlatformAdmin || !memberTokenCurrent(token) || !memberWritesReady.value
    || !selectedScopeNamespace.value || !expectedScopeVersion) return
  if (!exactDepartmentWritesEnabled.value && templateContainsExactDepartment(selectedTemplate.value)) {
    setMemberStatus(token, exactDepartmentApplyUnavailableText, 'error')
    return
  }
  scopeBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/role-delegation/users/${encodeURIComponent(token.userId)}/scope-templates/apply`, {
      method: 'POST',
      body: JSON.stringify({
        namespace: selectedScopeNamespace.value,
        templateId,
        expectedScopeVersion,
        mode: 'replace',
      }),
    })
    const payload = await readJson(response)
    if (isExactDepartmentDisabledResponse(response, payload)) {
      noteExactDepartmentDisabledByServer()
      throw new Error(exactDepartmentApplyUnavailableText)
    }
    if (!memberTokenCurrent(token)) return
    if (response.status === 409 && (payload.error as { code?: unknown } | undefined)?.code === 'ROLE_DELEGATION_SCOPE_TEMPLATE_CHANGED') {
      if (selectedTemplateId.value === templateId) selectedTemplate.value = null
      setMemberStatus(token, '范围模板已变更。请点「查询模板」，核对最新内容后再应用。', 'error')
      return
    }
    if (!response.ok || payload.ok !== true) {
      throw new Error(String((payload.error as Record<string, unknown> | undefined)?.message || '应用范围模板失败'))
    }
    const scopeUserId = (payload.data as { user?: { id?: unknown } } | undefined)?.user?.id
    if (!readSubjectMatches(payload, token.userId) || scopeUserId !== token.userId) {
      setMemberStatus(token, '应用范围模板失败', 'error')
      return
    }

    const merged = scopeConfigKeepingActivation(payload.data as DelegatedAdminScopeConfig, selectedScopeConfig.value)
    if (!memberTokenCurrent(token) || merged?.user?.id !== token.userId) return
    selectedScopeConfig.value = merged
    if (scopeActivationFieldPresentFor(merged)) {
      await refreshAfterScopeWrite(token.userId, '范围模板已覆盖应用到该插件管理员命名空间', token.generation)
      return
    }
    setMemberStatus(token, '范围模板已覆盖应用到该插件管理员命名空间')
    await loadSummary()
  } catch (error) {
    if (!memberTokenCurrent(token)) return
    setMemberStatus(token, error instanceof Error ? error.message : '应用范围模板失败', 'error')
  } finally {
    scopeBusy.value = false
  }
}

onMounted(async () => {
  try {
    await loadSummary()
    if (summary.value?.isPlatformAdmin) {
      await loadDepartments()
      await loadTemplates()
      await loadMemberGroups()
    }
    await loadUsers()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '加载角色委派页面失败', 'error')
  }
})
</script>

<style scoped>
.delegation-page,
.delegation-page * {
  box-sizing: border-box;
}

.delegation-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  padding: 24px;
  min-width: 0;
  max-width: 100%;
}

.delegation-page__header,
.delegation-page__actions,
.delegation-page__detail-head,
.delegation-page__role-actions,
.delegation-page__chips,
.delegation-page__role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.delegation-page__header,
.delegation-page__detail-head {
  justify-content: space-between;
  align-items: flex-start;
}

.delegation-page__header h1,
.delegation-page__panel h2,
.delegation-page__section h3 {
  margin: 0;
}

.delegation-page__header p,
.delegation-page__detail-head p,
.delegation-page__role-card span,
.delegation-page__role-card p,
.delegation-page__scope-card span,
.delegation-page__scope-card p,
.delegation-page__hint,
.delegation-page__empty {
  margin: 4px 0 0;
  color: #6b7280;
}

.delegation-page__layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}

.delegation-page > *,
.delegation-page__layout > *,
.delegation-page__header,
.delegation-page__header > *,
.delegation-page__actions,
.delegation-page__actions > *,
.delegation-page__detail-head,
.delegation-page__detail-head > *,
.delegation-page__role-actions,
.delegation-page__role-actions > *,
.delegation-page__chips,
.delegation-page__chips > *,
.delegation-page__role-list,
.delegation-page__role-list > *,
.delegation-page__scope-list,
.delegation-page__scope-list > *,
.delegation-page__panel,
.delegation-page__section,
.delegation-page__user,
.delegation-page__user > *,
.delegation-page__role-card,
.delegation-page__role-card > *,
.delegation-page__scope-card,
.delegation-page__scope-card > * {
  min-width: 0;
}

.delegation-page__panel {
  display: grid;
  gap: 12px;
  max-width: 100%;
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
}

.delegation-page__panel--detail {
  gap: 16px;
}

.delegation-page__user {
  display: grid;
  gap: 4px;
  width: 100%;
  max-width: 100%;
  text-align: left;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 12px;
  cursor: pointer;
}

.delegation-page__user--active {
  border-color: #2563eb;
  background: #eff6ff;
}

.delegation-page__user--disabled {
  color: #6b7280;
  background: #f3f4f6;
  cursor: not-allowed;
}

.delegation-page__check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
}

.delegation-page__input {
  min-width: 0;
  max-width: 100%;
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 12px;
}

.delegation-page__button,
.delegation-page__link {
  height: auto;
  min-height: 38px;
  max-width: 100%;
  border-radius: 8px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.delegation-page__button {
  border: 0;
  background: #2563eb;
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

.delegation-page__button--secondary {
  background: #475569;
}

.delegation-page__button--danger {
  background: #b91c1c;
}

.delegation-page__button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.delegation-page__link {
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  color: #2563eb;
  text-decoration: none;
  font-weight: 600;
}

.delegation-page__status {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
}

.delegation-page__status--error {
  background: #fef2f2;
  color: #dc2626;
}

.scope-activation-confirm {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid #f59e0b;
  border-radius: 12px;
  background: #fffbeb;
}

.delegation-page__chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: 999px;
  background: #f3f4f6;
  color: #111827;
  padding: 4px 10px;
  font-size: 12px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.delegation-page__user strong,
.delegation-page__user span,
.delegation-page__user small,
.delegation-page__header h1,
.delegation-page__header p,
.delegation-page__panel h2,
.delegation-page__section h3,
.delegation-page__detail-head h2,
.delegation-page__detail-head p,
.delegation-page__status,
.delegation-page__hint,
.delegation-page__empty,
.delegation-page__code,
.delegation-page__role-card strong,
.delegation-page__role-card span,
.delegation-page__role-card p,
.delegation-page__scope-card strong,
.delegation-page__scope-card span,
.delegation-page__scope-card p {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.delegation-page__chip--success {
  background: #dcfce7;
  color: #166534;
}

.delegation-page__chip--danger {
  background: #fef2f2;
  color: #b91c1c;
}

.delegation-page__role-card {
  width: min(320px, 100%);
  max-width: 100%;
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}

.delegation-page__scope-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.delegation-page__scope-card {
  width: min(320px, 100%);
  max-width: 100%;
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid #dbeafe;
  border-radius: 10px;
  background: #f8fbff;
}

@media (max-width: 960px) {
  .delegation-page__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .delegation-page__header,
  .delegation-page__detail-head,
  .delegation-page__actions,
  .delegation-page__role-actions {
    flex-direction: column;
    align-items: stretch;
    max-width: 100%;
  }

  .delegation-page__input,
  .delegation-page__actions > .delegation-page__button,
  .delegation-page__actions > .delegation-page__link,
  .delegation-page__role-actions > .delegation-page__button,
  .delegation-page__role-actions > .delegation-page__link {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
}
</style>

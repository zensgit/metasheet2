<template>
  <article class="directory-admin__panel directory-admin__section" data-testid="directory-connection-settings">
    <div class="directory-admin__section-head">
      <div>
        <h2>连接配置 · {{ selectedIntegration ? '编辑集成' : '创建集成' }}</h2>
        <p class="directory-admin__hint">`appSecret` 在更新时可留空，系统会继续使用已保存的值。</p>
        <p class="directory-admin__hint" data-testid="dingtalk-login-config-hint">
          此处的 App Key / App Secret 是目录集成（通讯录拉取）的凭据，不会配置钉钉登录。钉钉登录（OAuth）走服务端环境变量
          DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_REDIRECT_URI，两者互不相通。
          <router-link class="directory-admin__link-button" to="/help/attendance/dingtalk-microapp#server-login">查看钉钉登录配置</router-link>
          <button
            class="directory-admin__link-button"
            type="button"
            data-testid="dingtalk-login-probe-button"
            :disabled="dingtalkLoginProbeBusy"
            @click="void checkDingTalkLoginProbe()"
          >
            登录配置检查
          </button>
          <span
            v-if="dingtalkLoginProbeMessage"
            class="directory-admin__hint-status"
            data-testid="dingtalk-login-probe-status"
            role="status"
          >{{ dingtalkLoginProbeMessage }}</span>
        </p>
      </div>
      <div class="directory-admin__summary" v-if="selectedIntegration">
        <span class="directory-admin__badge">{{ selectedIntegration.status }}</span>
        <span v-if="selectedIntegration.config.identityStatus === 'mismatch'" class="directory-admin__chip directory-admin__chip--warning" role="alert">企业与应用归属不一致</span>
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
        <span>钉钉企业名称（展示）</span>
        <input v-model.trim="draft.corpName" class="directory-admin__input" type="text" maxlength="200" placeholder="填写已确认的企业名称" />
        <small>管理员填写的展示名称；填写名称不代表已核验，不改变账号关联。</small>
      </label>
      <label class="directory-admin__field">
        <span>钉钉应用名称（展示）</span>
        <input v-model.trim="draft.appName" class="directory-admin__input" type="text" maxlength="200" placeholder="填写已确认的应用名称" />
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
      <div class="directory-admin__field" data-testid="directory-root-department-field">
        <span>{{ rootDepartmentPickerAvailable ? '根部门' : '根部门 ID' }}</span>
        <select
          v-if="rootDepartmentPickerAvailable"
          v-model="draft.rootDepartmentId"
          class="directory-admin__input"
          aria-label="根部门"
          data-testid="directory-root-department-select"
        >
          <option v-if="!rootDepartmentTreeIds.has('1')" value="1">全公司（ID 1）</option>
          <option v-if="rootDepartmentNeedsFallbackOption" :value="draft.rootDepartmentId">
            {{ readRootDepartmentFallbackLabel(draft.rootDepartmentId) }}
          </option>
          <option
            v-for="department in departmentRows"
            :key="department.externalDepartmentId"
            :value="department.externalDepartmentId"
          >
            {{ readDepartmentPickerPath(department) }}{{ department.isActive ? '' : '（已停用）' }}
          </option>
        </select>
        <template v-else>
          <input v-model.trim="draft.rootDepartmentId" class="directory-admin__input" type="text" placeholder="默认 1" />
          <p class="directory-admin__hint" data-testid="directory-root-department-hint">
            首次同步前请保持默认 1（全公司）或填写已知部门 ID
          </p>
          <button
            v-if="selectedIntegration && !departmentsLoaded"
            class="directory-admin__link-button"
            type="button"
            :disabled="loadingDepartments"
            @click="void loadDepartmentsForPicker()"
          >
            {{ loadingDepartments ? '加载中...' : '从已同步部门中选择' }}
          </button>
        </template>
      </div>
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
      <div class="directory-admin__field directory-admin__field--wide">
        <span>自动准入部门白名单</span>
        <DirectoryOptionPicker
          test-id="directory-admission-department-picker"
          :selected="readDepartmentTargetIds('admission')"
          :options="departmentPickerOptions"
          :unknown-label="readUnknownDepartmentLabel"
          :loaded="departmentPickerLoaded"
          :loading="loadingDepartments"
          :error="departmentPickerError"
          :empty-text="departmentPickerEmptyText"
          not-loaded-text="正在加载已同步的部门..."
          open-label="选择部门"
          search-placeholder="搜索名称或完整路径"
          empty-selection-text="未选择部门；将覆盖所选部门及其子部门"
          @open="void loadDepartmentsForPicker()"
          @update:selected="(ids) => writeDepartmentTargetText('admission', ids)"
        />
      </div>
      <div class="directory-admin__field directory-admin__field--wide">
        <span>自动准入排除部门</span>
        <DirectoryOptionPicker
          test-id="directory-exclude-department-picker"
          :selected="readDepartmentTargetIds('exclude')"
          :options="departmentPickerOptions"
          :unknown-label="readUnknownDepartmentLabel"
          :loaded="departmentPickerLoaded"
          :loading="loadingDepartments"
          :error="departmentPickerError"
          :empty-text="departmentPickerEmptyText"
          not-loaded-text="正在加载已同步的部门..."
          open-label="选择部门"
          search-placeholder="搜索名称或完整路径"
          empty-selection-text="未选择部门；排除会覆盖白名单父部门"
          @open="void loadDepartmentsForPicker()"
          @update:selected="(ids) => writeDepartmentTargetText('exclude', ids)"
        />
      </div>
      <label class="directory-admin__field">
        <span>成员组同步模式</span>
        <select v-model="draft.memberGroupSyncMode" class="directory-admin__input">
          <option value="disabled">disabled</option>
          <option value="sync_scoped_departments">sync_scoped_departments</option>
        </select>
      </label>
      <div class="directory-admin__field directory-admin__field--wide">
        <span>成员组同步部门</span>
        <DirectoryOptionPicker
          test-id="directory-member-group-department-picker"
          :selected="readDepartmentTargetIds('memberGroup')"
          :options="departmentPickerOptions"
          :unknown-label="readUnknownDepartmentLabel"
          :loaded="departmentPickerLoaded"
          :loading="loadingDepartments"
          :error="departmentPickerError"
          :empty-text="departmentPickerEmptyText"
          not-loaded-text="正在加载已同步的部门..."
          open-label="选择部门"
          search-placeholder="搜索名称或完整路径"
          empty-selection-text="未选择部门；所选部门会投影为平台用户组"
          @open="void loadDepartmentsForPicker()"
          @update:selected="(ids) => writeDepartmentTargetText('memberGroup', ids)"
        />
      </div>
      <div class="directory-admin__field directory-admin__field--wide">
        <span>成员组默认业务角色</span>
        <DirectoryOptionPicker
          test-id="directory-member-group-role-picker"
          :selected="parseAdmissionDepartmentIdsText(draft.memberGroupDefaultRoleIdsText)"
          :options="memberGroupRoleOptions"
          :unknown-label="readUnknownRoleLabel"
          :loaded="roleCatalogLoaded"
          :loading="roleCatalogLoading"
          :error="roleCatalogError"
          empty-text="没有可选的业务角色（平台管理员与委派管理员角色不可作为默认角色）"
          not-loaded-text="正在加载角色列表..."
          open-label="选择角色"
          search-placeholder="搜索角色名称或 ID"
          empty-selection-text="未选择角色；仅对投影成员组里的已链接用户做单向补齐"
          @open="void ensureRoleCatalogLoaded()"
          @update:selected="writeMemberGroupDefaultRoleIds"
        />
      </div>
      <div class="directory-admin__field directory-admin__field--wide">
        <span>成员组默认插件开通</span>
        <DirectoryOptionPicker
          test-id="directory-member-group-namespace-picker"
          :selected="parseAdmissionDepartmentIdsText(draft.memberGroupDefaultNamespacesText)"
          :options="memberGroupNamespaceOptions"
          :unknown-label="readUnknownNamespaceLabel"
          :loaded="roleCatalogLoaded"
          :loading="roleCatalogLoading"
          :error="roleCatalogError"
          empty-text="角色目录里没有可开通的插件命名空间"
          not-loaded-text="正在加载可开通的插件..."
          open-label="选择插件"
          search-placeholder="搜索插件名称或命名空间"
          empty-selection-text="未选择插件"
          @open="void ensureRoleCatalogLoaded()"
          @update:selected="writeMemberGroupDefaultNamespaces"
        />
      </div>
      <div class="directory-admin__field directory-admin__field--wide">
        <span>组织架构同步说明</span>
        <p class="directory-admin__hint">
          当前方案会把钉钉部门和成员同步到目录镜像，并可将选定部门投影为平台成员组，用于权限、表单和消息治理；不会自动生成第二套可编辑的本地组织树。
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

    <details class="directory-admin__manual-ids" data-testid="directory-advanced-settings">
      <summary>高级：手动填写 ID</summary>
      <div
        v-if="rootDepartmentPickerAvailable"
        class="directory-admin__field directory-admin__field--wide"
        data-testid="directory-root-department-manual"
      >
        <span>根部门 ID</span>
        <p class="directory-admin__hint">
          下拉只列出当前根部门下已同步的部门；要扩大同步范围（例如改回全公司），可在这里直接填写部门 ID。
        </p>
        <input
          v-model.trim="draft.rootDepartmentId"
          class="directory-admin__input"
          type="text"
          placeholder="默认 1"
          aria-label="手动填写根部门 ID"
        />
      </div>
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
      <div v-if="selectedIntegration" data-testid="directory-manual-department-fallback">
        <h4>高级：部门尚未同步时手动填写 ID</h4>
        <p class="directory-admin__hint">
          适用于钉钉部门暂未同步到本地镜像、但管理员已确认部门 ID 的场景；这里仍只写入当前配置草稿。
        </p>
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
    </details>

    <DirectoryIntegrationIdentityPanel
      v-if="selectedIntegration"
      :integration="selectedIntegration"
      :corp-name="draft.corpName"
      :app-name="draft.appName"
      :configuration-changed="draft.corpId.trim() !== selectedIntegration.corpId || draft.appKey.trim() !== selectedIntegration.config.appKey || draft.appSecret.trim().length > 0 || draft.baseUrl.trim() !== (selectedIntegration.config.baseUrl ?? '')"
      @saved="void loadIntegrations()"
    />

    <footer class="directory-admin__footer">
      <button class="directory-admin__button" type="button" :disabled="busy || !canSave" @click="void saveIntegration()">
        {{ busy ? '处理中...' : selectedIntegration ? '保存变更' : '创建集成' }}
      </button>
      <button class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void testIntegration()">
        测试连通性
      </button>
    </footer>
  </article>

  <article class="directory-admin__panel directory-admin__section" data-testid="directory-notification-settings">
    <h2>工作通知</h2>
    <div class="directory-admin__form-grid">
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
    </div>
    <footer class="directory-admin__footer">
      <button v-if="selectedIntegration" class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy" @click="void testWorkNotificationAgentId()">
        测试工作通知
      </button>
      <button v-if="selectedIntegration" class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="busy || draft.workNotificationAgentId.trim().length === 0" @click="void saveWorkNotificationAgentId()">
        保存 Agent ID
      </button>
    </footer>
  </article>

  <article class="directory-admin__panel directory-admin__section" data-testid="directory-approval-settings">
    <h2>审批卡片</h2>
    <div class="directory-admin__form-grid">
      <template v-if="selectedIntegration">
        <label class="directory-admin__field">
          <span>一键卡片对外访问地址</span>
          <input v-model.trim="draft.approvalCardPublicAppUrl" class="directory-admin__input" type="text" placeholder="一键卡片深链的对外可达地址；留空则使用部署环境配置" />
        </label>
      </template>
      <div v-if="selectedIntegration" class="directory-admin__field directory-admin__field--wide">
        <span>一键处理卡片配置说明</span>
        <div class="directory-admin__chips">
          <span class="directory-admin__chip" :class="{ 'directory-admin__chip--success': selectedIntegration?.config.approvalCardLinkSecretConfigured, 'directory-admin__chip--danger': selectedIntegration && !selectedIntegration.config.approvalCardLinkSecretConfigured }">
            {{ selectedIntegration?.config.approvalCardLinkSecretConfigured ? '密钥已生成' : '未生成' }}
          </span>
          <span class="directory-admin__chip">不回显密钥值</span>
        </div>
        <p v-if="approvalCardLinkSecretEnvOverrideActive" class="directory-admin__hint">
          部署环境变量已设置，页面生成的密钥暂不生效（环境变量优先）。
        </p>
        <p class="directory-admin__hint">
          深链 HMAC 签名密钥由平台自动生成并加密存储，从不回显明文；重新生成会使已发出但未处理的一键处理卡片链接失效。对外访问地址用于拼接一键处理卡片决策深链，留空则使用部署环境配置。
        </p>
      </div>
      <div v-else class="directory-admin__field directory-admin__field--wide">
        <span>一键处理卡片配置说明</span>
        <p class="directory-admin__hint">
          请先创建并选中钉钉目录集成，再通过专用的“生成随机密钥”和“保存对外访问地址”按钮配置一键处理卡片，密钥永不在页面回显。
        </p>
      </div>
    </div>
    <footer class="directory-admin__footer">
      <button v-if="selectedIntegration" class="directory-admin__button directory-admin__button--secondary" type="button" :disabled="approvalCardBusy" @click="void saveApprovalCardPublicAppUrl()">
        保存对外访问地址
      </button>
    </footer>
    <div class="directory-admin__footer">
      <button v-if="selectedIntegration" class="directory-admin__button directory-admin__button--danger" type="button" :disabled="approvalCardBusy" @click="void generateApprovalCardLinkSecret()">
        {{ approvalCardBusy ? '处理中...' : (selectedIntegration?.config.approvalCardLinkSecretConfigured ? '重新生成密钥' : '生成随机密钥') }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import DirectoryIntegrationIdentityPanel from './DirectoryIntegrationIdentityPanel.vue'
import DirectoryOptionPicker from './DirectoryOptionPicker.vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  addManualDepartmentToTarget,
  approvalCardBusy,
  approvalCardLinkSecretEnvOverrideActive,
  busy,
  canSave,
  checkDingTalkLoginProbe,
  departmentPickerEmptyText,
  departmentPickerError,
  departmentPickerLoaded,
  departmentPickerOptions,
  departmentRows,
  departmentsLoaded,
  dingtalkLoginProbeBusy,
  dingtalkLoginProbeMessage,
  draft,
  ensureRoleCatalogLoaded,
  generateApprovalCardLinkSecret,
  loadDepartmentsForPicker,
  loadIntegrations,
  loadingDepartments,
  manualDepartmentId,
  manualDepartmentName,
  memberGroupNamespaceOptions,
  memberGroupRoleOptions,
  parseAdmissionDepartmentIdsText,
  readDepartmentPickerPath,
  readDepartmentTargetIds,
  readRootDepartmentFallbackLabel,
  readUnknownDepartmentLabel,
  readUnknownNamespaceLabel,
  readUnknownRoleLabel,
  roleCatalogError,
  roleCatalogLoaded,
  roleCatalogLoading,
  rootDepartmentNeedsFallbackOption,
  rootDepartmentPickerAvailable,
  rootDepartmentTreeIds,
  saveApprovalCardPublicAppUrl,
  saveIntegration,
  saveWorkNotificationAgentId,
  selectedIntegration,
  testIntegration,
  testWorkNotificationAgentId,
  writeDepartmentTargetText,
  writeMemberGroupDefaultNamespaces,
  writeMemberGroupDefaultRoleIds,
} = inject(directoryManagementKey)!
</script>

<style scoped src="./directory-admin.css"></style>

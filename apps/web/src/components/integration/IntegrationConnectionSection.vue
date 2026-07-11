<template>
  <section id="int-sec-connection" class="integration-workbench__panel">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>连接系统 / 数据源</h2>
        <p>普通用户选择已配置连接；SQL 通道是高级连接，只用于 allowlist 表、视图或中间表。</p>
      </div>
      <button type="button" class="integration-workbench__button" data-testid="refresh-systems" @click="refreshBootstrap">
        刷新连接
      </button>
    </div>
      </template>


    <div class="integration-workbench__onboarding" data-testid="connection-onboarding">
      <div>
        <strong>新增或管理连接</strong>
        <p>这是页面内连接设置区，不会跳到独立设置页。业务用户可从 K3 WISE 预设开始，实施人员再展开 SQL / 高级连接。</p>
      </div>
      <div class="integration-workbench__onboarding-actions">
        <router-link class="integration-workbench__button" to="/integrations/k3-wise" data-testid="k3-preset-entry">
          使用 K3 WISE 预设
        </router-link>
        <button type="button" class="integration-workbench__button" data-testid="connect-new-system" @click="showConnectionGuide">
          新增连接草稿
        </button>
        <button type="button" class="integration-workbench__button" data-testid="show-sql-setup" @click="showSqlSetup">
          展开 SQL / 高级连接
        </button>
      </div>
    </div>

    <button
      type="button"
      class="integration-workbench__inventory-toggle"
      data-testid="toggle-inventory-overview"
      :aria-expanded="inventoryExpanded ? 'true' : 'false'"
      @click="inventoryExpanded = !inventoryExpanded"
    >
      {{ inventorySummary }} <span>{{ inventoryExpanded ? '收起' : '展开' }}</span>
    </button>

    <div v-if="inventoryExpanded" class="integration-workbench__inventory" data-testid="inventory-overview">
      <div>
        <h3>已配置连接</h3>
        <p class="integration-workbench__muted">在这里编辑、复制、停用 / 启用或删除连接；删除仅限未被清洗流程引用的连接。</p>
        <div v-if="systems.length === 0" class="integration-workbench__empty" data-testid="connections-empty-state">
          <strong data-testid="connections-empty-what">{{ bi(
            '这里是你已连接的外部系统（CRM / PLM / ERP / SRM / HTTP / SQL）。',
            'This lists the external systems you have connected (CRM / PLM / ERP / SRM / HTTP / SQL).',
          ) }}</strong>
          <p data-testid="connections-empty-first-step">{{ bi(
            '第一步：使用 K3 WISE 预设快速开始，或点击上方"新增连接草稿"创建一个连接。',
            'First step: start quickly with the K3 WISE preset, or click "new connection draft" above to create one.',
          ) }}</p>
        </div>
        <ul v-else class="integration-workbench__inventory-list">
          <li v-for="system in systems" :key="system.id">
            <strong>{{ system.name }}</strong>
            <span>{{ system.kind }} · {{ system.role }} · {{ connectionStatusLabel(system) }}</span>
            <small v-if="runtimeBlockerForSystem(system)">{{ runtimeBlockerForSystem(system) }}</small>
            <div class="integration-workbench__actions integration-workbench__actions--inline">
              <button type="button" class="integration-workbench__icon-button" :data-testid="`edit-connection-${system.id}`" @click="editConnection(system)">
                编辑
              </button>
              <button type="button" class="integration-workbench__icon-button" :data-testid="`copy-connection-${system.id}`" @click="copyConnection(system)">
                复制
              </button>
              <button v-if="system.status !== 'inactive'" type="button" class="integration-workbench__icon-button" :data-testid="`deactivate-connection-${system.id}`" @click="deactivateConnection(system)">
                停用
              </button>
              <button v-else type="button" class="integration-workbench__icon-button" :data-testid="`activate-connection-${system.id}`" @click="activateConnection(system)">
                启用
              </button>
              <button type="button" class="integration-workbench__icon-button" :data-testid="`delete-connection-${system.id}`" :disabled="deletingConnectionId === system.id" title="只能删除未被 pipeline 引用的连接" @click="deleteConnection(system)">
                {{ deletingConnectionId === system.id ? '删除中' : '删除' }}
              </button>
            </div>
          </li>
        </ul>
      </div>
      <div>
        <h3>可用适配器</h3>
        <ul class="integration-workbench__inventory-list">
          <li v-for="adapter in adapters" :key="adapter.kind">
            <strong>{{ adapter.label }}</strong>
            <span>{{ adapter.kind }} · {{ adapter.roles.join('/') }}</span>
            <small>{{ adapter.advanced ? '高级 / 实施人员使用' : '普通连接' }}</small>
          </li>
        </ul>
      </div>
      <div>
        <h3>Staging 多维表</h3>
        <ul class="integration-workbench__inventory-list">
          <li v-for="descriptor in stagingDatasetCards" :key="descriptor.id">
            <strong>{{ descriptor.name }}</strong>
            <span>{{ descriptor.area }} · {{ descriptor.fieldCount }} 个字段</span>
            <small>{{ descriptor.openLink ? '可打开多维表' : '等待安装后返回打开链接' }}</small>
          </li>
        </ul>
      </div>
    </div>

    <div class="integration-workbench__adapter-list">
      <span
        v-for="adapter in visibleAdapters"
        :key="adapter.kind"
        class="integration-workbench__adapter"
        :data-advanced="adapter.advanced ? 'true' : 'false'"
      >
        {{ adapter.label }}
        <small v-if="adapter.advanced">高级</small>
      </span>
    </div>

    <label class="integration-workbench__advanced-toggle">
      <input v-model="showAdvancedConnectors" type="checkbox" data-testid="show-advanced-connectors" />
      <span>显示 SQL / 高级连接（实施人员或管理员使用）</span>
    </label>
    <div v-if="!showAdvancedConnectors && hiddenAdvancedSystemCount > 0" class="integration-workbench__hint" data-testid="advanced-hidden-hint">
      已隐藏 {{ hiddenAdvancedSystemCount }} 个高级连接。SQL 通道默认不进入业务用户连接列表。
    </div>
    <div v-if="showAdvancedConnectors" class="integration-workbench__hint" data-testid="advanced-visible-hint">
      高级连接只用于 allowlist 表/视图读取或中间表写入；不要把核心业务表直写暴露给普通用户。
    </div>

    <div class="integration-workbench__connection-manager" data-testid="connection-manager">
      <div>
        <strong>{{ connectionDraftTitle }}</strong>
        <p>这是内嵌连接设置面板：保存后会回到上方“已配置连接”和下方来源/目标选择器。真实账号、密码、Token 仍通过各系统预设向导或后端凭证库处理。</p>
      </div>
      <div class="integration-workbench__grid integration-workbench__grid--compact">
        <label>
          <span>连接名称</span>
          <input v-model="connectionDraft.name" data-testid="connection-draft-name" placeholder="例如 K3 WISE WebAPI" />
        </label>
        <label>
          <span>连接类型</span>
          <select v-model="connectionDraft.kind" data-testid="connection-draft-kind">
            <option value="">请选择 adapter</option>
            <option v-for="adapter in connectionDraftAdapterOptions" :key="adapter.kind" :value="adapter.kind">
              {{ adapter.label }} · {{ adapter.kind }}
            </option>
          </select>
        </label>
        <label>
          <span>连接角色</span>
          <select v-model="connectionDraft.role" data-testid="connection-draft-role">
            <option value="source">数据源 source</option>
            <option value="target">目标 target</option>
            <option value="bidirectional">双向 bidirectional</option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select v-model="connectionDraft.status" data-testid="connection-draft-status">
            <option value="active">active</option>
            <option value="inactive">inactive</option>
            <option value="error">error</option>
          </select>
        </label>
      </div>
      <div v-if="isDataSourceBridgeKind" class="integration-workbench__grid integration-workbench__grid--compact" data-testid="data-source-bridge-picker">
        <label>
          <span>数据源(只读)</span>
          <select v-model="connectionDraft.dataSourceId" data-testid="data-source-bridge-id" @change="onBridgeDataSourceChange">
            <option value="">请选择已配置的数据源</option>
            <option v-for="ds in bridgeDataSources" :key="ds.id" :value="ds.id">{{ ds.name }} · {{ ds.type }}</option>
          </select>
        </label>
        <label>
          <span>对象(表 / 视图)</span>
          <select
            v-model="connectionDraft.dataSourceObject"
            data-testid="data-source-bridge-object"
            :disabled="bridgeDataSourceObjectsLoading || !connectionDraft.dataSourceId || bridgeDataSourceObjectOptions.length === 0"
          >
            <option value="">{{ bridgeDataSourceObjectOptions.length > 0 ? '请选择表 / 视图' : '请先加载表 / 视图列表' }}</option>
            <option v-for="object in bridgeDataSourceObjectOptions" :key="object.value" :value="object.value">
              {{ object.label }}
            </option>
          </select>
        </label>
        <p v-if="bridgeDataSourceObjectsLoading" class="integration-workbench__hint" data-testid="data-source-bridge-object-loading">正在加载表 / 视图列表...</p>
        <p v-if="!bridgeDataSourceObjectsLoading && connectionDraft.dataSourceId && bridgeDataSourceObjectOptions.length === 0 && !bridgeDataSourceObjectsError" class="integration-workbench__hint" data-testid="data-source-bridge-object-empty">没有可选表 / 视图；请回 /data-sources 检查权限或 schema。</p>
        <p v-if="selectedBridgeObjectSummary" class="integration-workbench__hint" data-testid="data-source-bridge-object-summary">{{ selectedBridgeObjectSummary }}</p>
        <p class="integration-workbench__hint" data-testid="data-source-bridge-hint">凭据由 /data-sources 管理,这里只引用 dataSourceId,不复制账号密码。</p>
        <p v-if="bridgeDataSourcesError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="data-source-bridge-error">{{ bridgeDataSourcesError }}</p>
        <p v-if="bridgeDataSourceObjectsError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="data-source-bridge-object-error">{{ bridgeDataSourceObjectsError }}</p>
      </div>
      <div v-if="connectionDraftDuplicateWarning" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="connection-duplicate-warning">
        {{ connectionDraftDuplicateWarning }}
      </div>
      <div v-if="connectionDraftRoleWarning" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="connection-role-warning">
        {{ connectionDraftRoleWarning }}
      </div>
      <details v-if="!isDataSourceBridgeKind" class="integration-workbench__details">
        <summary>高级 JSON 配置（不会显示或保存凭证）</summary>
        <p v-if="isK3WiseWebapiKind" class="integration-workbench__hint" data-testid="connection-draft-k3-setup-hint">
          {{ bi('该类型有专页配置：', 'This connection type has its own dedicated setup page: ') }}
          <router-link to="/integrations/k3-wise" data-testid="connection-draft-k3-setup-link">
            {{ bi('前往 K3 WISE 设置向导', 'Open the K3 WISE setup wizard') }}
          </router-link>
        </p>
        <div class="integration-workbench__grid integration-workbench__grid--compact">
          <label>
            <span>config JSON</span>
            <textarea v-model="connectionDraft.configText" data-testid="connection-draft-config"></textarea>
            <JsonAssist
              v-model="connectionDraft.configText"
              test-id="connection-draft-config"
              :placeholder-example="connectionConfigExample"
            />
          </label>
          <label>
            <span>capabilities JSON</span>
            <textarea v-model="connectionDraft.capabilitiesText" data-testid="connection-draft-capabilities"></textarea>
            <JsonAssist
              v-model="connectionDraft.capabilitiesText"
              test-id="connection-draft-capabilities"
              :placeholder-example="connectionCapabilitiesExample"
            />
          </label>
        </div>
      </details>
      <div v-if="connectionDraftJsonError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="connection-json-error">
        {{ connectionDraftJsonError }}
      </div>
      <div class="integration-workbench__actions">
        <button type="button" class="integration-workbench__button" data-testid="save-connection-draft" :disabled="savingConnectionDraft || !canSaveConnectionDraft" @click="saveConnectionDraft">
          {{ savingConnectionDraft ? '保存中' : '保存连接设置' }}
        </button>
        <button type="button" class="integration-workbench__button" data-testid="reset-connection-draft" @click="resetConnectionDraft">
          清空草稿
        </button>
      </div>
    </div>

    <div class="integration-workbench__grid">
      <label>
        <span>Tenant ID</span>
        <input v-model="scope.tenantId" data-testid="tenant-id" />
      </label>
      <label>
        <span>Workspace ID</span>
        <input v-model="workspaceInput" data-testid="workspace-id" placeholder="可选" />
      </label>
    </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage C): extracted verbatim from IntegrationWorkbenchView.vue's `int-sec-connection` section
// (pure template/markup move — no state or service-call logic lives here). The parent view owns
// every ref/computed/service-call; this component only renders them and forwards user actions
// back up via the exact same function references it is handed as props.
//
// `connectionDraft` and `scope` are both `reactive(...)` objects owned by the parent — passed
// down as plain data props and mutated *in place* via nested `v-model`s (`v-model=
// "connectionDraft.name"`, `v-model="scope.tenantId"`), exactly the same nested-prop-mutation
// pattern IU-2b already used for `IntegrationMappingRulesSection`'s `mappings` array: the child
// receives the same reactive proxy the parent's `reactive()` call returned, so mutating a nested
// field here mutates the identical object the parent reads from — no different from the
// pre-extraction inline behavior. This file is not part of `apps/web`'s lint file list (see
// `package.json`'s `lint` script), so the nested-prop-mutation pattern carries no
// `vue/no-mutating-props` lint-gate risk.
//
// `inventoryExpanded` / `showAdvancedConnectors` / `workspaceInput` are the three primitive
// two-way binds in this section, so each uses `defineModel` (same pattern as IU-2b's
// `stagingBaseId`). `workspaceInput` is a writable `computed` in the parent (get/set wrapping
// `scope.workspaceId`) rather than a plain `ref` — Vue's `v-model` binds to any ref-like target,
// so `v-model:workspace-input="workspaceInput"` at the call site works identically whether the
// parent hands over a `ref` or a writable `computed`.
import { computed } from 'vue'
import type { DataSourceListItem } from '../../data-sources/types'
import type { IntegrationAdapterMetadata, WorkbenchExternalSystem } from '../../services/integration/workbench'
import type {
  BridgeDataSourceObjectOption,
  ConnectionDraft,
  IntegrationScopeState,
  StagingDatasetCard,
} from './integrationWorkbenchSectionTypes'
import JsonAssist from './JsonAssist.vue'

const props = defineProps<{
  bi: (zh: string, en: string) => string
  refreshBootstrap: () => Promise<void>
  showConnectionGuide: () => void
  showSqlSetup: () => void
  inventorySummary: string
  systems: WorkbenchExternalSystem[]
  connectionStatusLabel: (system: WorkbenchExternalSystem | null) => string
  runtimeBlockerForSystem: (system: WorkbenchExternalSystem | null) => string
  editConnection: (system: WorkbenchExternalSystem) => void
  copyConnection: (system: WorkbenchExternalSystem) => void
  deactivateConnection: (system: WorkbenchExternalSystem) => Promise<void>
  activateConnection: (system: WorkbenchExternalSystem) => Promise<void>
  deleteConnection: (system: WorkbenchExternalSystem) => Promise<void>
  deletingConnectionId: string
  adapters: IntegrationAdapterMetadata[]
  stagingDatasetCards: StagingDatasetCard[]
  visibleAdapters: IntegrationAdapterMetadata[]
  hiddenAdvancedSystemCount: number
  connectionDraftTitle: string
  connectionDraft: ConnectionDraft
  connectionDraftAdapterOptions: Array<{ kind: string; label: string }>
  isDataSourceBridgeKind: boolean
  onBridgeDataSourceChange: () => void
  bridgeDataSources: DataSourceListItem[]
  bridgeDataSourceObjectsLoading: boolean
  bridgeDataSourceObjectOptions: BridgeDataSourceObjectOption[]
  bridgeDataSourceObjectsError: string
  selectedBridgeObjectSummary: string
  bridgeDataSourcesError: string
  connectionDraftDuplicateWarning: string
  connectionDraftRoleWarning: string
  connectionDraftJsonError: string
  savingConnectionDraft: boolean
  canSaveConnectionDraft: boolean
  saveConnectionDraft: () => Promise<void>
  resetConnectionDraft: () => void
  scope: IntegrationScopeState
}>()

const inventoryExpanded = defineModel<boolean>('inventoryExpanded', { default: false })
const showAdvancedConnectors = defineModel<boolean>('showAdvancedConnectors', { default: false })
const workspaceInput = defineModel<string>('workspaceInput', { default: '' })

// IU-5a (design-lock §2 IU-5, site 1 "connection-draft-config" + site 2
// "connection-draft-capabilities" disposition): JsonAssist is a side-mounted format+validate
// strip, not a replacement for the raw textareas above (both textareas and their data-testids
// stay exactly as they were). K3_WISE_WEBAPI_KIND drives the one extra per-site rule the
// disposition calls for — a hint pointing at the dedicated K3 WISE setup wizard (existing route,
// see router/appRoutes.ts) when that adapter kind is selected, since that kind has its own
// full-page config flow and the raw JSON editor here is a rarely-needed advanced override.
const K3_WISE_WEBAPI_KIND = 'erp:k3-wise-webapi'
const K3_WISE_SQLSERVER_KIND = 'erp:k3-wise-sqlserver'

const isK3WiseWebapiKind = computed(() => props.connectionDraft.kind === K3_WISE_WEBAPI_KIND)

// Values-free (no real hosts/tokens/IDs) placeholder shapes, one per adapter-kind family, purely
// to give the JSON-assist status line something concrete to show while the field is empty — never
// a claim about the exact backend contract (that lives in the K3 setup wizard / adapter docs).
const connectionConfigExample = computed(() => {
  const kind = props.connectionDraft.kind
  if (kind === K3_WISE_WEBAPI_KIND || kind === K3_WISE_SQLSERVER_KIND) {
    return JSON.stringify({ note: props.bi('<建议改用 K3 WISE 设置向导>', '<prefer the K3 WISE setup wizard>') })
  }
  if (kind.startsWith('metasheet:')) {
    return JSON.stringify({ baseId: '<staging-base-id>', tableId: '<staging-table-id>' })
  }
  if (kind.startsWith('http')) {
    return JSON.stringify({ baseUrl: '<https://example.internal/api>', authHeaderName: '<header-name>' })
  }
  return JSON.stringify({ '<config-key>': '<config-value>' })
})

const connectionCapabilitiesExample = JSON.stringify({
  read: '<true|false>',
  upsert: '<true|false>',
  rateLimitPerMinute: '<number>',
})
</script>

<style scoped>
/* Verbatim copies of the rules in IntegrationWorkbenchView.vue's <style scoped> block that
   target markup now rendered by this component — see IntegrationMonitoringSection.vue's style
   block comment for why duplication (not relocation) is the correct approach here. */
.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench h2 {
  margin: 0;
  font-size: 17px;
}

.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__k3-link,
.integration-workbench__button,
.integration-workbench__icon-button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
}

.integration-workbench__k3-link,
.integration-workbench__button {
  padding: 8px 12px;
}

.integration-workbench__icon-button {
  padding: 6px 8px;
}

.integration-workbench__button:hover,
.integration-workbench__icon-button:hover,
.integration-workbench__k3-link:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled,
.integration-workbench__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__adapter-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__onboarding {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.integration-workbench__onboarding strong {
  color: var(--ms-text-1);
}

.integration-workbench__onboarding p {
  margin: 4px 0 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__onboarding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.integration-workbench__connection-manager {
  display: grid;
  gap: 12px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__connection-manager strong {
  color: var(--ms-text-1);
}

.integration-workbench__connection-manager p {
  margin: 4px 0 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__details {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 10px;
}

.integration-workbench__details summary {
  cursor: pointer;
  color: var(--ms-text-1);
  font-weight: 700;
}

.integration-workbench__inventory-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  text-align: left;
}

.integration-workbench__inventory-toggle span {
  color: var(--ms-color-primary);
  font-size: 13px;
}

.integration-workbench__inventory {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 10px;
}

.integration-workbench__inventory-list {
  display: grid;
  gap: 8px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__inventory-list li {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--ms-bg-card);
}

.integration-workbench__inventory-list span,
.integration-workbench__inventory-list small {
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.4;
}

.integration-workbench__adapter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  color: var(--ms-text-1);
  font-size: 13px;
}

.integration-workbench__adapter small {
  color: var(--el-color-warning-dark-2);
  font-weight: 700;
}

.integration-workbench__advanced-toggle {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__advanced-toggle input {
  width: auto;
}

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__hint--strong {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--compact {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.integration-workbench__muted {
  margin: -4px 0 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  color: var(--ms-text-2);
}

.integration-workbench__empty strong {
  color: var(--ms-text-1);
}

.integration-workbench__empty p {
  margin: 6px 0 0;
}

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select,
.integration-workbench textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench textarea {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__actions--inline {
  justify-content: flex-end;
  margin-top: 0;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head,
  .integration-workbench__inventory,
  .integration-workbench__onboarding,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }

  .integration-workbench__onboarding {
    display: grid;
  }

  .integration-workbench__onboarding-actions {
    justify-content: flex-start;
  }
}
</style>

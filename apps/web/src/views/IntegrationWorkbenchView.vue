<template>
  <section class="integration-workbench">
    <header class="integration-workbench__header">
      <div>
        <p class="integration-workbench__eyebrow">Data Factory</p>
        <h1>数据工厂</h1>
        <p class="integration-workbench__lead">连接任意 CRM / PLM / ERP / SRM / HTTP / SQL 系统，把数据落到多维表清洗后，先 dry-run，再导出或 Save-only 推送。</p>
      </div>
      <router-link class="integration-workbench__k3-link" to="/integrations/k3-wise">K3 WISE 预设模板</router-link>
    </header>

    <nav class="integration-workbench__flow" aria-label="data factory flow" data-testid="data-factory-flow">
      <div v-for="step in flowSteps" :key="step.title" class="integration-workbench__flow-step">
        <strong>{{ step.title }}</strong>
        <span>{{ step.description }}</span>
      </div>
    </nav>
    <div class="integration-workbench__quick-flow" data-testid="data-factory-quick-flow">
      <strong>操作路径</strong>
      <span>1. 选来源系统 -> 2. 选来源数据集 -> 3. 选目标系统 -> 4. 选目标数据集 -> 5. 配映射 -> 6. Dry-run -> 7. 推送</span>
    </div>

    <div v-if="statusMessage" class="integration-workbench__status" :data-kind="statusKind">
      {{ statusMessage }}
    </div>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>连接系统 / 数据源</h2>
          <p>普通用户选择已配置连接；SQL 通道是高级连接，只用于 allowlist 表、视图或中间表。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="refresh-systems" @click="refreshBootstrap">
          刷新连接
        </button>
      </div>

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
          <div v-if="systems.length === 0" class="integration-workbench__empty">暂无连接。请使用 K3 WISE 预设或后续连接向导创建。</div>
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
            <select v-model="connectionDraft.dataSourceId" data-testid="data-source-bridge-id">
              <option value="">请选择已配置的数据源</option>
              <option v-for="ds in bridgeDataSources" :key="ds.id" :value="ds.id">{{ ds.name }} · {{ ds.type }}</option>
            </select>
          </label>
          <label>
            <span>对象(表 / 视图)</span>
            <input v-model="connectionDraft.dataSourceObject" data-testid="data-source-bridge-object" placeholder="例如 public.items" />
          </label>
          <p class="integration-workbench__hint" data-testid="data-source-bridge-hint">凭据由 /data-sources 管理,这里只引用 dataSourceId,不复制账号密码。</p>
          <p v-if="bridgeDataSourcesError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="data-source-bridge-error">{{ bridgeDataSourcesError }}</p>
        </div>
        <div v-if="connectionDraftDuplicateWarning" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="connection-duplicate-warning">
          {{ connectionDraftDuplicateWarning }}
        </div>
        <div v-if="connectionDraftRoleWarning" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="connection-role-warning">
          {{ connectionDraftRoleWarning }}
        </div>
        <details v-if="!isDataSourceBridgeKind" class="integration-workbench__details">
          <summary>高级 JSON 配置（不会显示或保存凭证）</summary>
          <div class="integration-workbench__grid integration-workbench__grid--compact">
            <label>
              <span>config JSON</span>
              <textarea v-model="connectionDraft.configText" data-testid="connection-draft-config"></textarea>
            </label>
            <label>
              <span>capabilities JSON</span>
              <textarea v-model="connectionDraft.capabilitiesText" data-testid="connection-draft-capabilities"></textarea>
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
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>选择系统与数据集</h2>
          <p>来源对象决定从哪里取数，目标模板决定写到哪里。先选系统，再加载可选数据集或模板。</p>
        </div>
      </div>
      <div class="integration-workbench__grid integration-workbench__grid--systems">
        <div class="integration-workbench__system-column">
          <h2>1. 来源对象选择</h2>
          <label>
            <span>数据源系统</span>
            <select v-model="sourceSystemId" data-testid="source-system">
              <option value="">请选择数据源系统</option>
              <option
                v-for="system in sourceSystems"
                :key="system.id"
                :value="system.id"
                :disabled="isSourceOptionDisabled(system)"
                :data-disabled="isSourceOptionDisabled(system) ? 'true' : 'false'"
                :data-testid="`source-system-option-${system.id}`"
              >
                {{ system.name }} · {{ system.kind }}
              </option>
            </select>
          </label>
          <div class="integration-workbench__hint" data-testid="source-selector-explanation">
            {{ sourceSelectorExplanation }}
          </div>
          <div
            v-if="selectedPlmApprovalCapabilityEntry"
            class="integration-workbench__capability-entry"
            :data-state="selectedPlmApprovalCapabilityEntry.state"
            :data-action-status="selectedPlmApprovalCapabilityEntry.actionStatus || 'none'"
            data-testid="plm-approval-capability-entry"
          >
            <div>
              <span class="integration-workbench__badge" :data-status="selectedPlmApprovalCapabilityEntry.state">
                {{ selectedPlmApprovalCapabilityEntry.badge }}
              </span>
              <strong>{{ selectedPlmApprovalCapabilityEntry.title }}</strong>
            </div>
            <p>{{ selectedPlmApprovalCapabilityEntry.detail }}</p>
            <small v-if="selectedPlmApprovalCapabilityEntry.apiVersion">
              {{ PLM_APPROVAL_AUTOMATION_FEATURE_KEY }} · API {{ selectedPlmApprovalCapabilityEntry.apiVersion }}
            </small>
          </div>
          <div
            v-if="selectedPlmBomMultitableCapabilityEntry"
            class="integration-workbench__capability-entry"
            :data-state="selectedPlmBomMultitableCapabilityEntry.state"
            data-testid="plm-bom-multitable-capability-entry"
          >
            <div>
              <span class="integration-workbench__badge" :data-status="selectedPlmBomMultitableCapabilityEntry.state">
                {{ selectedPlmBomMultitableCapabilityEntry.badge }}
              </span>
              <strong>{{ selectedPlmBomMultitableCapabilityEntry.title }}</strong>
            </div>
            <p>{{ selectedPlmBomMultitableCapabilityEntry.detail }}</p>
            <small v-if="selectedPlmBomMultitableCapabilityEntry.apiVersion">
              {{ PLM_BOM_MULTITABLE_FEATURE_KEY }} · API {{ selectedPlmBomMultitableCapabilityEntry.apiVersion }}
            </small>
            <PlmBomReviewPanel
              v-if="selectedPlmBomMultitableCapabilityEntry.state === 'enabled' && selectedSourcePlmDataSourceId"
              :data-source-id="selectedSourcePlmDataSourceId"
            />
          </div>
          <div v-if="!hasRunnableSourceSystem" class="integration-workbench__empty integration-workbench__empty--actionable" data-testid="source-empty-state">
            <strong>还没有可读取的数据源。</strong>
            <p>连接 PLM、HTTP API 或启用 SQL 只读通道后，可将数据导入 staging 多维表再清洗。</p>
            <div class="integration-workbench__actions">
              <router-link class="integration-workbench__button" to="/integrations/k3-wise">使用 K3 WISE 预设</router-link>
              <button type="button" class="integration-workbench__button" data-testid="show-staging-setup" @click="showStagingSetup">创建 staging 多维表作为来源</button>
              <button type="button" class="integration-workbench__button" @click="showSqlSetup">启用 SQL 只读通道</button>
            </div>
          </div>
          <div v-if="sourceRuntimeBlocker" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="source-runtime-blocker">
            {{ sourceRuntimeBlocker }}
          </div>
          <div v-if="k3WebApiReadGateNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="k3-webapi-read-gate-notice">
            {{ k3WebApiReadGateNotice }}
          </div>
          <div v-if="sqlChannelDisabledHint" class="integration-workbench__hint" data-testid="sql-channel-disabled-hint">
            {{ sqlChannelDisabledHint }}
          </div>
          <div class="integration-workbench__connection-row">
            <span class="integration-workbench__badge" :data-status="sourceConnectionStatus">{{ sourceConnectionLabel }}</span>
            <button type="button" class="integration-workbench__button" data-testid="test-source-system" @click="testSystem('source')">
              测试来源连接
            </button>
            <button type="button" class="integration-workbench__button" data-testid="load-source-objects" @click="loadObjects('source')">
              加载来源对象
            </button>
          </div>
          <label>
            <span>来源数据集（从哪里取数）</span>
            <select v-model="sourceObjectName" data-testid="source-object" @change="loadSchema('source')">
              <option value="">请选择来源数据集</option>
              <option v-for="object in sourceObjects" :key="object.name" :value="object.name">
                {{ object.label || object.name }}
              </option>
            </select>
          </label>
          <ul class="integration-workbench__schema-list">
            <li v-for="field in sourceSchema.fields" :key="field.name">
              {{ field.label || field.name }} <code>{{ field.name }}</code>
            </li>
          </ul>
        </div>

        <div class="integration-workbench__system-column">
          <h2>2. 目标模板选择</h2>
          <label>
            <span>目标系统</span>
            <select v-model="targetSystemId" data-testid="target-system">
              <option value="">请选择目标系统</option>
              <option v-for="system in targetSystems" :key="system.id" :value="system.id">
                {{ system.name }} · {{ system.kind }}
              </option>
            </select>
          </label>
          <div class="integration-workbench__hint" data-testid="target-selector-explanation">
            {{ targetSelectorExplanation }}
          </div>
          <div class="integration-workbench__connection-row">
            <span class="integration-workbench__badge" :data-status="targetConnectionStatus">{{ targetConnectionLabel }}</span>
            <button type="button" class="integration-workbench__button" data-testid="test-target-system" @click="testSystem('target')">
              测试目标连接
            </button>
            <button type="button" class="integration-workbench__button" data-testid="load-target-objects" @click="loadObjects('target')">
              加载目标模板
            </button>
          </div>
          <label>
            <span>目标数据集 / 模板（写到哪里）</span>
            <select v-model="targetObjectName" data-testid="target-object" @change="loadSchema('target')">
              <option value="">请选择目标数据集</option>
              <option v-for="object in targetObjects" :key="object.name" :value="object.name">
                {{ object.label || object.name }}
              </option>
            </select>
          </label>
          <ul class="integration-workbench__schema-list">
            <li v-for="field in targetSchema.fields" :key="field.name">
              {{ field.label || field.name }} <code>{{ field.name }}</code>
              <strong v-if="field.required">必填</strong>
            </li>
          </ul>
        </div>
      </div>
      <div v-if="sameSystemNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="same-system-notice">
        {{ sameSystemNotice }}
      </div>
      <div v-if="protocolSplitNotice" class="integration-workbench__hint" data-testid="protocol-split-notice">
        {{ protocolSplitNotice }}
      </div>
      <div v-if="stagingTargetMismatchNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="source-target-mismatch-notice">
        <span>{{ stagingTargetMismatchNotice }}</span>
        <button
          v-if="recommendedStagingSourceObject"
          type="button"
          class="integration-workbench__button"
          data-testid="use-recommended-staging-source"
          @click="useRecommendedStagingSource"
        >
          切换到 {{ stagingDatasetCopy[recommendedStagingSourceObject]?.name || recommendedStagingSourceObject }}
        </button>
      </div>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>数据集与多维表清洗</h2>
          <p>数据源和目标系统只负责读写；业务清洗、审核、修正发生在多维表里。未安装清洗表时，可在这里创建 staging 多维表。</p>
        </div>
      </div>

      <div class="integration-workbench__dataset-grid" data-testid="dataset-cards">
        <article class="integration-workbench__dataset-card" data-testid="source-dataset-card">
          <div class="integration-workbench__dataset-head">
            <span class="integration-workbench__dataset-kind">数据源</span>
            <strong>{{ sourceDatasetTitle }}</strong>
          </div>
          <p>{{ sourceDatasetDescription }}</p>
          <div class="integration-workbench__metric-row">
            <span>{{ sourceSchema.fields.length }} 个字段</span>
            <span>{{ sourceConnectionLabel }}</span>
          </div>
        </article>

        <article class="integration-workbench__dataset-card" data-testid="staging-dataset-card">
          <div class="integration-workbench__dataset-head">
            <span class="integration-workbench__dataset-kind">多维表清洗区</span>
            <strong>{{ selectedStagingDescriptor?.name || '未绑定 staging 表' }}</strong>
          </div>
          <p>原始区、清洗区和回写区都在多维表中呈现，业务人员不需要直接维护 JSON。</p>
          <div class="integration-workbench__metric-row">
            <span>{{ stagingDescriptors.length }} 张表</span>
            <span>{{ selectedStagingDescriptor ? getStagingAreaLabel(selectedStagingDescriptor.id) : '待选择' }}</span>
          </div>
        </article>

        <article class="integration-workbench__dataset-card" data-testid="target-dataset-card">
          <div class="integration-workbench__dataset-head">
            <span class="integration-workbench__dataset-kind">目标系统</span>
            <strong>{{ targetDatasetTitle }}</strong>
          </div>
          <p>{{ targetDatasetDescription }}</p>
          <div class="integration-workbench__metric-row">
            <span>{{ targetSchema.fields.length }} 个字段</span>
            <span>{{ requiredTargetFieldCount }} 个必填</span>
          </div>
        </article>
      </div>

      <div v-if="stagingDescriptors.length" class="integration-workbench__staging-list" data-testid="staging-dataset-list">
        <article v-for="descriptor in stagingDatasetCards" :key="descriptor.id" class="integration-workbench__staging-card">
          <div>
            <strong>{{ descriptor.name }}</strong>
            <p>{{ descriptor.description }}</p>
            <small>{{ descriptor.id }} · {{ descriptor.fieldCount }} 个字段 · {{ descriptor.area }}</small>
          </div>
          <div class="integration-workbench__actions integration-workbench__actions--inline">
            <a
              v-if="descriptor.openLink"
              class="integration-workbench__button"
              :href="descriptor.openLink"
              target="_blank"
              rel="noopener noreferrer"
              :data-testid="`open-staging-${descriptor.id}`"
            >
              打开多维表（新建记录入口）
            </a>
            <button
              v-else
              type="button"
              class="integration-workbench__button"
              :disabled="installingStaging"
              :data-testid="`refresh-staging-link-${descriptor.id}`"
              @click="installStagingTables"
            >
              {{ installingStaging ? '生成中' : '生成打开链接' }}
            </button>
            <button
              type="button"
              class="integration-workbench__button"
              :disabled="!descriptor.openLink"
              :data-testid="`use-staging-source-${descriptor.id}`"
              @click="useStagingAsSource(descriptor.id)"
            >
              作为 Dry-run 来源
            </button>
            <button
              type="button"
              class="integration-workbench__button"
              :disabled="!descriptor.openLink"
              :data-testid="`use-multitable-target-${descriptor.id}`"
              @click="useStagingAsTarget(descriptor.id)"
            >
              作为目标多维表
            </button>
          </div>
          <small v-if="descriptor.openLink" class="integration-workbench__staging-note">
            使用此 /multitable 链接进入真正的多维表工具栏，再点击 + New Record 验证必填字段 toast。
          </small>
          <small v-else class="integration-workbench__staging-note integration-workbench__staging-note--warning">
            不要手写 /grid 或 /spreadsheets/{{ descriptor.id }}；先生成后端返回的 /multitable sheet/view 打开链接。
          </small>
        </article>
      </div>
      <div v-else class="integration-workbench__empty integration-workbench__empty--actionable" data-testid="staging-empty">
        <strong>暂未加载 staging 契约。</strong>
        <p>点击「创建清洗表」即可生成 staging 多维表；创建完成后可在 staging 卡片上「作为 Dry-run 来源」。</p>
        <div class="integration-workbench__actions">
          <button type="button" class="integration-workbench__button" data-testid="staging-empty-focus-install" @click="focusStagingInstall">创建清洗表</button>
        </div>
      </div>

      <div class="integration-workbench__grid integration-workbench__grid--compact">
        <label>
          <span>Project ID（高级，可选）</span>
          <input
            :value="stagingProjectId"
            data-testid="staging-project-id"
            placeholder="留空自动使用 tenant:integration-core"
            @input="onStagingProjectIdInput"
            @change="onStagingProjectIdInput"
            @blur="onStagingProjectIdInput"
          />
          <small class="integration-workbench__staging-note" data-testid="staging-project-id-scope-status">
            {{ stagingProjectIdScopeStatus }}
          </small>
        </label>
        <label>
          <span>Base ID（可选）</span>
          <input v-model="stagingBaseId" data-testid="staging-base-id" placeholder="留空使用默认 base" />
        </label>
      </div>
      <div v-if="stagingProjectIdScopeWarning" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="staging-project-id-scope-warning">
        {{ stagingProjectIdScopeWarning }}
        <button type="button" class="integration-workbench__button" data-testid="normalize-staging-project-id" @click="normalizeStagingProjectIdToScope">
          规范化为 integration 作用域
        </button>
      </div>
      <div class="integration-workbench__actions">
        <button type="button" class="integration-workbench__button" data-testid="install-staging" :disabled="installingStaging" @click="installStagingTables">
          {{ installingStaging ? '创建中' : '创建清洗表' }}
        </button>
      </div>
      <pre v-if="stagingInstallResultText" data-testid="staging-install-result">{{ stagingInstallResultText }}</pre>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>清洗映射规则</h2>
          <p>一行就是一条清洗内容：从来源字段取值，经过白名单转换后写入目标字段。默认映射可直接用，也允许新增自定义清洗项。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="add-mapping" @click="addMapping">
          新增自定义清洗项
        </button>
      </div>

      <div class="integration-workbench__mapping-list" data-testid="mapping-rule-list">
        <details v-for="(mapping, index) in mappings" :key="mapping.id" class="integration-workbench__mapping-card" open>
          <summary :data-testid="`mapping-summary-${index}`">
            <span>{{ mappingSummary(mapping, index) }}</span>
            <small>{{ mappingDetail(mapping) }}</small>
          </summary>
          <div class="integration-workbench__mapping-editor">
            <label>
              <span>源字段</span>
              <input v-model="mapping.sourceField" :data-testid="`source-field-${index}`" placeholder="例如 code" />
            </label>
            <label>
              <span>目标字段</span>
              <input v-model="mapping.targetField" :data-testid="`target-field-${index}`" placeholder="例如 FNumber" />
            </label>
            <label>
              <span>转换</span>
              <select v-model="mapping.transformFn" :data-testid="`transform-fn-${index}`">
                <option v-for="option in transformOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <small class="integration-workbench__field-help">只允许 trim、upper、lower、toNumber、dictMap；不允许用户脚本或 raw SQL。</small>
              <textarea
                v-if="mapping.transformFn === 'dictMap'"
                v-model="mapping.dictMapText"
                :data-testid="`dict-map-${index}`"
                placeholder="EA=Pcs&#10;KG=Kg"
              ></textarea>
            </label>
            <div>
              <label class="integration-workbench__mapping-check">
                <input v-model="mapping.required" type="checkbox" :data-testid="`required-${index}`" />
                <span>必填；缺值会进入 dead letter，不中断整批。</span>
              </label>
              <div class="integration-workbench__mapping-rules">
                <input v-model="mapping.minValueText" :data-testid="`validation-min-${index}`" placeholder="最小值 min" />
                <input v-model="mapping.maxValueText" :data-testid="`validation-max-${index}`" placeholder="最大值 max" />
              </div>
            </div>
            <button type="button" class="integration-workbench__icon-button" @click="removeMapping(index)">删除</button>
          </div>
        </details>
      </div>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>运行与推送</h2>
          <p>先保存清洗流程，再做 dry-run；确认无误后才 Save-only 推送到目标系统。默认不会 Submit / Audit。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="save-pipeline" :disabled="savingPipeline || !canSavePipeline" @click="savePipeline">
          {{ savingPipeline ? '保存中' : '保存清洗流程' }}
        </button>
      </div>

      <div class="integration-workbench__grid">
        <label>
          <span>清洗流程名称</span>
          <input v-model="pipelineName" data-testid="pipeline-name" :placeholder="generatedPipelineName" />
          <small class="integration-workbench__field-help" data-testid="pipeline-name-hint">留空自动生成：{{ generatedPipelineName }}；也可以手动改成业务名称。</small>
          <button type="button" class="integration-workbench__inline-action" data-testid="use-generated-pipeline-name" @click="useGeneratedPipelineName">
            使用自动名称
          </button>
        </label>
        <label>
          <span>清洗流程模式</span>
          <select v-model="pipelineMode" data-testid="pipeline-mode">
            <option value="manual">manual</option>
            <option value="incremental">incremental</option>
            <option value="full">full</option>
          </select>
          <small class="integration-workbench__field-help" data-testid="pipeline-mode-help">manual 手工触发；incremental 用水位增量；full 重新扫描来源数据集。</small>
        </label>
        <label>
          <span>幂等字段</span>
          <input v-model="idempotencyFieldsText" data-testid="idempotency-fields" placeholder="code 或 sourceId,revision" />
          <small class="integration-workbench__field-help" data-testid="idempotency-fields-help">用于识别同一业务记录，避免重复写入；物料通常用 code，BOM 可用 parentCode,childCode,sequence。</small>
        </label>
        <label>
          <span>清洗 staging 表</span>
          <select v-model="stagingSheetId" data-testid="staging-sheet">
            <option value="">不绑定 staging 表</option>
            <option v-for="descriptor in stagingDescriptors" :key="descriptor.id" :value="descriptor.id">
              {{ descriptor.name }} · {{ descriptor.id }}
            </option>
          </select>
        </label>
        <label>
          <span>已保存流程 ID</span>
          <input v-model="savedPipelineId" data-testid="pipeline-id" placeholder="保存后自动回填，也可粘贴已有 ID" />
          <small class="integration-workbench__field-help" data-testid="pipeline-id-help">这是后端 pipeline ID。新建时留空，保存成功后自动回填；排障或复跑时可粘贴已有 ID。</small>
        </label>
        <label>
          <span>运行模式</span>
          <select v-model="pipelineRunMode" data-testid="pipeline-run-mode">
            <option value="manual">manual</option>
            <option value="incremental">incremental</option>
            <option value="full">full</option>
          </select>
        </label>
        <label>
          <span>Dry-run 样本数</span>
          <input v-model="pipelineSampleLimit" data-testid="sample-limit" inputmode="numeric" />
        </label>
      </div>

      <div class="integration-workbench__run-explainer" data-testid="run-push-explainer">
        <strong>运行时会发生什么</strong>
        <ul>
          <li>Dry-run 只读取来源数据并生成目标 payload preview，不写 K3 或其他外部系统。</li>
          <li>Save-only 只调用目标系统保存接口；默认不 Submit、不 Audit，也不覆盖来源多维表。</li>
          <li>成功后展示写入数、外部 ID 或单据号；失败会写入 dead letter，可从异常区打开排查。</li>
          <li>导出清洗结果只使用已脱敏 preview，可用于人工复核或交接。</li>
        </ul>
      </div>

      <label class="integration-workbench__inline-check">
        <input v-model="allowSaveOnlyRun" type="checkbox" data-testid="allow-save-only-run" />
        <span>允许本次 Save-only 推送。保持 Submit / Audit 关闭。</span>
      </label>

      <div class="integration-workbench__readiness" data-testid="pipeline-readiness">
        <div>
          <strong>保存清洗流程前置条件</strong>
          <p data-testid="save-readiness-summary">{{ savePipelineBlockedSummary }}</p>
          <strong>运行前置条件</strong>
          <p data-testid="dry-run-readiness-summary">{{ dryRunBlockedSummary }}</p>
        </div>
        <ul>
          <li v-for="item in dryRunReadinessItems" :key="item.id" :data-ready="item.ready ? 'true' : 'false'">
            <span>{{ item.ready ? '已完成' : '待处理' }}</span>
            <strong>{{ item.label }}</strong>
            <small>{{ item.detail }}</small>
          </li>
        </ul>
      </div>

      <div class="integration-workbench__actions">
        <button type="button" class="integration-workbench__button" data-testid="run-dry-run" :disabled="runningPipeline !== '' || !canRunPipeline" @click="executePipeline(true)">
          {{ runningPipeline === 'dry-run' ? 'Dry-run 中' : 'Dry-run' }}
        </button>
        <button type="button" class="integration-workbench__button integration-workbench__button--danger" data-testid="run-save-only" :disabled="runningPipeline !== '' || !allowSaveOnlyRun || !canRunPipeline" @click="executePipeline(false)">
          {{ runningPipeline === 'run' ? '推送中' : 'Save-only 推送' }}
        </button>
      </div>
      <div v-if="dryRunEmptyPreviewNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="dry-run-empty-preview-notice">
        {{ dryRunEmptyPreviewNotice }}
      </div>

      <div class="integration-workbench__table-action" data-testid="table-action-panel">
        <div class="integration-workbench__panel-head">
          <div>
            <h3>参数化表动作</h3>
            <p>面向已由管理员配置的安全动作。浏览器只填写 allowlist 参数；来源、目标表和写入计划由服务端决定。</p>
          </div>
          <span class="integration-workbench__badge" data-testid="table-action-permission-note">dry-run=read · apply=write/admin</span>
        </div>
        <div v-if="tableActions.length === 0" class="integration-workbench__empty" data-testid="table-action-empty">
          当前部署没有暴露表动作。
        </div>
        <template v-else>
          <div class="integration-workbench__grid integration-workbench__grid--compact">
            <label>
              <span>动作</span>
              <select v-model="selectedTableActionId" data-testid="table-action-id">
                <option v-for="action in tableActions" :key="action.actionId" :value="action.actionId">
                  {{ action.label }} · {{ action.configured ? '已配置' : '未配置' }}
                </option>
              </select>
            </label>
            <label>
              <span>项目号 projectNo</span>
              <input v-model="tableActionProjectNo" data-testid="table-action-project-no" placeholder="例如 P2026-001" />
            </label>
          </div>
          <p class="integration-workbench__hint" data-testid="table-action-boundary">
            不提供 raw SQL、source/object、sheetId、C3 plan 或 C4 payload 输入；apply 会用 dry-run token 触发服务端重新计算。
          </p>
          <div class="integration-workbench__actions">
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="table-action-dry-run"
              :disabled="!tableActionCanDryRun"
              @click="dryRunTableAction"
            >
              {{ runningTableAction === 'dry-run' ? 'Dry-run 中' : 'Dry-run 表动作' }}
            </button>
            <button
              type="button"
              class="integration-workbench__button integration-workbench__button--danger"
              data-testid="table-action-apply"
              :disabled="!tableActionCanApply"
              @click="applyTableAction"
            >
              {{ runningTableAction === 'apply' ? 'Apply 中' : 'Apply 到备料表' }}
            </button>
          </div>
          <div v-if="tableActionDryRunResult" class="integration-workbench__table-action-review" data-testid="table-action-review">
            <strong>{{ tableActionReviewSummary }}</strong>
            <div class="integration-workbench__metric-row">
              <span>add {{ tableActionCounts.add || 0 }}</span>
              <span>update {{ tableActionCounts.update || 0 }}</span>
              <span>skip {{ tableActionCounts.skip || 0 }}</span>
              <span>inactive {{ tableActionCounts.inactive || 0 }}</span>
              <span>manual {{ tableActionCounts.manual_confirm || 0 }}</span>
            </div>
            <div v-if="tableActionLargeBomBounded" class="integration-workbench__bounded-preview" data-testid="table-action-large-bom-bounded">
              <div>
                <strong>大 BOM 有界预览</strong>
                <span class="integration-workbench__badge" data-status="error">Apply blocked</span>
              </div>
              <p>本次只展开了有界子集，冲突/重复计数不是完整计划；不会签发 dry-run token。</p>
              <div class="integration-workbench__metric-row">
                <span v-for="metric in tableActionBoundedPreviewMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
              </div>
              <p v-if="tableActionBoundedErrorTypes.length" class="integration-workbench__hint">
                errorTypes: {{ tableActionBoundedErrorTypes.join(', ') }}
              </p>
            </div>
            <div v-if="tableActionDuplicateDiagnostics" class="integration-workbench__bounded-preview" data-testid="table-action-duplicate-diagnostics">
              <div>
                <strong>重复行分组待处理</strong>
                <span class="integration-workbench__badge" data-status="warning">manual_confirm</span>
              </div>
              <p>重复行不会被自动挑选、合并或写入；下方仅展示 values-free 分组诊断，策略应用仍需后续显式确认。</p>
              <div class="integration-workbench__metric-row">
                <span v-for="metric in tableActionDuplicateMetrics" :key="metric.id">{{ metric.label }} {{ metric.value }}</span>
              </div>
              <p v-if="tableActionDuplicatePolicies.length" class="integration-workbench__hint">
                policies: {{ tableActionDuplicatePolicies.join(', ') }}
              </p>
              <p class="integration-workbench__hint" data-testid="table-action-duplicate-policy-scope">
                本表已保存策略 {{ tableActionStoredConflictPolicyCount }} 条；未选择时默认 hold。任何策略选择都不会自动写入重复行。
              </p>
              <ul v-if="tableActionDuplicateGroups.length" class="integration-workbench__mini-list">
                <li v-for="group in tableActionDuplicateGroups" :key="group.fingerprint">
                  <div>
                    #{{ group.ordinal }} {{ group.fingerprint }} · rows {{ group.rowCount }} · {{ group.parentShape }} · quantity {{ group.quantityShape }} · attrs {{ group.attributeShape }} · stable {{ group.stableDiscriminator }}
                  </div>
                  <div class="integration-workbench__connection-row">
                    <label class="integration-workbench__inline-field">
                      <span>策略</span>
                      <select
                        :value="group.draftPolicy"
                        data-testid="table-action-duplicate-policy-select"
                        @change="onDuplicatePolicyDraftChange(group.fingerprint, $event)"
                      >
                        <option v-for="policy in tableActionDuplicatePolicies" :key="policy" :value="policy">
                          {{ policy }}
                        </option>
                      </select>
                    </label>
                    <span class="integration-workbench__hint">当前 {{ group.currentPolicy }} · {{ group.currentScope }} · 仍 held</span>
                    <button
                      type="button"
                      class="integration-workbench__button"
                      data-testid="table-action-duplicate-run-only"
                      @click="setDuplicateRunOnlyPolicy(group)"
                    >
                      只此次有效
                    </button>
                    <button
                      v-if="auth.hasPermission('integration:admin')"
                      type="button"
                      class="integration-workbench__button"
                      data-testid="table-action-duplicate-table-save"
                      :disabled="tableActionConflictPolicySaving === group.fingerprint"
                      @click="saveDuplicateTableScopePolicy(group)"
                    >
                      保存为本表策略
                    </button>
                    <button
                      v-if="auth.hasPermission('integration:admin')"
                      type="button"
                      class="integration-workbench__button"
                      data-testid="table-action-duplicate-table-revoke"
                      :disabled="tableActionConflictPolicySaving === group.fingerprint"
                      @click="revokeDuplicateTableScopePolicy(group)"
                    >
                      撤销本表策略
                    </button>
                  </div>
                </li>
              </ul>
            </div>
            <p class="integration-workbench__hint" data-testid="table-action-token-state">
              {{ tableActionDryRunToken ? 'dry-run token 已签发；token 仅保存在当前页面内存，不展示、不复制到 evidence。' : '本次 dry-run 不可 apply；请处理失败项后重跑。' }}
            </p>
            <label v-if="tableActionManualConfirmCount > 0" class="integration-workbench__inline-check">
              <input v-model="tableActionAcceptManualConfirmHold" type="checkbox" data-testid="table-action-accept-manual-hold" />
              <span>确认 manual_confirm 行保持不写，只应用 clean add/update/inactive 决策。</span>
            </label>
          </div>
          <div v-if="tableActionApplyResult" class="integration-workbench__table-action-review" data-testid="table-action-apply-result">
            <strong>apply {{ tableActionApplyResult.status }}</strong>
            <p class="integration-workbench__hint">已消费 dry-run token；如需再次 apply，必须重新 dry-run。</p>
          </div>
          <pre v-if="tableActionEvidenceText" data-testid="table-action-evidence">{{ tableActionEvidenceText }}</pre>
          <p class="integration-workbench__hint">Issue / 客户证据只粘贴 values-free summary counts、status、error code；不要粘贴 PLM 行、备料表值或 payload。</p>
        </template>
      </div>

      <div v-if="auth.hasPermission('integration:admin')" class="integration-workbench__table-action" data-testid="stock-option-sync-panel">
        <div class="integration-workbench__panel-head">
          <div>
            <h3>备料选项同步</h3>
            <p>管理员同步 select/dropdown 选项，并可把选项绑定到后端白名单里的预定义动作。</p>
          </div>
          <span class="integration-workbench__badge">admin · metadata-only</span>
        </div>
        <label>
          <span>optionSets JSON</span>
          <textarea
            v-model="stockPreparationOptionSyncText"
            data-testid="stock-option-sync-json"
            rows="8"
            :placeholder="stockPreparationOptionSyncPlaceholder"
          />
        </label>
        <p class="integration-workbench__hint" data-testid="stock-option-sync-boundary">
          这里只写字段选项和 optionActionBindings 元数据；不执行动作，不接受 SQL/JS/URL/function body，不写 PLM/K3/业务行。
        </p>
        <div class="integration-workbench__actions">
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="stock-option-sync-run"
            :disabled="!stockPreparationOptionSyncCanRun"
            @click="syncStockPreparationOptions"
          >
            {{ syncingStockPreparationOptions ? '同步中' : '同步备料选项' }}
          </button>
        </div>
        <pre v-if="stockPreparationOptionSyncEvidenceText" data-testid="stock-option-sync-evidence">{{ stockPreparationOptionSyncEvidenceText }}</pre>
      </div>

      <div class="integration-workbench__export">
        <div>
          <strong>导出清洗结果</strong>
          <p data-testid="cleansed-export-summary">{{ cleansedExportSummary }}</p>
        </div>
        <label>
          <span>导出格式</span>
          <select v-model="cleansedExportFormat" data-testid="cleansed-export-format">
            <option value="csv">CSV</option>
            <option value="xlsx">Excel (.xlsx)</option>
          </select>
        </label>
        <button
          type="button"
          class="integration-workbench__button"
          data-testid="export-cleansed-result"
          :disabled="!canExportCleansedResult"
          @click="exportCleansedResult"
        >
          导出
        </button>
      </div>

      <div class="integration-workbench__hint" data-testid="data-service-placeholder">
        发布 API 数据服务暂不开放。本阶段先用多维表清洗、dry-run、CSV / Excel 导出或 Save-only 推送完成闭环。
      </div>

      <pre data-testid="pipeline-result">{{ pipelineResultText }}</pre>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>运行监控</h2>
          <p>{{ observationSummary }}。展示最近 5 条 run（状态 / 写入 / 失败 + 行级结果）与 open dead letters（可重放），便于清洗后回看失败原因。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="refresh-observation" :disabled="observingPipeline" @click="refreshPipelineObservation(false)">
          {{ observingPipeline ? '刷新中' : '刷新监控' }}
        </button>
      </div>

      <div class="integration-workbench__observation">
        <div>
          <h3>最近运行</h3>
          <div v-if="pipelineRuns.length === 0" class="integration-workbench__empty">暂无运行记录。</div>
          <ol v-else class="integration-workbench__record-list" data-testid="pipeline-runs">
            <li v-for="run in pipelineRuns" :key="run.id" :data-testid="`pipeline-run-${run.id}`">
              <div class="integration-workbench__run-head">
                <strong :class="`integration-workbench__run-status integration-workbench__run-status--${run.status}`" :data-testid="`run-status-${run.id}`">{{ run.status }}</strong>
                <span>{{ run.mode }}</span>
                <span v-if="run.triggeredBy">by {{ run.triggeredBy }}</span>
              </div>
              <div class="integration-workbench__run-metrics">
                <span>read {{ run.rowsRead }}</span>
                <span>clean {{ run.rowsCleaned }}</span>
                <span class="integration-workbench__run-metric--write">write {{ run.rowsWritten }}</span>
                <span class="integration-workbench__run-metric--fail">fail {{ run.rowsFailed }}</span>
                <span v-if="run.durationMs != null">{{ run.durationMs }}ms</span>
              </div>
              <small>{{ run.startedAt || run.createdAt || run.id }}<template v-if="run.finishedAt"> → {{ run.finishedAt }}</template></small>
              <p v-if="run.errorSummary" class="integration-workbench__run-error" :data-testid="`run-error-${run.id}`">{{ run.errorSummary }}</p>
              <div v-if="runRowSummaries(run).length > 0" class="integration-workbench__run-summaries">
                <button type="button" class="integration-workbench__link-button" :data-testid="`toggle-run-summaries-${run.id}`" @click="toggleRunSummaries(run.id)">
                  {{ isRunExpanded(run.id) ? '收起行级结果' : `展开行级结果（${runRowSummaries(run).length}）` }}
                </button>
                <pre v-if="isRunExpanded(run.id)" :data-testid="`run-row-summaries-${run.id}`">{{ JSON.stringify(runRowSummaries(run), null, 2) }}</pre>
              </div>
            </li>
          </ol>
        </div>
        <div>
          <h3>Open Dead Letters</h3>
          <div v-if="deadLetters.length === 0" class="integration-workbench__empty">暂无 open dead letters。</div>
          <ol v-else class="integration-workbench__record-list" data-testid="dead-letters">
            <li v-for="deadLetter in deadLetters" :key="deadLetter.id" :data-testid="`dead-letter-${deadLetter.id}`">
              <strong>{{ deadLetter.errorCode }}</strong>
              <span>{{ deadLetter.errorMessage }}</span>
              <small>
                {{ deadLetter.status }} · {{ deadLetter.createdAt || deadLetter.id }}<template v-if="deadLetter.retryCount"> · retries {{ deadLetter.retryCount }}</template><template v-if="deadLetter.idempotencyKey"> · key {{ deadLetter.idempotencyKey }}</template>
              </small>
              <div class="integration-workbench__dead-letter-actions">
                <span
                  :class="['integration-workbench__badge', isDeadLetterReplayable(deadLetter) ? 'integration-workbench__badge--retryable' : '']"
                  :data-testid="`dead-letter-retryable-${deadLetter.id}`"
                >{{ isDeadLetterReplayable(deadLetter) ? '可重放' : '不可重放' }}</span>
                <template v-if="isDeadLetterReplayable(deadLetter)">
                  <button
                    v-if="confirmReplayDeadLetterId !== deadLetter.id"
                    type="button"
                    class="integration-workbench__button integration-workbench__button--ghost"
                    :data-testid="`replay-dead-letter-${deadLetter.id}`"
                    :disabled="replayingDeadLetterId === deadLetter.id"
                    @click="requestReplay(deadLetter.id)"
                  >准备 Replay</button>
                  <template v-else>
                    <button
                      type="button"
                      class="integration-workbench__button integration-workbench__button--danger"
                      :data-testid="`confirm-replay-dead-letter-${deadLetter.id}`"
                      :disabled="replayingDeadLetterId === deadLetter.id"
                      @click="replayDeadLetter(deadLetter)"
                    >{{ replayingDeadLetterId === deadLetter.id ? 'Replay 中…' : '确认 Replay（会真实写入）' }}</button>
                    <button
                      type="button"
                      class="integration-workbench__link-button"
                      :data-testid="`cancel-replay-dead-letter-${deadLetter.id}`"
                      :disabled="replayingDeadLetterId === deadLetter.id"
                      @click="cancelReplay"
                    >取消</button>
                  </template>
                </template>
              </div>
              <div class="integration-workbench__dead-letter-provenance">
                <button
                  type="button"
                  class="integration-workbench__link-button"
                  :data-testid="`toggle-dead-letter-provenance-${deadLetter.id}`"
                  :disabled="!canViewRowProvenance(deadLetter)"
                  :title="canViewRowProvenance(deadLetter) ? '查看该行(rowId)跨 run 的写入血缘（只读）' : '该 dead letter 无 idempotency key（rowId），无法查询血缘'"
                  @click="toggleDeadLetterProvenance(deadLetter)"
                >{{ isRowProvenanceExpanded(deadLetter.id) ? '收起血缘' : '查看跨-run 血缘' }}</button>
                <span
                  v-if="!canViewRowProvenance(deadLetter)"
                  class="integration-workbench__hint"
                  :data-testid="`dead-letter-provenance-unavailable-${deadLetter.id}`"
                >无 rowId（idempotency key），不可查血缘</span>
                <div
                  v-if="isRowProvenanceExpanded(deadLetter.id)"
                  class="integration-workbench__provenance-timeline"
                  :data-testid="`dead-letter-provenance-${deadLetter.id}`"
                >
                  <div
                    v-if="isRowProvenanceLoading(deadLetter.id)"
                    class="integration-workbench__hint"
                    :data-testid="`dead-letter-provenance-loading-${deadLetter.id}`"
                  >血缘加载中…</div>
                  <div
                    v-else-if="rowProvenanceError(deadLetter.id)"
                    class="integration-workbench__hint integration-workbench__hint--strong"
                    :data-testid="`dead-letter-provenance-error-${deadLetter.id}`"
                  >{{ rowProvenanceError(deadLetter.id) }}</div>
                  <ol
                    v-else-if="rowProvenanceTimeline(deadLetter.id).length > 0"
                    class="integration-workbench__record-list"
                    :data-testid="`dead-letter-provenance-timeline-${deadLetter.id}`"
                  >
                    <li
                      v-for="(entry, index) in rowProvenanceTimeline(deadLetter.id)"
                      :key="`${entry.runId}-${entry.eventIndex}`"
                      :data-testid="`provenance-entry-${deadLetter.id}-${index}`"
                    >
                      <div class="integration-workbench__provenance-event-head">
                        <strong>{{ entry.eventType }}</strong>
                        <span
                          class="integration-workbench__run-status"
                          :class="`integration-workbench__run-status--${entry.runStatus}`"
                        >run {{ entry.runStatus }}</span>
                        <span>{{ entry.runCreatedAt || entry.at }}</span>
                      </div>
                      <small>runId {{ entry.runId }} · pipeline {{ entry.pipelineId }} · {{ entry.runMode }}</small>
                      <p
                        v-if="rowProvenanceAttrsSummary(entry.attrs)"
                        class="integration-workbench__provenance-attrs"
                      >{{ rowProvenanceAttrsSummary(entry.attrs) }}</p>
                    </li>
                  </ol>
                  <div
                    v-else
                    class="integration-workbench__empty"
                    :data-testid="`dead-letter-provenance-empty-${deadLetter.id}`"
                  >暂无血缘事件。</div>
                  <p class="integration-workbench__hint">只读：仅展示脱敏后的事件，不含 payload 原文，不触发任何写入/重放。</p>
                </div>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <section class="integration-workbench__panel integration-workbench__preview">
      <div>
        <h2>样例记录</h2>
        <textarea v-model="sampleRecordText" data-testid="sample-record" spellcheck="false"></textarea>
        <h2>目标模板 JSON</h2>
        <textarea
          v-model="payloadTemplateText"
          data-testid="payload-template"
          spellcheck="false"
          placeholder='{ "FNumber": "&lt;code&gt;", "FName": "&lt;name&gt;" }'
        ></textarea>
        <small class="integration-workbench__hint">可选。填写后使用 DF-T1 no-write payloadTemplate 预览；留空则保持 legacy preview。</small>
        <h2>引用映射来源(各 domain 绑定 staging 表)</h2>
        <div v-if="referenceMappingDomains.length > 0" data-testid="reference-mapping-picker">
          <div
            v-for="domain in referenceMappingDomains"
            :key="domain"
            class="integration-workbench__ref-mapping-row"
            :data-testid="`ref-mapping-row-${domain}`"
          >
            <code>{{ domain }}</code>
            <select
              :data-testid="`ref-mapping-system-${domain}`"
              :value="referenceMappingBindings[domain]?.systemId || ''"
              @change="onRefMappingSystemChange(domain, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">— staging 系统 —</option>
              <option v-for="system in stagingSystems" :key="system.id" :value="system.id">{{ system.name }}</option>
            </select>
            <input
              :data-testid="`ref-mapping-object-${domain}`"
              :value="referenceMappingBindings[domain]?.object || ''"
              placeholder="对象/表名"
              @input="onRefMappingObjectChange(domain, ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
        <small class="integration-workbench__hint">将 reference 字段授权为「从映射表解析」并选 domain 后,这里按 domain 绑定其 staging 映射表(系统按名称选,对象填表名);预览会实时 bulk-read 解析。sourceCode 列在上方字段规则里填。</small>
        <button
          type="button"
          class="integration-workbench__button"
          data-testid="derive-template-draft"
          :disabled="derivingDraft"
          @click="deriveTemplateDraft"
        >{{ derivingDraft ? '派生中…' : '从模板派生字段规则草案' }}</button>
        <p v-if="deriveError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="derive-error">{{ deriveError }}</p>
        <MetaIntegrationFieldRuleAuthoring
          v-if="authoredFieldRules.length > 0"
          v-model="authoredFieldRules"
          :gated-fields="authoredGatedFields"
        />
      </div>
      <div>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>Payload 预览</h2>
            <p>预览只做纯计算，不写数据库，也不会调用 ERP/CRM/PLM/SRM。</p>
          </div>
          <button type="button" class="integration-workbench__button" data-testid="preview-payload" @click="previewPayload">
            生成 JSON 预览
          </button>
        </div>
        <pre data-testid="payload-preview">{{ previewText }}</pre>
        <div
          v-if="previewProvenance"
          class="integration-workbench__provenance"
          data-testid="preview-provenance"
        >
          <h3 class="integration-workbench__provenance-title">字段来源</h3>
          <p class="integration-workbench__provenance-stats" data-testid="preview-provenance-stats">
            <span
              v-for="stat in previewProvenance.stats"
              :key="stat.source"
              class="integration-workbench__provenance-badge"
              :data-source="stat.source"
            >{{ provenanceSourceLabel(stat.source) }}: {{ stat.count }}</span>
          </p>
          <ul class="integration-workbench__provenance-list">
            <li v-for="entry in previewProvenance.entries" :key="entry.field" :data-field="entry.field">
              <code>{{ entry.field }}</code>
              <span class="integration-workbench__provenance-badge" :data-source="entry.source">{{ provenanceSourceLabel(entry.source) }}</span>
            </li>
          </ul>
          <p class="integration-workbench__hint">仅显示字段名与来源，不含字段值。</p>
        </div>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useAuth } from '../composables/useAuth'
import { buildXlsxBuffer } from '../multitable/import/xlsx-mapping'
import { listDataSources } from '../data-sources/api'
import type { DataSourceListItem } from '../data-sources/types'
import {
  canReadFromSystem,
  canWriteToSystem,
  applyIntegrationTableAction,
  deleteIntegrationTableActionConflictPolicies,
  deleteWorkbenchExternalSystem,
  dryRunIntegrationTableAction,
  getDefaultIntegrationScope,
  isIntegrationScopedProjectId,
  normalizeIntegrationProjectId,
  getExternalSystemSchema,
  getPlmDataSourceCapabilities,
  installIntegrationStaging,
  isDeadLetterReplayable,
  listIntegrationDeadLetters,
  listIntegrationPipelineRuns,
  listIntegrationProvenanceByRow,
  listIntegrationStagingDescriptors,
  listIntegrationTableActions,
  listIntegrationTableActionConflictPolicies,
  listExternalSystemObjects,
  listIntegrationAdapters,
  listWorkbenchExternalSystems,
  previewIntegrationTemplate,
  replayIntegrationDeadLetter,
  runIntegrationPipeline,
  deriveFieldRulesFromMappings,
  deriveIntegrationTemplate,
  summarizeFieldProvenance,
  saveIntegrationTableActionConflictPolicies,
  syncIntegrationStockPreparationOptions,
  testExternalSystemConnection,
  upsertWorkbenchExternalSystem,
  upsertIntegrationPipeline,
  type IntegrationAdapterMetadata,
  type IntegrationFieldMapping,
  type IntegrationObjectSchema,
  type IntegrationObjectSchemaField,
  type PlmIntegrationCapabilitiesResult,
  type PlmIntegrationCapabilityFeature,
  type IntegrationDeadLetter,
  type IntegrationPipelineMode,
  type IntegrationPipelineRun,
  type IntegrationPipelineRunResult,
  type IntegrationProvenanceTimelineEntry,
  type IntegrationTargetWriteSummary,
  type IntegrationStagingDescriptor,
  type IntegrationStagingInstallResult,
  type IntegrationStagingOpenTarget,
  type IntegrationSystemObject,
  type IntegrationFieldRule,
  type IntegrationReferenceMappingSource,
  type IntegrationTableActionApplyResult,
  type IntegrationTableActionConflictPolicyResult,
  type IntegrationTableActionDryRunResult,
  type IntegrationTableActionMetadata,
  type IntegrationStockPreparationOptionSyncResult,
  type IntegrationTemplatePreviewRequest,
  type WorkbenchExternalSystem,
} from '../services/integration/workbench'
import MetaIntegrationFieldRuleAuthoring from '../components/integration/MetaIntegrationFieldRuleAuthoring.vue'
import PlmBomReviewPanel from '../components/plm/PlmBomReviewPanel.vue'

type WorkbenchSide = 'source' | 'target'
type TransformFn = '' | 'trim' | 'upper' | 'lower' | 'toNumber' | 'dictMap'
type ExportFormat = 'csv' | 'xlsx'

interface EditableMapping {
  id: string
  sourceField: string
  targetField: string
  transformFn: TransformFn
  dictMapText: string
  required: boolean
  minValueText: string
  maxValueText: string
}

interface StagingDatasetCard {
  id: string
  name: string
  area: string
  description: string
  fieldCount: number
  openLink: string
}

interface StagingObjectConfig {
  name: string
  sheetId: string
  viewId?: string
  baseId?: string | null
  openLink?: string
  fields: string[]
  fieldDetails?: IntegrationStagingDescriptor['fieldDetails']
  keyFields?: string[]
  mode?: 'append' | 'upsert'
}

type ConnectionDraftRole = WorkbenchExternalSystem['role']
type ConnectionDraftStatus = WorkbenchExternalSystem['status']

interface DuplicateExpandedGroupView {
  ordinal: string
  fingerprint: string
  rowCount: string
  parentShape: string
  quantityShape: string
  attributeShape: string
  stableDiscriminator: string
  currentPolicy: string
  currentScope: string
  draftPolicy: string
}

interface ConnectionDraft {
  id: string
  name: string
  kind: string
  role: ConnectionDraftRole
  status: ConnectionDraftStatus
  configText: string
  capabilitiesText: string
  // C2b: structured config for the read-only data-source bridge (kind 'data-source:sql-readonly').
  // The connection only ever references a data_sources id — credentials stay in /data-sources.
  dataSourceId: string
  dataSourceObject: string
}

interface PlmApprovalCapabilityEntry {
  state: 'enabled' | 'upgrade' | 'loading'
  badge: string
  title: string
  detail: string
  apiVersion: string
  actionStatus: string
}

// P3-C: BOM review is a READ surface (no actions), so its capability entry mirrors the
// approval one minus actionStatus.
interface PlmBomCapabilityEntry {
  state: 'enabled' | 'upgrade' | 'loading'
  badge: string
  title: string
  detail: string
  apiVersion: string
}

type ExportCell = string | number | boolean | null
type ExportRow = Record<string, ExportCell>

const flowSteps = [
  { title: '1. 连接系统', description: '接入 CRM / PLM / ERP / SRM / HTTP / SQL' },
  { title: '2. 选择数据集', description: '选择来源对象、清洗表和目标模板' },
  { title: '3. 多维表清洗', description: '业务人员在表格里修正、审核、补字段' },
  { title: '4. Dry-run / 推送', description: '预览 payload 后导出或 Save-only 写回' },
]
const auth = useAuth()

const stagingDatasetCopy: Record<string, { area: string; name: string; description: string }> = {
  plm_raw_items: {
    area: '原始区',
    name: 'PLM 原始数据',
    description: '保留第三方系统读入的原始物料、版本和来源字段，避免清洗过程覆盖原始证据。',
  },
  standard_materials: {
    area: '清洗区',
    name: '物料清洗',
    description: '业务主要在这里补齐物料编码、名称、规格、单位和 ERP 回写状态。',
  },
  bom_cleanse: {
    area: '清洗区',
    name: 'BOM 清洗',
    description: '业务主要在这里修正父子件、数量、单位、序号和版本。',
  },
  integration_exceptions: {
    area: '回写区',
    name: '异常处理',
    description: '缺字段、非法数量、单位映射失败等问题会进入这里处理。',
  },
  integration_run_log: {
    area: '回写区',
    name: '运行日志',
    description: '记录 dry-run、Save-only 推送、外部 ID、单据号和错误摘要。',
  },
}
const recommendedStagingSourceByTarget: Record<string, string> = {
  material: 'standard_materials',
  bom: 'bom_cleanse',
}

const transformOptions: Array<{ value: TransformFn, label: string }> = [
  { value: '', label: '无转换' },
  { value: 'trim', label: 'trim 去空格' },
  { value: 'upper', label: 'upper 转大写' },
  { value: 'lower', label: 'lower 转小写' },
  { value: 'toNumber', label: 'toNumber 转数字' },
  { value: 'dictMap', label: 'dictMap 字典映射' },
]

const defaultScope = getDefaultIntegrationScope()
const scope = reactive({
  tenantId: defaultScope.tenantId,
  workspaceId: defaultScope.workspaceId,
})
const workspaceInput = computed({
  get: () => scope.workspaceId || '',
  set: (value: string) => {
    scope.workspaceId = value.trim() || null
  },
})

const adapters = ref<IntegrationAdapterMetadata[]>([])
const systems = ref<WorkbenchExternalSystem[]>([])
const showAdvancedConnectors = ref(false)
const inventoryExpanded = ref(false)
const sourceSystemId = ref('')
const targetSystemId = ref('')
const sourceObjects = ref<IntegrationSystemObject[]>([])
const targetObjects = ref<IntegrationSystemObject[]>([])
const stagingDescriptors = ref<IntegrationStagingDescriptor[]>([])
const sourceObjectName = ref('')
const targetObjectName = ref('')
const stagingSheetId = ref('')
const sourceSchema = ref<IntegrationObjectSchema>({ object: '', fields: [] })
const targetSchema = ref<IntegrationObjectSchema>({ object: '', fields: [] })
const mappings = ref<EditableMapping[]>([])
const previewText = ref('尚未生成预览')
// DF-T1.5: read-only provenance summary derived from a DF-T1 targetPayloadPreview (null = nothing to show).
const previewProvenance = ref<ReturnType<typeof summarizeFieldProvenance>>(null)
const pipelineResultText = ref('尚未执行')
const lastDryRunResult = ref<IntegrationPipelineRunResult | null>(null)
const tableActions = ref<IntegrationTableActionMetadata[]>([])
const selectedTableActionId = ref('')
const tableActionProjectNo = ref('')
const runningTableAction = ref<'dry-run' | 'apply' | ''>('')
const tableActionDryRunResult = ref<IntegrationTableActionDryRunResult | null>(null)
const tableActionApplyResult = ref<IntegrationTableActionApplyResult | null>(null)
const tableActionAcceptManualConfirmHold = ref(false)
const tableActionDuplicatePolicyDrafts = ref<Record<string, string>>({})
const tableActionDuplicateRunPolicies = ref<Record<string, string>>({})
const tableActionTableScopePolicies = ref<IntegrationTableActionConflictPolicyResult | null>(null)
const tableActionConflictPolicySaving = ref('')
const tableActionConflictPolicyDirty = ref(false)
const stockPreparationOptionSyncText = ref('')
const stockPreparationOptionSyncResult = ref<IntegrationStockPreparationOptionSyncResult | null>(null)
const syncingStockPreparationOptions = ref(false)
const pipelineRuns = ref<IntegrationPipelineRun[]>([])
const deadLetters = ref<IntegrationDeadLetter[]>([])
const expandedRunIds = ref<Set<string>>(new Set())
// DF-N2-3 (read-only): per-dead-letter cross-run provenance timeline, fetched lazily
// on expand by the row's idempotency key (rowId). No write/replay affordance here.
const expandedDeadLetterProvenanceIds = ref<Set<string>>(new Set())
const rowProvenanceByDeadLetterId = ref<Map<string, IntegrationProvenanceTimelineEntry[]>>(new Map())
const rowProvenanceLoadingIds = ref<Set<string>>(new Set())
const rowProvenanceErrorById = ref<Map<string, string>>(new Map())
const confirmReplayDeadLetterId = ref('')
const replayingDeadLetterId = ref('')
const statusMessage = ref('')
const statusKind = ref<'idle' | 'success' | 'error'>('idle')
const pipelineName = ref('')
const pipelineMode = ref<IntegrationPipelineMode>('manual')
const pipelineRunMode = ref<IntegrationPipelineMode>('manual')
const idempotencyFieldsText = ref('code')
const pipelineSampleLimit = ref('20')
const savedPipelineId = ref('')
const savingPipeline = ref(false)
const stagingProjectId = ref('')
const stagingBaseId = ref('')
const stagingOpenTargets = ref<IntegrationStagingOpenTarget[]>([])
const stagingInstallResultText = ref('')
const installingStaging = ref(false)
const runningPipeline = ref<'dry-run' | 'run' | ''>('')
const observingPipeline = ref(false)
const allowSaveOnlyRun = ref(false)
const cleansedExportFormat = ref<ExportFormat>('csv')
const sampleRecordText = ref(JSON.stringify({
  code: ' mat-001 ',
  name: ' Bolt ',
  uom: 'EA',
  quantity: '2',
}, null, 2))
// DF-T1.5 reachability wire: optional payloadTemplate JSON. When filled, previewPayload sends the
// DF-T1 no-write preview shape so the backend returns targetPayloadPreview (provenance); empty = legacy.
const payloadTemplateText = ref('')
// DF-T3b dual-binding picker: per-domain staging-table binding (sheet half of from_reference_table
// resolution). Keyed by domain (the distinct from_reference_table domains the operator authored above).
const referenceMappingBindings = ref<Record<string, { systemId: string; object: string }>>({})
// DF-T2c: the authored fieldRules draft (from the read-only derive route, then edited via the
// authoring UI) + the gated fields it returns. previewPayload sends these (not a re-derive) when set.
const authoredFieldRules = ref<IntegrationFieldRule[]>([])
const authoredGatedFields = ref<string[]>([])
const derivingDraft = ref(false)
const deriveError = ref('')
const connectionDraft = reactive<ConnectionDraft>({
  id: '',
  name: '',
  kind: '',
  role: 'source',
  status: 'active',
  configText: '{}',
  capabilitiesText: '{}',
  dataSourceId: '',
  dataSourceObject: '',
})
const connectionDraftMode = ref<'new' | 'edit' | 'copy'>('new')
const savingConnectionDraft = ref(false)
const deletingConnectionId = ref('')

// C2b — read-only data-source bridge connection (kind 'data-source:sql-readonly'): a structured
// picker that references an existing /data-sources connection by id (never copies credentials).
const DATA_SOURCE_BRIDGE_KIND = 'data-source:sql-readonly'
const PLM_APPROVAL_AUTOMATION_FEATURE_KEY = 'approval_automation'
const PLM_BOM_MULTITABLE_FEATURE_KEY = 'bom_multitable'
const bridgeDataSources = ref<DataSourceListItem[]>([])
const bridgeDataSourcesError = ref('')
const bridgeDataSourcesLoaded = ref(false)
const plmCapabilitiesBySystemId = ref<Record<string, PlmIntegrationCapabilitiesResult>>({})
const plmCapabilitiesLoadingSystemIds = ref<Set<string>>(new Set())
const isDataSourceBridgeKind = computed(() => connectionDraft.kind === DATA_SOURCE_BRIDGE_KIND)

async function loadBridgeDataSources(): Promise<void> {
  if (bridgeDataSourcesLoaded.value) return
  try {
    bridgeDataSources.value = await listDataSources()
    bridgeDataSourcesLoaded.value = true
  } catch (error) {
    bridgeDataSourcesError.value = error instanceof Error ? error.message : String(error)
  }
}

// Lazy: only fetch the data-source list when the operator actually picks the bridge kind.
watch(() => connectionDraft.kind, (kind) => {
  if (kind === DATA_SOURCE_BRIDGE_KIND) void loadBridgeDataSources()
})

function buildDataSourceBridgeConfig(): Record<string, unknown> {
  const object = connectionDraft.dataSourceObject.trim()
  // Only the data_sources reference + object — NO credentials are ever entered for this kind.
  return {
    dataSourceId: connectionDraft.dataSourceId.trim(),
    ...(object ? { object } : {}),
  }
}

function bridgeConfigString(config: unknown, key: string): string {
  const value = config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : ''
}

function bridgeDataSourceIdForSystem(system: WorkbenchExternalSystem | null): string {
  if (!system || system.kind !== DATA_SOURCE_BRIDGE_KIND) return ''
  return bridgeConfigString(system.config, 'dataSourceId').trim()
}

function prunePlmCapabilities(systemList: WorkbenchExternalSystem[]): void {
  const ids = new Set(systemList.map((system) => system.id))
  plmCapabilitiesBySystemId.value = Object.fromEntries(
    Object.entries(plmCapabilitiesBySystemId.value).filter(([systemId]) => ids.has(systemId)),
  )
}

function setPlmCapabilitiesLoading(systemId: string, loading: boolean): void {
  const next = new Set(plmCapabilitiesLoadingSystemIds.value)
  if (loading) {
    next.add(systemId)
  } else {
    next.delete(systemId)
  }
  plmCapabilitiesLoadingSystemIds.value = next
}

async function refreshPlmCapabilitiesForSystem(system: WorkbenchExternalSystem | null): Promise<void> {
  const dataSourceId = bridgeDataSourceIdForSystem(system)
  if (!system || !dataSourceId) return
  const cached = plmCapabilitiesBySystemId.value[system.id]
  if (cached?.data_source_id === dataSourceId || plmCapabilitiesLoadingSystemIds.value.has(system.id)) return
  setPlmCapabilitiesLoading(system.id, true)
  try {
    const result = await getPlmDataSourceCapabilities(dataSourceId)
    plmCapabilitiesBySystemId.value = {
      ...plmCapabilitiesBySystemId.value,
      [system.id]: result,
    }
  } catch {
    plmCapabilitiesBySystemId.value = {
      ...plmCapabilitiesBySystemId.value,
      [system.id]: { data_source_id: dataSourceId, available: false, reason: 'unavailable' },
    }
  } finally {
    setPlmCapabilitiesLoading(system.id, false)
  }
}

const adapterMetadataByKind = computed(() => new Map(adapters.value.map((adapter) => [adapter.kind, adapter])))
const inventorySummary = computed(() => `已配置连接 ${systems.value.length} 个（可编辑 / 复制 / 停用 / 删除） · ${adapters.value.length} 个适配器 · ${stagingDescriptors.value.length} 个 staging 表`)
const visibleAdapters = computed(() => adapters.value.filter((adapter) => showAdvancedConnectors.value || !adapter.advanced))
const connectionDraftAdapterOptions = computed(() => {
  const options = [...visibleAdapters.value]
  if (connectionDraft.kind && !options.some((adapter) => adapter.kind === connectionDraft.kind)) {
    const selectedHiddenAdapter = adapterMetadataByKind.value.get(connectionDraft.kind)
    if (selectedHiddenAdapter) options.push(selectedHiddenAdapter)
  }
  return options
})
const hiddenAdvancedSystemCount = computed(() => systems.value.filter((system) => isAdvancedSystem(system)).length)
const visibleSystems = computed(() => systems.value.filter((system) => showAdvancedConnectors.value || !isAdvancedSystem(system)))
const sourceSystems = computed(() => visibleSystems.value.filter((system) => canUseSystemForSide(system, 'source')))
const targetSystems = computed(() => visibleSystems.value.filter((system) => canUseSystemForSide(system, 'target')))
// DF-T3b dual-binding picker: only metasheet:staging systems may back a mapping sheet (matches the
// route's P1 staging-kind guard); the picker shows their NAMES so the operator never types a systemId.
const stagingSystems = computed(() => systems.value.filter((system) => system.kind === 'metasheet:staging'))
// the distinct from_reference_table domains the operator authored — the picker binds exactly these
// (a binding for a domain no longer authored is dropped at send time).
const referenceMappingDomains = computed(() => {
  const seen = new Set<string>()
  for (const rule of authoredFieldRules.value) {
    if (rule.sourceType === 'from_reference_table' && typeof rule.domain === 'string' && rule.domain) seen.add(rule.domain)
  }
  return [...seen]
})
const runnableSourceSystems = computed(() => sourceSystems.value.filter((system) => !isSourceOptionDisabled(system)))
const hasRunnableSourceSystem = computed(() => runnableSourceSystems.value.length > 0)
const selectedTargetObject = computed(() => targetObjects.value.find((object) => object.name === targetObjectName.value) || null)
const selectedSourceSystem = computed(() => systems.value.find((system) => system.id === sourceSystemId.value) || null)
const selectedTargetSystem = computed(() => systems.value.find((system) => system.id === targetSystemId.value) || null)
const selectedStagingDescriptor = computed(() => stagingDescriptors.value.find((descriptor) => descriptor.id === stagingSheetId.value) || null)
const selectedSourcePlmDataSourceId = computed(() => bridgeDataSourceIdForSystem(selectedSourceSystem.value))
const selectedSourcePlmCapabilities = computed(() => (
  selectedSourceSystem.value ? plmCapabilitiesBySystemId.value[selectedSourceSystem.value.id] || null : null
))
const selectedSourcePlmCapabilitiesLoading = computed(() => (
  Boolean(selectedSourceSystem.value && plmCapabilitiesLoadingSystemIds.value.has(selectedSourceSystem.value.id))
))
const sourceConnectionStatus = computed(() => selectedSourceSystem.value?.status || 'inactive')
const targetConnectionStatus = computed(() => selectedTargetSystem.value?.status || 'inactive')
const sourceConnectionLabel = computed(() => connectionStatusLabel(selectedSourceSystem.value))
const targetConnectionLabel = computed(() => connectionStatusLabel(selectedTargetSystem.value))
const sourceRuntimeBlocker = computed(() => runtimeBlockerForSystem(selectedSourceSystem.value))
const k3WebApiReadGateNotice = computed(() => {
  const targetOnlyK3WebApi = visibleSystems.value.some((system) => system.kind === 'erp:k3-wise-webapi' && canWriteToSystem(system) && !canReadFromSystem(system))
  if (!targetOnlyK3WebApi) return ''
  return '当前 K3 WISE WebAPI 仅作为目标写入连接；来源侧请使用 staging 多维表、SQL 只读通道或其他可读连接。K3 WebAPI read/list runtime 仍等待客户 GATE 样例。'
})
const sourceSelectorExplanation = computed(() => {
  if (k3WebApiReadGateNotice.value) {
    return '这里显示已保存且具备读取能力的连接，不是全部 adapter。当前 K3 WISE WebAPI 仅作为目标写入连接；读取 K3 可用 SQL 只读通道、staging 多维表或其他可读连接。'
  }
  return '这里显示已保存且具备读取能力的连接，不是全部 adapter。若只看到目标系统，请先创建 staging 来源或启用可读连接。'
})
const targetSelectorExplanation = computed(() => {
  if (targetSystems.value.length === 1 && targetSystems.value[0]?.kind === 'erp:k3-wise-webapi') {
    return '当前只有 K3 WISE WebAPI 目标连接可写入。创建清洗表后，也可把 MetaSheet 多维表设为目标输出；真实推送仍按 Save-only 显式确认。'
  }
  return '这里显示已保存且具备写入能力的连接。Save-only 推送仍需显式勾选，不会自动 Submit / Audit。'
})
const selectedApprovalAutomationFeature = computed<PlmIntegrationCapabilityFeature | null>(() => {
  const result = selectedSourcePlmCapabilities.value
  if (!result?.available) return null
  const feature = result.manifest.features[PLM_APPROVAL_AUTOMATION_FEATURE_KEY]
  return feature && typeof feature === 'object' ? feature : null
})
const selectedPlmApprovalCapabilityEntry = computed<PlmApprovalCapabilityEntry | null>(() => {
  if (!selectedSourcePlmDataSourceId.value) return null
  if (selectedSourcePlmCapabilitiesLoading.value && !selectedSourcePlmCapabilities.value) {
    return {
      state: 'loading',
      badge: '检测中',
      title: '正在读取 PLM 能力',
      detail: '能力清单只用于界面降级提示，不作为授权来源。',
      apiVersion: '',
      actionStatus: '',
    }
  }
  const feature = selectedApprovalAutomationFeature.value
  if (feature?.supported !== true) return null
  const apiVersion = typeof feature.api_version === 'string' && feature.api_version.trim() ? feature.api_version.trim() : 'v1'
  const actionStatus = typeof feature.action_status === 'string' && feature.action_status.trim() ? feature.action_status.trim() : ''
  if (feature.entitled === true) {
    return {
      state: 'enabled',
      badge: '可用',
      title: 'ECO 审批自动化',
      detail: actionStatus === 'stubbed'
        ? '已开通；notify 当前仍是占位动作，不代表真实钉钉派发。'
        : '已开通；可按 PLM 能力清单显示审批自动化入口。',
      apiVersion,
      actionStatus,
    }
  }
  return {
    state: 'upgrade',
    badge: '可升级',
    title: '升级审批自动化',
    detail: '当前租户尚未开通 approval_automation；前端只显示升级入口，真实授权仍由 PLM license 判定。',
    apiVersion,
    actionStatus,
  }
})
const selectedBomMultitableFeature = computed<PlmIntegrationCapabilityFeature | null>(() => {
  const result = selectedSourcePlmCapabilities.value
  if (!result?.available) return null
  const feature = result.manifest.features[PLM_BOM_MULTITABLE_FEATURE_KEY]
  return feature && typeof feature === 'object' ? feature : null
})
const selectedPlmBomMultitableCapabilityEntry = computed<PlmBomCapabilityEntry | null>(() => {
  if (!selectedSourcePlmDataSourceId.value) return null
  if (selectedSourcePlmCapabilitiesLoading.value && !selectedSourcePlmCapabilities.value) {
    return { state: 'loading', badge: '检测中', title: '正在读取 PLM 能力', detail: '能力清单只用于界面降级提示，不作为授权来源。', apiVersion: '' }
  }
  const feature = selectedBomMultitableFeature.value
  // not supported (old PLM / unlit) -> hide the entry entirely (graceful degradation)
  if (feature?.supported !== true) return null
  const apiVersion = typeof feature.api_version === 'string' && feature.api_version.trim() ? feature.api_version.trim() : 'v1'
  if (feature.entitled === true) {
    return {
      state: 'enabled',
      badge: '可用',
      title: 'BOM 多维表 Review',
      detail: '已开通；可加载某个 Part 的只读 BOM review 表（受治理快照，不可写回）。',
      apiVersion,
    }
  }
  return {
    state: 'upgrade',
    badge: '可升级',
    title: '升级 BOM Review',
    detail: '当前租户尚未开通 bom_multitable；前端只显示升级入口，真实授权仍由 PLM license 判定。',
    apiVersion,
  }
})
const sqlChannelDisabledHint = computed(() => {
  const hasDisabledSql = systems.value.some((system) => system.kind === 'erp:k3-wise-sqlserver' && runtimeBlockerForSystem(system) !== '')
  return hasDisabledSql ? '高级 SQL 通道未启用 / SQLSERVER_EXECUTOR_MISSING / 需要部署侧注入 queryExecutor。已有 SQL 连接配置会保留但暂不能作为 Dry-run 来源。' : ''
})
const connectionDraftTitle = computed(() => {
  if (connectionDraftMode.value === 'edit') return `编辑连接${connectionDraft.id ? `：${connectionDraft.id}` : ''}`
  if (connectionDraftMode.value === 'copy') return '复制为新连接'
  return '新增 / 编辑连接草稿'
})
const connectionDraftAdapter = computed(() => adapterMetadataByKind.value.get(connectionDraft.kind) || null)
const connectionDraftDuplicateWarning = computed(() => {
  const name = connectionDraft.name.trim()
  const duplicatesByName = systems.value.filter((system) => system.id !== connectionDraft.id && name && system.name.trim().toLowerCase() === name.toLowerCase())
  if (duplicatesByName.length > 0) {
    return `已有同名连接：${duplicatesByName.map((system) => system.id).join('、')}。请改名，避免业务人员选错来源/目标。`
  }
  const duplicatesByKindRole = systems.value.filter((system) => (
    system.id !== connectionDraft.id
    && connectionDraft.kind
    && system.kind === connectionDraft.kind
    && system.role === connectionDraft.role
  ))
  if (duplicatesByKindRole.length > 0) {
    return `已有同类型同角色连接：${duplicatesByKindRole.map((system) => system.name).join('、')}。如果是同一物理系统，请在名称中标明协议、数据集或用途。`
  }
  return ''
})
const connectionDraftRoleWarning = computed(() => {
  if (!connectionDraft.kind || !connectionDraftAdapter.value) return ''
  if (connectionDraft.role === 'source' && !adapterSupportsSide(connectionDraft.kind, 'source')) {
    return `${connectionDraftAdapter.value.label} 当前 adapter metadata 不支持 source/read；不会出现在数据源下拉框。`
  }
  if (connectionDraft.role === 'target' && !adapterSupportsSide(connectionDraft.kind, 'target')) {
    return `${connectionDraftAdapter.value.label} 当前 adapter metadata 不支持 target/upsert；不会出现在目标下拉框。`
  }
  if (connectionDraft.role === 'bidirectional' && (!adapterSupportsSide(connectionDraft.kind, 'source') || !adapterSupportsSide(connectionDraft.kind, 'target'))) {
    return `${connectionDraftAdapter.value.label} 当前不是完整双向 adapter；请拆成 source / target 两条逻辑连接。`
  }
  return ''
})
const connectionDraftJsonError = computed(() => {
  try {
    const config = parseConnectionDraftJson(connectionDraft.configText, 'config JSON')
    const capabilities = parseConnectionDraftJson(connectionDraft.capabilitiesText, 'capabilities JSON')
    if (hasUnsafeConnectionDraftSecret(config) || hasUnsafeConnectionDraftSecret(capabilities)) {
      return '连接草稿不能包含 password、token、secret、api_key、authorization 或 URL query secret；凭证请留在系统预设向导 / 后端凭证库。'
    }
    if (connectionDraft.configText.includes('<redacted>') || connectionDraft.capabilitiesText.includes('<redacted>')) {
      return '草稿包含 <redacted> 占位，不能直接保存覆盖原连接；请回系统预设向导重新填写凭证或清理该字段。'
    }
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
})
const canSaveConnectionDraft = computed(() => {
  // The bridge kind requires BOTH a picked data source AND an object (table/view) — without the
  // object the source is not readable (v1 has no schema dropdown, so the text input is load-bearing).
  if (isDataSourceBridgeKind.value && (!connectionDraft.dataSourceId.trim() || !connectionDraft.dataSourceObject.trim())) return false
  return Boolean(
    connectionDraft.name.trim()
    && connectionDraft.kind
    && !connectionDraftRoleWarning.value
    && (isDataSourceBridgeKind.value || !connectionDraftJsonError.value),
  )
})
const sourceDatasetTitle = computed(() => selectedObjectLabel('source') || '请选择来源数据集')
const targetDatasetTitle = computed(() => selectedObjectLabel('target') || '请选择目标数据集')
const sourceDatasetDescription = computed(() => selectedSourceSystem.value
  ? `${selectedSourceSystem.value.name} · ${sourceObjectName.value || '尚未加载对象'}`
  : '先选择一个可读取的数据源系统。')
const targetDatasetDescription = computed(() => selectedTargetSystem.value
  ? `${selectedTargetSystem.value.name} · ${targetObjectName.value || '尚未加载模板'}`
  : '先选择一个可写入的目标系统。')
const requiredTargetFieldCount = computed(() => targetSchema.value.fields.filter((field) => field.required === true).length)
const stagingOpenTargetById = computed(() => new Map(stagingOpenTargets.value.map((target) => [target.id, target])))
const stagingDatasetCards = computed<StagingDatasetCard[]>(() => stagingDescriptors.value.map((descriptor) => {
  const copy = stagingDatasetCopy[descriptor.id] || {
    area: '数据集',
    name: descriptor.name,
    description: '该 staging 多维表可作为清洗、观察或回写数据集。',
  }
  return {
    id: descriptor.id,
    name: copy.name || descriptor.name,
    area: copy.area,
    description: copy.description,
    fieldCount: Array.isArray(descriptor.fields) ? descriptor.fields.length : 0,
    openLink: stagingOpenTargetById.value.get(descriptor.id)?.openLink || '',
  }
}))
const observationSummary = computed(() => `${pipelineRuns.value.length} runs / ${deadLetters.value.length} open dead letters`)
const cleansedExportRows = computed(() => buildCleansedExportRows(lastDryRunResult.value))
const canExportCleansedResult = computed(() => cleansedExportRows.value.length > 0)
const dryRunEmptyPreviewNotice = computed(() => {
  if (!lastDryRunResult.value || !isDryRunEmptyPreview(lastDryRunResult.value)) return ''
  return 'Dry-run 成功，但本次没有可处理记录。可能是来源数据集为空或过滤条件过严。'
})
const cleansedExportSummary = computed(() => {
  if (cleansedExportRows.value.length === 0 && dryRunEmptyPreviewNotice.value) return 'Dry-run 成功但没有可导出记录；可能是来源数据集为空或过滤条件过严。'
  if (cleansedExportRows.value.length === 0) return '先运行 dry-run。导出只使用 dry-run preview，不会触发外部系统写入。'
  return `可导出 ${cleansedExportRows.value.length} 条 dry-run 清洗记录；内容来自已脱敏 preview。`
})
const sameSystemNotice = computed(() => {
  if (!sourceSystemId.value || sourceSystemId.value !== targetSystemId.value) return ''
  if (selectedSourceSystem.value?.role === 'bidirectional') {
    return 'same system, different business object：同一个双向连接可以作为来源和目标，但请选择不同业务对象避免误解为 loopback sync。'
  }
  return '同一连接同时作为来源和目标只支持 role=bidirectional 的外部系统。'
})
const protocolSplitNotice = computed(() => {
  const source = selectedSourceSystem.value
  const target = selectedTargetSystem.value
  if (!source || !target) return ''
  if (isK3WiseSystem(source) && isK3WiseSystem(target) && source.kind !== target.kind) {
    return '同一物理 K3 WISE 使用不同协议时，建议配置两条逻辑连接：SQL read channel 作为来源，WebAPI Save channel 作为目标。'
  }
  if (showAdvancedConnectors.value) {
    return '如果同一物理系统需要不同协议，请使用两条逻辑连接区分读取和写入职责。'
  }
  return ''
})
const recommendedStagingSourceObject = computed(() => {
  const recommended = recommendedStagingSourceByTarget[targetObjectName.value]
  if (!recommended) return ''
  if (!stagingDescriptors.value.some((descriptor) => descriptor.id === recommended)) return ''
  return recommended
})
const stagingTargetMismatchNotice = computed(() => {
  if (selectedSourceSystem.value?.kind !== 'metasheet:staging') return ''
  const recommended = recommendedStagingSourceObject.value
  if (!recommended || !sourceObjectName.value || sourceObjectName.value === recommended) return ''
  const sourceLabel = stagingDatasetCopy[sourceObjectName.value]?.name || sourceObjectName.value
  const recommendedLabel = stagingDatasetCopy[recommended]?.name || recommended
  const targetLabel = selectedTargetObject.value?.label || targetObjectName.value
  return `当前目标模板「${targetLabel}」建议使用「${recommendedLabel}」作为来源；你选择的是「${sourceLabel}」，dry-run 可能成功但返回 0 条可处理记录。`
})
const hasMappingRules = computed(() => mappings.value.some((mapping) => mapping.sourceField.trim() && mapping.targetField.trim()))
const hasIdempotencyFields = computed(() => parseList(idempotencyFieldsText.value).length > 0)
const generatedPipelineName = computed(() => defaultPipelineName())
const savePipelineReadinessItems = computed(() => [
  {
    id: 'source-system',
    label: '选择数据源系统',
    ready: Boolean(sourceSystemId.value),
    detail: sourceSystemId.value ? '数据源系统已选择。' : '请选择已有数据源，或先创建 staging 多维表作为来源。',
  },
  {
    id: 'source-object',
    label: '选择来源数据集',
    ready: Boolean(sourceObjectName.value),
    detail: sourceObjectName.value || '加载来源对象后才能保存 pipeline。',
  },
  {
    id: 'target-system',
    label: '选择目标系统',
    ready: Boolean(targetSystemId.value),
    detail: targetSystemId.value ? '目标系统已选择。' : '请选择 K3 WebAPI、多维表或其他可写目标。',
  },
  {
    id: 'target-object',
    label: '选择目标数据集 / 模板',
    ready: Boolean(targetObjectName.value),
    detail: targetObjectName.value || '加载目标模板后才能生成 payload 或保存 pipeline。',
  },
  {
    id: 'source-target-pairing',
    label: '确认来源与目标匹配',
    ready: !stagingTargetMismatchNotice.value,
    detail: stagingTargetMismatchNotice.value || '来源数据集与目标模板匹配。',
  },
  {
    id: 'mapping',
    label: '配置清洗映射规则',
    ready: hasMappingRules.value,
    detail: hasMappingRules.value ? '至少一条 source -> target 映射已配置。' : '请先加载目标 schema 或手工新增映射。',
  },
  {
    id: 'idempotency',
    label: '填写幂等字段',
    ready: hasIdempotencyFields.value,
    detail: hasIdempotencyFields.value ? '幂等字段已填写。' : '例如 code 或 sourceId,revision。',
  },
])
const canSavePipeline = computed(() => savePipelineReadinessItems.value.every((item) => item.ready))
const savePipelineBlockedSummary = computed(() => {
  const missing = savePipelineReadinessItems.value.filter((item) => !item.ready)
  if (missing.length === 0) return '已满足保存条件。保存只写入 pipeline 配置，不调用外部系统。'
  return `还缺 ${missing.length} 项：${missing.map((item) => item.label).join('、')}`
})
const dryRunReadinessItems = computed(() => [
  {
    id: 'source-system',
    label: '选择可读取的数据源',
    ready: Boolean(sourceSystemId.value && selectedSourceSystem.value?.status === 'active' && !sourceRuntimeBlocker.value),
    detail: sourceRuntimeBlocker.value
      || (selectedSourceSystem.value && selectedSourceSystem.value.status !== 'active'
        ? connectionStatusLabel(selectedSourceSystem.value)
        : (sourceSystemId.value ? '数据源已选择且状态可用' : '还没有选择数据源；也可以先使用 K3 预设配置目标，再补来源。')),
  },
  {
    id: 'source-object',
    label: '选择来源数据集',
    ready: Boolean(sourceObjectName.value),
    detail: sourceObjectName.value || '加载来源对象后才能保存 pipeline。',
  },
  {
    id: 'target-system',
    label: '选择目标系统',
    ready: Boolean(targetSystemId.value && selectedTargetSystem.value?.status === 'active'),
    detail: selectedTargetSystem.value && selectedTargetSystem.value.status !== 'active'
      ? connectionStatusLabel(selectedTargetSystem.value)
      : (targetSystemId.value ? '目标系统已选择且状态可用' : '请选择 K3 WebAPI 或其他可写目标。'),
  },
  {
    id: 'target-object',
    label: '选择目标数据集 / 模板',
    ready: Boolean(targetObjectName.value),
    detail: targetObjectName.value || '加载目标模板后才能生成 payload 或保存 pipeline。',
  },
  {
    id: 'source-target-pairing',
    label: '确认来源与目标匹配',
    ready: !stagingTargetMismatchNotice.value,
    detail: stagingTargetMismatchNotice.value || '来源数据集与目标模板匹配。',
  },
  {
    id: 'mapping',
    label: '配置清洗映射规则',
    ready: hasMappingRules.value,
    detail: hasMappingRules.value ? '至少一条 source -> target 映射已配置。' : '请先加载目标 schema 或手工新增映射。',
  },
  {
    id: 'idempotency',
    label: '填写幂等字段',
    ready: hasIdempotencyFields.value,
    detail: hasIdempotencyFields.value ? '幂等字段已填写。' : '例如 code 或 sourceId,revision。',
  },
  {
    id: 'pipeline-id',
    label: '保存 Pipeline',
    ready: Boolean(savedPipelineId.value.trim()),
    detail: savedPipelineId.value.trim() || 'Payload 预览通过不等于 pipeline dry-run；请先保存 pipeline。',
  },
])
// The dry-run / save-only run buttons drive executePipeline(), which only needs a saved (or pasted)
// pipeline ID — the pipeline already holds target/mapping/idempotency server-side. So the run gate is
// decoupled from the full BUILD checklist (dryRunReadinessItems, kept as authoring guidance): an operator
// re-running an existing pipeline by pasting its ID must not be blocked by an unfilled builder. See #2232.
const canRunPipeline = computed(() => savedPipelineId.value.trim() !== '')
const dryRunBlockedSummary = computed(() => {
  const missing = dryRunReadinessItems.value.filter((item) => !item.ready)
  if (missing.length === 0) return '已满足 dry-run 前置条件。Dry-run 只生成 preview，不写外部系统。'
  return `还缺 ${missing.length} 项：${missing.map((item) => item.label).join('、')}`
})
const configuredTableActions = computed(() => tableActions.value.filter((action) => action.configured === true))
const selectedTableAction = computed(() => tableActions.value.find((action) => action.actionId === selectedTableActionId.value) || configuredTableActions.value[0] || tableActions.value[0] || null)
const tableActionCounts = computed(() => tableActionDryRunResult.value?.counts || {})
const tableActionManualConfirmCount = computed(() => Number(tableActionCounts.value.manual_confirm || 0))
const tableActionDryRunToken = computed(() => tableActionDryRunResult.value?.dryRunToken || '')
const tableActionLargeBomBounded = computed(() => isLargeBomBoundedTableActionResult(tableActionDryRunResult.value))
const tableActionBoundedPreview = computed(() => {
  const result = tableActionDryRunResult.value
  if (!result) return null
  if (isRecord(result.boundedPreview)) return result.boundedPreview
  const evidence = isRecord(result.evidence) ? result.evidence : null
  const expansion = evidence && isRecord(evidence.expansion) ? evidence.expansion : null
  return expansion && isRecord(expansion.boundedPreview) ? expansion.boundedPreview : null
})
const tableActionBoundedErrorTypes = computed(() => {
  const preview = tableActionBoundedPreview.value
  if (Array.isArray(preview?.errorTypes)) return preview.errorTypes.filter((entry): entry is string => typeof entry === 'string')
  const evidence = isRecord(tableActionDryRunResult.value?.evidence) ? tableActionDryRunResult.value?.evidence : null
  const expansion = evidence && isRecord(evidence.expansion) ? evidence.expansion : null
  return Array.isArray(expansion?.errorTypes) ? expansion.errorTypes.filter((entry): entry is string => typeof entry === 'string') : []
})
const tableActionBoundedPreviewMetrics = computed(() => {
  const preview = tableActionBoundedPreview.value
  if (!preview) return []
  return [
    { id: 'rows-expanded', label: 'rows', value: numberMetric(preview.rowsExpanded) },
    { id: 'read-count', label: 'reads', value: numberMetric(preview.readCount) },
    { id: 'max-rows', label: 'maxRows', value: numberMetric(preview.maxRows) },
    { id: 'max-pages', label: 'maxPages', value: numberMetric(preview.maxPages) },
    { id: 'max-read-count', label: 'maxReadCount', value: numberMetric(preview.maxReadCount) },
    { id: 'max-elapsed-ms', label: 'maxElapsedMs', value: numberMetric(preview.maxElapsedMs) },
  ].filter((metric) => metric.value !== '')
})
const tableActionPlanEvidence = computed(() => {
  const evidence = isRecord(tableActionDryRunResult.value?.evidence) ? tableActionDryRunResult.value?.evidence : null
  return evidence && isRecord(evidence.plan) ? evidence.plan : null
})
const tableActionDuplicateDiagnostics = computed(() => {
  const diagnostics = tableActionPlanEvidence.value && isRecord(tableActionPlanEvidence.value.duplicateExpandedKeyDiagnostics)
    ? tableActionPlanEvidence.value.duplicateExpandedKeyDiagnostics
    : null
  if (!diagnostics || diagnostics.conflictType !== 'duplicate_expanded_key') return null
  return diagnostics
})
const tableActionDuplicateMetrics = computed(() => {
  const diagnostics = tableActionDuplicateDiagnostics.value
  if (!diagnostics) return []
  const parentCounts = isRecord(diagnostics.parentShapeCounts) ? diagnostics.parentShapeCounts : {}
  const quantityCounts = isRecord(diagnostics.quantityShapeCounts) ? diagnostics.quantityShapeCounts : {}
  const stableCounts = isRecord(diagnostics.stableDiscriminatorCounts) ? diagnostics.stableDiscriminatorCounts : {}
  return [
    { id: 'groups', label: 'groups', value: numberMetric(diagnostics.groupCount) },
    { id: 'rows', label: 'rows', value: numberMetric(diagnostics.rowCount) },
    { id: 'same-parent', label: 'sameParent', value: numberMetric(parentCounts.same_parent) },
    { id: 'cross-parent', label: 'crossParent', value: numberMetric(parentCounts.cross_parent) },
    { id: 'quantity-varied', label: 'quantityVaried', value: numberMetric(quantityCounts.varied) },
    { id: 'stable', label: 'stableDiscriminator', value: numberMetric(stableCounts.any) },
  ].filter((metric) => metric.value !== '')
})
const tableActionDuplicatePolicies = computed(() => {
  const diagnostics = tableActionDuplicateDiagnostics.value
  return Array.isArray(diagnostics?.allowedPolicies)
    ? diagnostics.allowedPolicies.filter((policy): policy is string => typeof policy === 'string')
    : []
})
const tableActionConflictPolicyReview = computed(() => {
  const review = tableActionPlanEvidence.value && isRecord(tableActionPlanEvidence.value.conflictPolicyReview)
    ? tableActionPlanEvidence.value.conflictPolicyReview
    : null
  return review && review.conflictType === 'duplicate_expanded_key' ? review : null
})
const tableActionConflictPolicySelections = computed(() => {
  const review = tableActionConflictPolicyReview.value
  const rows = Array.isArray(review?.selectedPolicies) ? review.selectedPolicies.filter(isRecord) : []
  const out = new Map<string, { policy: string, scope: string }>()
  for (const row of rows) {
    if (typeof row.fingerprint !== 'string' || typeof row.policy !== 'string') continue
    out.set(row.fingerprint, {
      policy: row.policy,
      scope: typeof row.scope === 'string' ? row.scope : 'default',
    })
  }
  return out
})
const tableActionStoredConflictPolicyCount = computed(() => Number(tableActionTableScopePolicies.value?.policyCount || 0))
const tableActionDuplicateGroups = computed<DuplicateExpandedGroupView[]>(() => {
  const diagnostics = tableActionDuplicateDiagnostics.value
  const groups = Array.isArray(diagnostics?.groups) ? diagnostics.groups.filter(isRecord) : []
  return groups.slice(0, 8).map((group, index) => {
    const stable = isRecord(group.stableDiscriminators) ? group.stableDiscriminators : {}
    const stableLabels = [
      stable.sourceDetail === true ? 'sourceDetail' : '',
      stable.pathParent === true ? 'pathParent' : '',
      stable.sortLine === true ? 'sortLine' : '',
    ].filter(Boolean)
    return {
      ordinal: numberMetric(group.ordinal) || String(index + 1),
      fingerprint: typeof group.fingerprint === 'string' ? group.fingerprint : `group-${index + 1}`,
      rowCount: numberMetric(group.rowCount) || '0',
      parentShape: typeof group.parentShape === 'string' ? group.parentShape : 'unknown',
      quantityShape: typeof group.quantityShape === 'string' ? group.quantityShape : 'unknown',
      attributeShape: typeof group.attributeShape === 'string' ? group.attributeShape : 'unknown',
      stableDiscriminator: stableLabels.length ? stableLabels.join('+') : 'none',
      currentPolicy: tableActionConflictPolicySelections.value.get(typeof group.fingerprint === 'string' ? group.fingerprint : '')?.policy || 'hold',
      currentScope: tableActionConflictPolicySelections.value.get(typeof group.fingerprint === 'string' ? group.fingerprint : '')?.scope || 'default',
      draftPolicy: tableActionDuplicatePolicyDrafts.value[typeof group.fingerprint === 'string' ? group.fingerprint : ''] || tableActionConflictPolicySelections.value.get(typeof group.fingerprint === 'string' ? group.fingerprint : '')?.policy || 'hold',
    }
  })
})
const tableActionEvidenceText = computed(() => {
  const evidence = tableActionApplyResult.value?.evidence || tableActionDryRunResult.value?.evidence
  return evidence ? JSON.stringify(evidence, null, 2) : ''
})
const stockPreparationOptionSyncPlaceholder = JSON.stringify({
  optionSets: {
    material_type: [
      { value: 'plate', label: 'Plate' },
    ],
    blank_type: [
      { value: 'casting', label: 'Casting' },
    ],
    stock_preparation_status: [
      {
        value: 'pending',
        label: 'Pending',
        actionBindings: [{ actionId: 'plm.stock-preparation.pull-bom.v1' }],
      },
    ],
  },
}, null, 2)
const stockPreparationOptionSyncEvidenceText = computed(() => {
  const evidence = stockPreparationOptionSyncResult.value?.evidence
  return evidence ? JSON.stringify(evidence, null, 2) : ''
})
const stockPreparationOptionSyncCanRun = computed(() => Boolean(
  auth.hasPermission('integration:admin')
  && stockPreparationOptionSyncText.value.trim()
  && syncingStockPreparationOptions.value === false,
))
const tableActionCanDryRun = computed(() => Boolean(
  selectedTableAction.value?.configured
  && tableActionProjectNo.value.trim()
  && runningTableAction.value === '',
))
const tableActionCanApply = computed(() => Boolean(
  selectedTableAction.value?.configured
  && tableActionProjectNo.value.trim()
  && tableActionDryRunResult.value?.canApply === true
  && tableActionDryRunToken.value
  && auth.hasPermission('integration:write')
  && runningTableAction.value === ''
  && tableActionConflictPolicyDirty.value === false
  && Object.keys(tableActionDuplicateRunPolicies.value).length === 0
  && (tableActionManualConfirmCount.value === 0 || tableActionAcceptManualConfirmHold.value),
))
const tableActionReviewSummary = computed(() => {
  if (!selectedTableAction.value) return '当前部署没有可用表动作。'
  if (!selectedTableAction.value.configured) return '该动作尚未由管理员配置源/目标绑定，不能运行。'
  if (!tableActionDryRunResult.value) return '输入项目号后先 dry-run；apply 必须使用本次 dry-run token，并由服务端重新计算计划。'
  const status = tableActionDryRunResult.value.status || 'unknown'
  const counts = tableActionCounts.value
  if (tableActionLargeBomBounded.value) {
    const rows = numberMetric(tableActionBoundedPreview.value?.rowsExpanded) || '0'
    const reads = numberMetric(tableActionBoundedPreview.value?.readCount) || '0'
    return `dry-run ${status} · bounded rows ${rows} / reads ${reads} · Apply blocked`
  }
  return `dry-run ${status} · add ${counts.add || 0} / update ${counts.update || 0} / skip ${counts.skip || 0} / inactive ${counts.inactive || 0} / manual ${counts.manual_confirm || 0}`
})

function setStatus(message: string, kind: 'success' | 'error' | 'idle' = 'idle'): void {
  statusMessage.value = message
  statusKind.value = kind
}

function currentScope() {
  return {
    tenantId: scope.tenantId.trim() || 'default',
    workspaceId: scope.workspaceId || null,
  }
}

function isAdvancedSystem(system: WorkbenchExternalSystem): boolean {
  return adapterMetadataByKind.value.get(system.kind)?.advanced === true
}

function adapterSupportsSide(kind: string, side: WorkbenchSide): boolean {
  const metadata = adapterMetadataByKind.value.get(kind)
  if (!metadata) return true
  const roles = new Set(metadata.roles)
  if (!roles.has(side) && !roles.has('bidirectional')) return false
  const supports = new Set(metadata.supports || [])
  if (side === 'source') {
    return supports.size === 0 || supports.has('read') || supports.has('listObjects') || supports.has('getSchema')
  }
  return supports.size === 0 || supports.has('upsert') || supports.has('write') || supports.has('create') || supports.has('update')
}

function canUseSystemForSide(system: WorkbenchExternalSystem, side: WorkbenchSide): boolean {
  if (side === 'source') return canReadFromSystem(system) && adapterSupportsSide(system.kind, 'source')
  return canWriteToSystem(system) && adapterSupportsSide(system.kind, 'target')
}

function runtimeBlockerForSystem(system: WorkbenchExternalSystem | null): string {
  if (!system) return ''
  const errorText = system.lastError || ''
  if (system.kind === 'erp:k3-wise-sqlserver' && /SQLSERVER_EXECUTOR_MISSING|queryExecutor|executor|injected|注入|执行器/i.test(errorText)) {
    return 'SQL 连接已配置，但当前部署未注入 SQL 执行器（SQLSERVER_EXECUTOR_MISSING）；可保留为高级连接，暂不能作为可读 source 执行 dry-run。'
  }
  if (system.kind === 'erp:k3-wise-sqlserver' && system.status === 'error' && !errorText) {
    return 'K3 SQL Server 只读通道需要部署 allowlist queryExecutor 后才能读取样本或作为 source。'
  }
  return ''
}

function isK3WiseSystem(system: WorkbenchExternalSystem): boolean {
  return system.kind.startsWith('erp:k3-wise')
}

function showConnectionGuide(): void {
  inventoryExpanded.value = true
  setStatus('已打开连接草稿区：优先使用 K3 WISE 预设；PLM/HTTP/SQL 连接向导会在后续版本补齐。', 'idle')
}

function showSqlSetup(): void {
  showAdvancedConnectors.value = true
  inventoryExpanded.value = true
  setStatus('已显示 SQL / 高级连接。SQL source 需要部署 allowlist queryExecutor 后才能读取。', 'idle')
}

function isSourceOptionDisabled(system: WorkbenchExternalSystem): boolean {
  return runtimeBlockerForSystem(system) !== ''
}

function focusStagingInstall(): void {
  if (typeof document === 'undefined') return
  const input = document.querySelector('[data-testid="staging-project-id"]')
  if (input && 'focus' in (input as HTMLElement)) {
    try { (input as HTMLElement).focus() } catch { /* jsdom may not support focus */ }
  }
  const installButton = document.querySelector('[data-testid="install-staging"]')
  if (installButton && 'scrollIntoView' in (installButton as HTMLElement)) {
    try { (installButton as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch { /* jsdom: no-op */ }
  }
}

function showStagingSetup(): void {
  inventoryExpanded.value = true
  setStatus('创建 staging 多维表后即可在 staging 卡片上「作为 Dry-run 来源」。Project ID 留空时后端会自动使用插件专用作用域。', 'idle')
  focusStagingInstall()
}

function stringifyConnectionDraftJson(value: unknown): string {
  return JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2)
}

function resetConnectionDraft(): void {
  connectionDraft.id = ''
  connectionDraft.name = ''
  connectionDraft.kind = adapters.value.find((adapter) => !adapter.advanced)?.kind || ''
  connectionDraft.role = 'source'
  connectionDraft.status = 'active'
  connectionDraft.configText = '{}'
  connectionDraft.capabilitiesText = '{}'
  connectionDraft.dataSourceId = ''
  connectionDraft.dataSourceObject = ''
  connectionDraftMode.value = 'new'
}

function editConnection(system: WorkbenchExternalSystem): void {
  connectionDraft.id = system.id
  connectionDraft.name = system.name
  connectionDraft.kind = system.kind
  connectionDraft.role = system.role
  connectionDraft.status = system.status
  connectionDraft.configText = stringifyConnectionDraftJson(system.config)
  connectionDraft.capabilitiesText = stringifyConnectionDraftJson(system.capabilities)
  connectionDraft.dataSourceId = bridgeConfigString(system.config, 'dataSourceId')
  connectionDraft.dataSourceObject = bridgeConfigString(system.config, 'object')
  connectionDraftMode.value = 'edit'
  inventoryExpanded.value = true
  setStatus(`已载入连接草稿：${system.name}`, 'idle')
}

function copyConnection(system: WorkbenchExternalSystem): void {
  connectionDraft.id = ''
  connectionDraft.name = `${system.name} copy`
  connectionDraft.kind = system.kind
  connectionDraft.role = system.role
  connectionDraft.status = 'inactive'
  connectionDraft.configText = stringifyConnectionDraftJson(system.config)
  connectionDraft.capabilitiesText = stringifyConnectionDraftJson(system.capabilities)
  connectionDraft.dataSourceId = bridgeConfigString(system.config, 'dataSourceId')
  connectionDraft.dataSourceObject = bridgeConfigString(system.config, 'object')
  connectionDraftMode.value = 'copy'
  inventoryExpanded.value = true
  setStatus(`已复制 ${system.name} 为新连接草稿；保存前请改名并确认用途。`, 'idle')
}

async function deactivateConnection(system: WorkbenchExternalSystem): Promise<void> {
  try {
    const updated = await upsertWorkbenchExternalSystem({
      ...currentScope(),
      id: system.id,
      name: system.name,
      kind: system.kind,
      role: system.role,
      status: 'inactive',
    })
    replaceSystem(updated)
    normalizeSystemSelections()
    setStatus(`连接已停用：${system.name}`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function activateConnection(system: WorkbenchExternalSystem): Promise<void> {
  try {
    const updated = await upsertWorkbenchExternalSystem({
      ...currentScope(),
      id: system.id,
      name: system.name,
      kind: system.kind,
      role: system.role,
      status: 'active',
    })
    replaceSystem(updated)
    normalizeSystemSelections()
    setStatus(`连接已启用：${system.name}`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

function confirmConnectionDelete(system: WorkbenchExternalSystem): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
  return window.confirm(`删除连接「${system.name}」？只有未被 pipeline 引用的连接会被后端删除。`)
}

function clearDeletedSystemState(systemId: string): void {
  systems.value = systems.value.filter((system) => system.id !== systemId)
  if (sourceSystemId.value === systemId) sourceSystemId.value = ''
  if (targetSystemId.value === systemId) targetSystemId.value = ''
  if (connectionDraft.id === systemId) resetConnectionDraft()
  normalizeSystemSelections()
}

async function deleteConnection(system: WorkbenchExternalSystem): Promise<void> {
  if (!confirmConnectionDelete(system)) return
  deletingConnectionId.value = system.id
  try {
    await deleteWorkbenchExternalSystem(system.id, currentScope())
    clearDeletedSystemState(system.id)
    setStatus(`连接已删除：${system.name}`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    deletingConnectionId.value = ''
  }
}

function parseConnectionDraftJson(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const parsed = JSON.parse(trimmed) as unknown
  if (!isRecord(parsed)) throw new Error(`${label} 必须是 JSON object`)
  return parsed
}

const CONNECTION_DRAFT_SECRET_KEY_PATTERN = /(^|[._-])(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|secret|signature|sign|auth|authorization)([._-]|$)/i
const CONNECTION_DRAFT_SECRET_TEXT_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|[?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|secret|signature|sign|auth|password)=[^&#\s]+/i

function hasUnsafeConnectionDraftSecret(value: unknown, keyPath = ''): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    if (value === '<redacted>' || value === '%3Credacted%3E') return false
    if (CONNECTION_DRAFT_SECRET_KEY_PATTERN.test(keyPath) && value.trim()) return true
    return CONNECTION_DRAFT_SECRET_TEXT_PATTERN.test(value)
  }
  if (Array.isArray(value)) {
    return value.some((item, index) => hasUnsafeConnectionDraftSecret(item, `${keyPath}.${index}`))
  }
  if (isRecord(value)) {
    return Object.entries(value).some(([key, child]) => hasUnsafeConnectionDraftSecret(child, keyPath ? `${keyPath}.${key}` : key))
  }
  return false
}

async function saveConnectionDraft(): Promise<void> {
  const error = connectionDraftJsonError.value
  if (error) {
    setStatus(error, 'error')
    return
  }
  if (!canSaveConnectionDraft.value) {
    setStatus('连接草稿还缺名称、adapter 或合法角色。', 'error')
    return
  }
  savingConnectionDraft.value = true
  try {
    const system = await upsertWorkbenchExternalSystem({
      ...currentScope(),
      ...(connectionDraft.id ? { id: connectionDraft.id } : {}),
      name: connectionDraft.name.trim(),
      kind: connectionDraft.kind,
      role: connectionDraft.role,
      status: connectionDraft.status,
      config: isDataSourceBridgeKind.value
        ? buildDataSourceBridgeConfig()
        : parseConnectionDraftJson(connectionDraft.configText, 'config JSON'),
      capabilities: parseConnectionDraftJson(connectionDraft.capabilitiesText, 'capabilities JSON'),
    })
    replaceSystem(system)
    connectionDraft.id = system.id
    connectionDraft.name = system.name
    connectionDraft.kind = system.kind
    connectionDraft.role = system.role
    connectionDraft.status = system.status
    connectionDraftMode.value = 'edit'
    normalizeSystemSelections()
    setStatus(`连接已保存：${system.name}`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    savingConnectionDraft.value = false
  }
}

function selectedObjectLabel(side: WorkbenchSide): string {
  const objectName = side === 'source' ? sourceObjectName.value : targetObjectName.value
  const objects = side === 'source' ? sourceObjects.value : targetObjects.value
  const object = objects.find((item) => item.name === objectName)
  return object?.label || objectName
}

function getStagingAreaLabel(id: string): string {
  return stagingDatasetCopy[id]?.area || '数据集'
}

function stagingSourceSystemId(projectId: string): string {
  const suffix = (projectId || 'default').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'default'
  return `metasheet_staging_${suffix}`
}

function multitableTargetSystemId(projectId: string): string {
  const suffix = (projectId || 'default').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'default'
  return `metasheet_target_${suffix}`
}

function defaultStagingProjectId(): string {
  return `${currentScope().tenantId}:integration-core`
}

function effectiveStagingProjectId(): string {
  return stagingProjectId.value.trim() || defaultStagingProjectId()
}

const stagingProjectIdScopeWarning = computed(() => {
  const value = stagingProjectId.value.trim()
  if (!value || isIntegrationScopedProjectId(value)) return ''
  return `Project ID「${value}」不是 integration 作用域，安装会触发 plugin-scope 警告。留空可自动作用域，或一键规范化为以 :integration-core 结尾。`
})

const stagingProjectIdScopeStatus = computed(() => {
  const value = stagingProjectId.value.trim()
  if (!value) return `当前将使用 ${defaultStagingProjectId()}`
  if (isIntegrationScopedProjectId(value)) return `当前将使用 ${value}`
  return `当前为非 integration 作用域：${value}`
})

function onStagingProjectIdInput(event: Event): void {
  const target = event.target as HTMLInputElement | null
  stagingProjectId.value = target?.value ?? ''
}

function normalizeStagingProjectIdToScope(): void {
  const normalized = normalizeIntegrationProjectId(stagingProjectId.value, currentScope().tenantId)
  stagingProjectId.value = normalized
  setStatus(`Project ID 已规范化为 ${normalized}`, 'idle')
}

function descriptorToSchemaFields(descriptor: IntegrationStagingDescriptor | null): IntegrationObjectSchemaField[] {
  if (!descriptor) return []
  if (Array.isArray(descriptor.fieldDetails) && descriptor.fieldDetails.length > 0) {
    return descriptor.fieldDetails.map((field) => ({
      name: field.id,
      label: field.name,
      type: field.type,
      ...(Array.isArray(field.options) ? { options: field.options } : {}),
    }))
  }
  return descriptor.fields.map((field) => ({
    name: field,
    label: field,
    type: 'string',
  }))
}

function defaultMultitableTargetKeyFields(descriptor: IntegrationStagingDescriptor): string[] {
  const fieldNames = new Set(descriptorToSchemaFields(descriptor).map((field) => field.name))
  if (fieldNames.has('code')) return ['code']
  if (fieldNames.has('parentCode') && fieldNames.has('childCode')) {
    return ['parentCode', 'childCode', ...(fieldNames.has('sequence') ? ['sequence'] : [])]
  }
  if (fieldNames.has('externalId')) return ['externalId']
  if (fieldNames.has('id')) return ['id']
  return []
}

function buildStagingSourceObjectsConfig(): Record<string, StagingObjectConfig> {
  const objects: Record<string, StagingObjectConfig> = {}
  for (const descriptor of stagingDescriptors.value) {
    const target = stagingOpenTargetById.value.get(descriptor.id)
    if (!target?.sheetId) continue
    objects[descriptor.id] = {
      name: stagingDatasetCopy[descriptor.id]?.name || descriptor.name,
      sheetId: target.sheetId,
      viewId: target.viewId,
      baseId: target.baseId || stagingBaseId.value.trim() || null,
      openLink: target.openLink,
      fields: descriptor.fields,
      fieldDetails: descriptor.fieldDetails,
    }
  }
  return objects
}

function buildMultitableTargetObjectsConfig(): Record<string, StagingObjectConfig> {
  const objects: Record<string, StagingObjectConfig> = {}
  for (const descriptor of stagingDescriptors.value) {
    const target = stagingOpenTargetById.value.get(descriptor.id)
    if (!target?.sheetId) continue
    const keyFields = defaultMultitableTargetKeyFields(descriptor)
    objects[descriptor.id] = {
      name: stagingDatasetCopy[descriptor.id]?.name || descriptor.name,
      sheetId: target.sheetId,
      viewId: target.viewId,
      baseId: target.baseId || stagingBaseId.value.trim() || null,
      openLink: target.openLink,
      fields: descriptor.fields,
      fieldDetails: descriptor.fieldDetails,
      keyFields,
      mode: keyFields.length > 0 ? 'upsert' : 'append',
    }
  }
  return objects
}

function buildStagingSourceObjects(): IntegrationSystemObject[] {
  return stagingDescriptors.value.flatMap((descriptor) => {
    const target = stagingOpenTargetById.value.get(descriptor.id)
    if (!target?.sheetId) return []
    return [{
      name: descriptor.id,
      label: stagingDatasetCopy[descriptor.id]?.name || descriptor.name,
      operations: ['read'],
      source: 'metasheet:staging',
      schema: descriptorToSchemaFields(descriptor),
    }]
  })
}

function preferredStagingSourceObjectId(): string {
  const targetPreferred = recommendedStagingSourceByTarget[targetObjectName.value] || ''
  const candidates = [
    targetPreferred,
    stagingSheetId.value,
    'standard_materials',
    stagingOpenTargets.value[0]?.id || '',
  ]
  for (const objectId of candidates) {
    if (!objectId) continue
    if (!stagingOpenTargetById.value.get(objectId)?.sheetId) continue
    if (!stagingDescriptors.value.some((descriptor) => descriptor.id === objectId)) continue
    return objectId
  }
  return ''
}

function buildMultitableTargetObjects(): IntegrationSystemObject[] {
  return stagingDescriptors.value.flatMap((descriptor) => {
    const target = stagingOpenTargetById.value.get(descriptor.id)
    if (!target?.sheetId) return []
    return [{
      name: descriptor.id,
      label: stagingDatasetCopy[descriptor.id]?.name || descriptor.name,
      operations: ['upsert'],
      target: 'metasheet:multitable',
      schema: descriptorToSchemaFields(descriptor),
    }]
  })
}

function buildMultitableOpenLink(sheetId: string, viewId: string, baseId?: string | null): string {
  const path = `/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}`
  const normalizedBaseId = typeof baseId === 'string' && baseId.trim() ? baseId.trim() : ''
  return normalizedBaseId ? `${path}?baseId=${encodeURIComponent(normalizedBaseId)}` : path
}

function normalizeStagingOpenTargets(result: IntegrationStagingInstallResult): IntegrationStagingOpenTarget[] {
  const targetsById = new Map((result.targets ?? []).map((target) => [target.id, target]))
  return Object.entries(result.sheetIds || {}).flatMap(([id, sheetId]) => {
    const target = targetsById.get(id)
    const viewId = target?.viewId || result.viewIds?.[id]
    const openLink = target?.openLink || result.openLinks?.[id]
    if (!sheetId || !viewId) return []
    const copy = stagingDatasetCopy[id]
    return [{
      id,
      name: target?.name || copy?.name || id,
      sheetId,
      viewId,
      baseId: target?.baseId || stagingBaseId.value.trim() || null,
      openLink: openLink || buildMultitableOpenLink(sheetId, viewId, target?.baseId || stagingBaseId.value.trim() || null),
    }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function numberMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function isLargeBomBoundedTableActionResult(result: IntegrationTableActionDryRunResult | null): boolean {
  if (!result) return false
  if (result.largeBom === true || result.status === 'large_bom_bounded') return true
  const evidence = isRecord(result.evidence) ? result.evidence : null
  const expansion = evidence && isRecord(evidence.expansion) ? evidence.expansion : null
  return expansion?.largeBom === true
}

const SECRET_EXPORT_KEY_PATTERN = /(^|[._-])(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|secret|signature|sign|auth|authorization)([._-]|$)/i
const SECRET_EXPORT_TEXT_PATTERNS = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/ig,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|secret|signature|sign|auth|password)=)([^&#\s]+)/ig,
]

function sanitizeExportCell(key: string, value: unknown): ExportCell {
  if (value === undefined) return null
  if (SECRET_EXPORT_KEY_PATTERN.test(key)) return '[redacted]'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return SECRET_EXPORT_TEXT_PATTERNS.reduce((current, pattern) => current.replace(pattern, (_match, prefix) => {
    if (prefix === 'Bearer' || prefix === 'Basic') return `${prefix} [redacted]`
    if (typeof prefix === 'string' && prefix.startsWith('&')) return `${prefix}[redacted]`
    if (typeof prefix === 'string' && prefix.startsWith('?')) return `${prefix}[redacted]`
    return `${prefix || ''}[redacted]`
  }), text)
}

function flattenForExport(value: unknown, prefix: string, output: ExportRow = {}): ExportRow {
  if (!isRecord(value)) {
    output[prefix] = sanitizeExportCell(prefix, value)
    return output
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isRecord(child)) {
      flattenForExport(child, path, output)
    } else if (Array.isArray(child)) {
      output[path] = sanitizeExportCell(path, child)
    } else {
      output[path] = sanitizeExportCell(path, child)
    }
  }
  return output
}

function buildCleansedExportRows(result: IntegrationPipelineRunResult | null): ExportRow[] {
  const preview = isRecord(result?.preview) ? result.preview : null
  const records = Array.isArray(preview?.records) ? preview.records : []
  return records.filter(isRecord).map((record, index) => ({
    recordIndex: index + 1,
    ...flattenForExport(record.source, 'source'),
    ...flattenForExport(record.transformed, 'cleaned'),
    ...flattenForExport(record.targetPayload, 'payload'),
    ...flattenForExport(record.targetRequest, 'request'),
  }))
}

function isDryRunEmptyPreview(result: IntegrationPipelineRunResult): boolean {
  const preview = isRecord(result.preview) ? result.preview : null
  if (!preview) return false
  const records = Array.isArray(preview.records) ? preview.records : []
  const errors = Array.isArray(preview.errors) ? preview.errors : []
  return records.length === 0 && errors.length === 0
}

function buildExportHeaders(rows: ExportRow[]): string[] {
  const headers = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) headers.add(key)
  }
  return Array.from(headers)
}

function csvEscape(value: ExportCell): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前环境不支持浏览器下载')
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function exportCleansedResult(): Promise<void> {
  const rows = cleansedExportRows.value
  if (rows.length === 0) {
    setStatus('请先运行 dry-run 生成可导出的清洗 preview', 'error')
    return
  }
  const headers = buildExportHeaders(rows)
  const baseName = `data-factory-cleansed-${savedPipelineId.value.trim() || stagingSheetId.value || 'preview'}-${timestampForFileName()}`
  try {
    if (cleansedExportFormat.value === 'xlsx') {
      const xlsxModule = (await import('xlsx')) as unknown as Parameters<typeof buildXlsxBuffer>[0]
      const buffer = buildXlsxBuffer(xlsxModule, {
        sheetName: 'cleansed-preview',
        headers,
        rows: rows.map((row) => headers.map((header) => row[header])),
      })
      downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${baseName}.xlsx`)
    } else {
      const csv = [
        headers.map(csvEscape).join(','),
        ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
      ].join('\n')
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${baseName}.csv`)
    }
    setStatus(`已导出 ${rows.length} 条清洗结果`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

function normalizeSystemSelections(): void {
  const runnableSources = runnableSourceSystems.value
  if (sourceSystemId.value && !sourceSystems.value.some((system) => system.id === sourceSystemId.value)) {
    sourceSystemId.value = runnableSources[0]?.id || ''
  }
  if (targetSystemId.value && !targetSystems.value.some((system) => system.id === targetSystemId.value)) {
    targetSystemId.value = targetSystems.value[0]?.id || ''
  }
  if (!sourceSystemId.value) sourceSystemId.value = runnableSources[0]?.id || ''
  if (!targetSystemId.value) targetSystemId.value = targetSystems.value[0]?.id || ''
}

async function refreshBootstrap(): Promise<void> {
  try {
    const resolvedScope = currentScope()
    const [adapterList, systemList, descriptorList] = await Promise.all([
      listIntegrationAdapters(),
      listWorkbenchExternalSystems(resolvedScope),
      listIntegrationStagingDescriptors(),
    ])
    adapters.value = adapterList
    if (!connectionDraft.kind) {
      connectionDraft.kind = adapterList.find((adapter) => !adapter.advanced)?.kind || adapterList[0]?.kind || ''
    }
    systems.value = systemList
    prunePlmCapabilities(systemList)
    stagingDescriptors.value = descriptorList
    normalizeSystemSelections()
    if (!stagingSheetId.value) stagingSheetId.value = descriptorList.find((descriptor) => descriptor.id === 'standard_materials')?.id || descriptorList[0]?.id || ''
    setStatus(`已加载 ${systemList.length} 个连接、${adapterList.length} 个适配器和 ${descriptorList.length} 个 staging 表`, 'success')
    void refreshPlmCapabilitiesForSystem(selectedSourceSystem.value)
    void refreshTableActions(resolvedScope)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function refreshTableActions(resolvedScope = currentScope()): Promise<void> {
  try {
    const actionList = await listIntegrationTableActions(resolvedScope)
    tableActions.value = actionList
    if (!selectedTableActionId.value) {
      selectedTableActionId.value = actionList.find((action) => action.configured)?.actionId || actionList[0]?.actionId || ''
    }
    if (selectedTableActionId.value) void refreshTableActionConflictPolicies(selectedTableActionId.value)
  } catch {
    tableActions.value = []
    selectedTableActionId.value = ''
  }
}

async function refreshTableActionConflictPolicies(actionId = selectedTableActionId.value): Promise<void> {
  if (!actionId) {
    tableActionTableScopePolicies.value = null
    return
  }
  try {
    tableActionTableScopePolicies.value = await listIntegrationTableActionConflictPolicies(actionId, currentScope())
  } catch {
    tableActionTableScopePolicies.value = null
  }
}

function connectionStatusLabel(system: WorkbenchExternalSystem | null): string {
  if (!system) return '未选择'
  if (system.status === 'active') return system.lastTestedAt ? '已连接' : '可用'
  if (system.status === 'error') return system.lastError ? `异常：${system.lastError}（点击"测试连接"重新激活）` : '异常（点击"测试连接"重新激活）'
  return '未启用'
}

function replaceSystem(updated: WorkbenchExternalSystem): void {
  const index = systems.value.findIndex((system) => system.id === updated.id)
  if (index >= 0) {
    systems.value.splice(index, 1, updated)
  } else {
    systems.value.push(updated)
  }
  void refreshPlmCapabilitiesForSystem(updated)
}

async function testSystem(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  if (!systemId) {
    setStatus(`${side === 'source' ? '数据源' : '目标'}系统未选择`, 'error')
    return
  }
  const label = side === 'source' ? '数据源' : '目标'
  // Capture the status BEFORE the test so a recovery (error → active) can be reported explicitly —
  // result.system already carries the post-test status, so it can't tell us where we came from.
  const priorStatus = (side === 'source' ? selectedSourceSystem.value : selectedTargetSystem.value)?.status
  try {
    const result = await testExternalSystemConnection(systemId, currentScope())
    if (result.system) replaceSystem(result.system)
    if (result.ok) {
      setStatus(priorStatus === 'error' ? `${label}连接已恢复，已重新激活` : `${label}连接测试通过`, 'success')
    } else {
      setStatus(`${label}连接测试失败：${result.message || result.code || 'unknown error'}`, 'error')
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadObjects(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  if (!systemId) {
    setStatus(`${side === 'source' ? '数据源' : '目标'}系统未选择`, 'error')
    return
  }
  try {
    const objects = await listExternalSystemObjects(systemId, currentScope())
    if (side === 'source') {
      sourceObjects.value = objects
      sourceObjectName.value = objects[0]?.name || ''
    } else {
      targetObjects.value = objects
      targetObjectName.value = objects[0]?.name || ''
    }
    if (objects.length > 0) await loadSchema(side)
    setStatus(`已加载 ${objects.length} 个${side === 'source' ? '来源' : '目标'}数据集`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadSchema(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  const objectName = side === 'source' ? sourceObjectName.value : targetObjectName.value
  if (!systemId || !objectName) return
  const schema = await getExternalSystemSchema(systemId, {
    ...currentScope(),
    object: objectName,
  })
  if (side === 'source') {
    sourceSchema.value = schema
  } else {
    targetSchema.value = schema
    seedMappingsFromTargetSchema(schema.fields)
  }
}

async function installStagingTables(): Promise<void> {
  const requestedProjectId = stagingProjectId.value.trim()
  installingStaging.value = true
  stagingInstallResultText.value = ''
  try {
    const result = await installIntegrationStaging({
      ...currentScope(),
      ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
      baseId: stagingBaseId.value.trim() || null,
    })
    const resolvedProjectId = (result.projectId || requestedProjectId || defaultStagingProjectId()).trim()
    if (resolvedProjectId) stagingProjectId.value = resolvedProjectId
    stagingOpenTargets.value = normalizeStagingOpenTargets(result)
    stagingInstallResultText.value = JSON.stringify({
      projectId: result.projectId || resolvedProjectId,
      sheetIds: result.sheetIds,
      viewIds: result.viewIds || {},
      targets: stagingOpenTargets.value,
      warnings: result.warnings,
    }, null, 2)
    await refreshBootstrap()
    const preferredSourceId = preferredStagingSourceObjectId()
    if (preferredSourceId) {
      await activateStagingAsSource(
        preferredSourceId,
        result.warnings.length > 0
          ? `清洗表已创建，存在 ${result.warnings.length} 条警告；已自动设置 staging 多维表为 Dry-run 来源`
          : '清洗表已创建，并已自动设置 staging 多维表为 Dry-run 来源',
      )
    } else {
      setStatus(result.warnings.length > 0 ? `清洗表已创建，存在 ${result.warnings.length} 条警告` : '清洗表已创建，可打开多维表处理数据', result.warnings.length > 0 ? 'idle' : 'success')
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    installingStaging.value = false
  }
}

async function useStagingAsSource(objectId: string): Promise<void> {
  await activateStagingAsSource(objectId)
}

async function useRecommendedStagingSource(): Promise<void> {
  const objectId = recommendedStagingSourceObject.value
  if (!objectId) return
  await activateStagingAsSource(objectId, `已按目标模板切换到 ${stagingDatasetCopy[objectId]?.name || objectId} 作为 Dry-run 来源`)
}

async function activateStagingAsSource(objectId: string, successMessage?: string): Promise<void> {
  const descriptor = stagingDescriptors.value.find((item) => item.id === objectId) || null
  const target = stagingOpenTargetById.value.get(objectId)
  if (!descriptor || !target?.sheetId) {
    setStatus('请先创建清洗表，确认该 staging 表已有 sheetId / open link 后再作为来源。', 'error')
    return
  }
  const projectId = effectiveStagingProjectId()
  const objects = buildStagingSourceObjectsConfig()
  if (!objects[objectId]) {
    setStatus('当前 staging 表缺少 sheetId，不能作为 dry-run 来源。', 'error')
    return
  }
  try {
    const system = await upsertWorkbenchExternalSystem({
      ...currentScope(),
      id: stagingSourceSystemId(projectId),
      projectId,
      name: 'MetaSheet staging 多维表',
      kind: 'metasheet:staging',
      role: 'source',
      status: 'active',
      config: {
        projectId,
        baseId: stagingBaseId.value.trim() || target.baseId || null,
        objects,
      },
      capabilities: {
        read: true,
        stagingSource: true,
        dryRunFriendly: true,
      },
    })
    replaceSystem(system)
    sourceSystemId.value = system.id
    sourceObjects.value = buildStagingSourceObjects()
    sourceObjectName.value = objectId
    sourceSchema.value = {
      object: objectId,
      fields: descriptorToSchemaFields(descriptor),
      raw: {
        sheetId: target.sheetId,
        viewId: target.viewId,
        openLink: target.openLink,
      },
    }
    setStatus(successMessage || `已将 ${stagingDatasetCopy[objectId]?.name || descriptor.name} 设为 Dry-run 来源`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function useStagingAsTarget(objectId: string): Promise<void> {
  const descriptor = stagingDescriptors.value.find((item) => item.id === objectId) || null
  const target = stagingOpenTargetById.value.get(objectId)
  if (!descriptor || !target?.sheetId) {
    setStatus('请先创建清洗表，确认该多维表已有 sheetId / open link 后再作为目标。', 'error')
    return
  }
  const projectId = effectiveStagingProjectId()
  const objects = buildMultitableTargetObjectsConfig()
  const objectConfig = objects[objectId]
  if (!objectConfig) {
    setStatus('当前多维表缺少 sheetId，不能作为写回目标。', 'error')
    return
  }
  try {
    const system = await upsertWorkbenchExternalSystem({
      ...currentScope(),
      id: multitableTargetSystemId(projectId),
      projectId,
      name: 'MetaSheet 目标多维表',
      kind: 'metasheet:multitable',
      role: 'target',
      status: 'active',
      config: {
        projectId,
        baseId: stagingBaseId.value.trim() || target.baseId || null,
        objects,
      },
      capabilities: {
        write: true,
        multitableTarget: true,
        append: true,
        upsert: true,
      },
    })
    replaceSystem(system)
    targetSystemId.value = system.id
    targetObjects.value = buildMultitableTargetObjects()
    targetObjectName.value = objectId
    targetSchema.value = {
      object: objectId,
      fields: descriptorToSchemaFields(descriptor),
      raw: {
        sheetId: target.sheetId,
        viewId: target.viewId,
        openLink: target.openLink,
        keyFields: objectConfig.keyFields || [],
        mode: objectConfig.mode || 'append',
      },
    }
    if (mappings.value.length === 0) seedMappingsFromTargetSchema(targetSchema.value.fields)
    setStatus(`已将 ${stagingDatasetCopy[objectId]?.name || descriptor.name} 设为写回目标`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

function guessSourceField(targetField: string): string {
  const known: Record<string, string> = {
    FNumber: 'code',
    FName: 'name',
    FModel: 'spec',
    FBaseUnitID: 'uom',
    FUnitID: 'uom',
    FQty: 'quantity',
    FEntryID: 'sequence',
    FParentItemNumber: 'parentCode',
    FChildItemNumber: 'childCode',
  }
  if (known[targetField]) return known[targetField]
  return targetField.replace(/^F/, '').replace(/Number$/, 'Code')
}

function seedMappingsFromTargetSchema(fields: IntegrationObjectSchemaField[]): void {
  if (mappings.value.length > 0 || fields.length === 0) return
  mappings.value = fields.slice(0, 8).map((field, index) => ({
    id: `mapping_${index}_${field.name}`,
    sourceField: guessSourceField(field.name),
    targetField: field.name,
    transformFn: field.type === 'number' ? 'toNumber' : 'trim',
    dictMapText: '',
    required: field.required === true,
    minValueText: '',
    maxValueText: '',
  }))
}

function addMapping(): void {
  mappings.value.push({
    id: `mapping_${Date.now()}_${mappings.value.length}`,
    sourceField: '',
    targetField: '',
    transformFn: '',
    dictMapText: '',
    required: false,
    minValueText: '',
    maxValueText: '',
  })
}

function removeMapping(index: number): void {
  mappings.value.splice(index, 1)
}

function parseDictionaryMap(text: string): Record<string, string> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('dictMap 字典映射不能为空')
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('dictMap JSON 必须是对象')
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
  }
  const entries = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) throw new Error('dictMap 每行必须使用 source=target 格式')
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (!key || !value) throw new Error('dictMap 每行必须同时包含 source 和 target')
    return [key, value] as const
  })
  return Object.fromEntries(entries)
}

function parseTransform(mapping: EditableMapping): unknown {
  if (!mapping.transformFn) return undefined
  if (mapping.transformFn === 'dictMap') {
    return {
      fn: 'dictMap',
      map: parseDictionaryMap(mapping.dictMapText),
    }
  }
  return { fn: mapping.transformFn }
}

function parseOptionalNumber(value: string, label: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) throw new Error(`${label} 必须是数字`)
  return numeric
}

function buildValidationRules(mapping: EditableMapping): Array<Record<string, unknown>> | undefined {
  const validation: Array<Record<string, unknown>> = []
  if (mapping.required) validation.push({ type: 'required' })
  const min = parseOptionalNumber(mapping.minValueText, 'min')
  const max = parseOptionalNumber(mapping.maxValueText, 'max')
  if (min !== undefined) validation.push({ type: 'min', value: min })
  if (max !== undefined) validation.push({ type: 'max', value: max })
  return validation.length > 0 ? validation : undefined
}

function buildMappings(): IntegrationFieldMapping[] {
  return mappings.value
    .filter((mapping) => mapping.sourceField.trim() && mapping.targetField.trim())
    .map((mapping, index) => {
      return {
        sourceField: mapping.sourceField.trim(),
        targetField: mapping.targetField.trim(),
        transform: parseTransform(mapping),
        validation: buildValidationRules(mapping),
        sortOrder: index,
      }
    })
}

function parseList(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)))
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error('Dry-run 样本数必须是正整数')
  }
  return numeric
}

function defaultPipelineName(): string {
  const sourceName = selectedSourceSystem.value?.name || sourceSystemId.value || 'source'
  const targetName = selectedTargetSystem.value?.name || targetSystemId.value || 'target'
  return `${sourceName}:${sourceObjectName.value || 'object'} -> ${targetName}:${targetObjectName.value || 'object'}`
}

function transformLabel(value: TransformFn): string {
  return transformOptions.find((option) => option.value === value)?.label || '原样'
}

function mappingSummary(mapping: EditableMapping, index: number): string {
  const source = mapping.sourceField.trim() || `来源字段 ${index + 1}`
  const target = mapping.targetField.trim() || `目标字段 ${index + 1}`
  return `${source} -> ${target}`
}

function mappingDetail(mapping: EditableMapping): string {
  const parts = [transformLabel(mapping.transformFn)]
  if (mapping.required) parts.push('必填')
  if (mapping.minValueText.trim() || mapping.maxValueText.trim()) parts.push('数值范围')
  if (mapping.transformFn === 'dictMap') parts.push('字典映射')
  return parts.join(' · ')
}

function useGeneratedPipelineName(): void {
  pipelineName.value = generatedPipelineName.value
}

function selectedTemplateMeta(): Record<string, unknown> {
  const template = selectedTargetObject.value?.template || targetSchema.value.template || {}
  return {
    id: typeof template.id === 'string' ? template.id : undefined,
    version: typeof template.version === 'string' ? template.version : undefined,
    documentType: targetObjectName.value,
    bodyKey: typeof template.bodyKey === 'string' ? template.bodyKey : 'Data',
    endpointPath: typeof template.endpointPath === 'string' ? template.endpointPath : undefined,
  }
}

function buildPipelinePayload() {
  const resolvedScope = currentScope()
  const fieldMappings = buildMappings()
  const idempotencyKeyFields = parseList(idempotencyFieldsText.value)
  if (!sourceSystemId.value) throw new Error('请选择数据源系统')
  if (!targetSystemId.value) throw new Error('请选择目标系统')
  if (!sourceObjectName.value) throw new Error('请选择来源数据集')
  if (!targetObjectName.value) throw new Error('请选择目标数据集')
  if (stagingTargetMismatchNotice.value) throw new Error(stagingTargetMismatchNotice.value)
  if (fieldMappings.length === 0) throw new Error('请至少配置一条清洗映射规则')
  if (idempotencyKeyFields.length === 0) throw new Error('请至少配置一个幂等字段')

  const templateMeta = selectedTemplateMeta()
  const hasTemplate = typeof templateMeta.id === 'string' || typeof templateMeta.endpointPath === 'string'
  return {
    ...(savedPipelineId.value.trim() ? { id: savedPipelineId.value.trim() } : {}),
    ...resolvedScope,
    name: pipelineName.value.trim() || defaultPipelineName(),
    description: 'Data factory pipeline. Business data is cleansed in MetaSheet tables; this pipeline stores mapping and execution policy only.',
    sourceSystemId: sourceSystemId.value,
    sourceObject: sourceObjectName.value,
    targetSystemId: targetSystemId.value,
    targetObject: targetObjectName.value,
    stagingSheetId: stagingSheetId.value.trim() || null,
    mode: pipelineMode.value,
    status: 'active' as const,
    idempotencyKeyFields,
    options: {
      target: {
        autoSubmit: false,
        autoAudit: false,
      },
      workbench: {
        source: 'generic-integration-workbench',
        version: 'v1',
      },
      ...(hasTemplate ? { k3Template: templateMeta } : {}),
    },
    fieldMappings,
  }
}

function buildObservationQuery(status?: string) {
  const pipelineId = savedPipelineId.value.trim()
  if (!pipelineId) throw new Error('请先保存 Pipeline，或粘贴已有 Pipeline ID')
  return {
    ...currentScope(),
    pipelineId,
    ...(status ? { status } : {}),
    limit: 5,
  }
}

async function refreshPipelineObservation(silent = false): Promise<void> {
  observingPipeline.value = true
  try {
    const [runs, openDeadLetters] = await Promise.all([
      listIntegrationPipelineRuns(buildObservationQuery()),
      listIntegrationDeadLetters(buildObservationQuery('open')),
    ])
    pipelineRuns.value = runs
    deadLetters.value = openDeadLetters
    if (!silent) setStatus('Pipeline 运行记录已刷新', 'success')
  } catch (error) {
    if (!silent) setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    observingPipeline.value = false
  }
}

function runRowSummaries(run: IntegrationPipelineRun): IntegrationTargetWriteSummary[] {
  const summaries = run.details?.targetWriteSummaries
  return Array.isArray(summaries) ? summaries : []
}

function isRunExpanded(runId: string): boolean {
  return expandedRunIds.value.has(runId)
}

function toggleRunSummaries(runId: string): void {
  const next = new Set(expandedRunIds.value)
  if (next.has(runId)) next.delete(runId)
  else next.add(runId)
  expandedRunIds.value = next
}

// DF-N2-3 (read-only): a dead-letter's row (idempotency key) is the only typed rowId
// in this panel. Expanding fetches that row's cross-run provenance timeline once via
// the DF-N2-2c by-rowId GET; pipelineId is passed to avoid cross-pipeline key
// collisions. This is observation only — never a write, replay, or retry.
function canViewRowProvenance(deadLetter: IntegrationDeadLetter): boolean {
  return typeof deadLetter.idempotencyKey === 'string' && deadLetter.idempotencyKey.trim().length > 0
}

function isRowProvenanceExpanded(deadLetterId: string): boolean {
  return expandedDeadLetterProvenanceIds.value.has(deadLetterId)
}

function isRowProvenanceLoading(deadLetterId: string): boolean {
  return rowProvenanceLoadingIds.value.has(deadLetterId)
}

function rowProvenanceTimeline(deadLetterId: string): IntegrationProvenanceTimelineEntry[] {
  return rowProvenanceByDeadLetterId.value.get(deadLetterId) ?? []
}

function rowProvenanceError(deadLetterId: string): string {
  return rowProvenanceErrorById.value.get(deadLetterId) ?? ''
}

// Compact, names-safe summary of the already-redacted attrs (no raw payload dump).
function rowProvenanceAttrsSummary(attrs: Record<string, unknown> | undefined): string {
  if (!attrs || typeof attrs !== 'object') return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`)
    if (parts.length >= 4) break
  }
  const remaining = Object.keys(attrs).length - parts.length
  return remaining > 0 ? `${parts.join(' · ')} · +${remaining}` : parts.join(' · ')
}

async function toggleDeadLetterProvenance(deadLetter: IntegrationDeadLetter): Promise<void> {
  // No rowId (idempotency key) → nothing to look up (the toggle is disabled in the
  // UI too); guard before toggling so a no-key row never opens an empty panel.
  if (!canViewRowProvenance(deadLetter)) return
  const next = new Set(expandedDeadLetterProvenanceIds.value)
  if (next.has(deadLetter.id)) {
    next.delete(deadLetter.id)
    expandedDeadLetterProvenanceIds.value = next
    return
  }
  next.add(deadLetter.id)
  expandedDeadLetterProvenanceIds.value = next
  // Fetch once per row; re-expanding a collapsed row reuses the cached timeline.
  if (rowProvenanceByDeadLetterId.value.has(deadLetter.id)) return
  const loading = new Set(rowProvenanceLoadingIds.value)
  loading.add(deadLetter.id)
  rowProvenanceLoadingIds.value = loading
  const clearedError = new Map(rowProvenanceErrorById.value)
  clearedError.delete(deadLetter.id)
  rowProvenanceErrorById.value = clearedError
  try {
    const entries = await listIntegrationProvenanceByRow({
      ...currentScope(),
      rowId: String(deadLetter.idempotencyKey),
      pipelineId: deadLetter.pipelineId,
    })
    const map = new Map(rowProvenanceByDeadLetterId.value)
    map.set(deadLetter.id, entries)
    rowProvenanceByDeadLetterId.value = map
  } catch (error) {
    const map = new Map(rowProvenanceErrorById.value)
    map.set(deadLetter.id, error instanceof Error ? error.message : String(error))
    rowProvenanceErrorById.value = map
  } finally {
    const done = new Set(rowProvenanceLoadingIds.value)
    done.delete(deadLetter.id)
    rowProvenanceLoadingIds.value = done
  }
}

// Two-step confirm before any live replay. Replay re-runs the pipeline with the
// stored payload (a real target/ERP write), so it mirrors the deliberate
// allowSaveOnlyRun opt-in used for Save-only runs in this view.
function requestReplay(deadLetterId: string): void {
  confirmReplayDeadLetterId.value = deadLetterId
}

function cancelReplay(): void {
  confirmReplayDeadLetterId.value = ''
}

async function replayDeadLetter(deadLetter: IntegrationDeadLetter): Promise<void> {
  if (!isDeadLetterReplayable(deadLetter)) {
    setStatus('仅可重放 open 状态的 dead letter', 'error')
    return
  }
  replayingDeadLetterId.value = deadLetter.id
  try {
    const result = await replayIntegrationDeadLetter(deadLetter.id, {
      ...currentScope(),
      mode: pipelineRunMode.value,
    })
    // Verdict is the ERP write outcome (rowsFailed) alone. A write that
    // SUCCEEDED but whose markReplayed bookkeeping failed comes back with the
    // letter still 'open' + a warning (pipeline-runner.cjs:732-756); that is
    // still a success — prompting a retry there would risk a duplicate write.
    const rowsFailed = Number(result.replay?.metrics?.rowsFailed ?? 0)
    if (rowsFailed > 0) {
      setStatus(`Replay 未完全成功：dead letter ${deadLetter.id} 仍未解决`, 'error')
    } else {
      const warning = result.warning?.message ? `（${result.warning.message}）` : ''
      setStatus(`Replay 成功：dead letter ${deadLetter.id} 已重放${warning}`, 'success')
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    replayingDeadLetterId.value = ''
    confirmReplayDeadLetterId.value = ''
    await refreshPipelineObservation(true)
  }
}

async function savePipeline(): Promise<void> {
  savingPipeline.value = true
  try {
    const pipeline = await upsertIntegrationPipeline(buildPipelinePayload())
    savedPipelineId.value = pipeline.id
    pipelineName.value = pipeline.name
    pipelineResultText.value = JSON.stringify({ action: 'save-pipeline', pipeline }, null, 2)
    setStatus(`Pipeline 已保存：${pipeline.id}`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    savingPipeline.value = false
  }
}

async function executePipeline(dryRun: boolean): Promise<void> {
  const pipelineId = savedPipelineId.value.trim()
  if (!pipelineId) {
    setStatus('请先保存 Pipeline，或粘贴已有 Pipeline ID', 'error')
    return
  }
  if (!dryRun && !allowSaveOnlyRun.value) {
    setStatus('Save-only 推送前必须显式勾选允许本次推送', 'error')
    return
  }
  runningPipeline.value = dryRun ? 'dry-run' : 'run'
  try {
    const payload = {
      ...currentScope(),
      mode: pipelineRunMode.value,
      sampleLimit: parseOptionalPositiveInteger(pipelineSampleLimit.value),
    }
    const result = await runIntegrationPipeline(pipelineId, payload, dryRun)
    if (dryRun) {
      lastDryRunResult.value = result
    } else {
      lastDryRunResult.value = null
    }
    pipelineResultText.value = JSON.stringify({
      action: dryRun ? 'dry-run' : 'save-only-run',
      pipelineId,
      payload,
      result,
    }, null, 2)
    await refreshPipelineObservation(true)
    const dryRunStatus = isDryRunEmptyPreview(result)
      ? 'Dry-run 成功，但本次没有可处理记录'
      : 'Dry-run 已提交'
    setStatus(dryRun ? dryRunStatus : 'Save-only 推送已提交', 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    runningPipeline.value = ''
  }
}

function resetTableActionReview(): void {
  tableActionDryRunResult.value = null
  tableActionApplyResult.value = null
  tableActionAcceptManualConfirmHold.value = false
  tableActionDuplicatePolicyDrafts.value = {}
  tableActionDuplicateRunPolicies.value = {}
  tableActionConflictPolicySaving.value = ''
  tableActionConflictPolicyDirty.value = false
}

function buildTableActionParameters(): Record<string, unknown> {
  const projectNo = tableActionProjectNo.value.trim()
  if (!projectNo) throw new Error('请填写项目号 projectNo')
  return { projectNo }
}

function selectedDuplicatePolicy(group: DuplicateExpandedGroupView): string {
  return tableActionDuplicatePolicyDrafts.value[group.fingerprint] || group.currentPolicy || 'hold'
}

function onDuplicatePolicyDraftChange(fingerprint: string, event: Event): void {
  const target = event.target instanceof HTMLSelectElement ? event.target : null
  if (!target) return
  tableActionDuplicatePolicyDrafts.value = {
    ...tableActionDuplicatePolicyDrafts.value,
    [fingerprint]: target.value,
  }
}

function syncDuplicatePolicyDraftsFromResult(result: IntegrationTableActionDryRunResult): void {
  const plan = isRecord(result.evidence?.plan) ? result.evidence.plan : null
  const review = plan && isRecord(plan.conflictPolicyReview) ? plan.conflictPolicyReview : null
  const selections = Array.isArray(review?.selectedPolicies) ? review.selectedPolicies.filter(isRecord) : []
  const next: Record<string, string> = {}
  for (const row of selections) {
    if (typeof row.fingerprint === 'string' && typeof row.policy === 'string') {
      next[row.fingerprint] = row.policy
    }
  }
  tableActionDuplicatePolicyDrafts.value = next
}

function buildConflictPolicyReviewPayload() {
  const policies = Object.entries(tableActionDuplicateRunPolicies.value)
    .filter(([fingerprint, policy]) => fingerprint && policy)
    .map(([fingerprint, policy]) => ({ fingerprint, policy }))
  if (policies.length === 0) return undefined
  return {
    conflictType: 'duplicate_expanded_key' as const,
    scope: 'run_only' as const,
    policies,
  }
}

function setDuplicateRunOnlyPolicy(group: DuplicateExpandedGroupView): void {
  const policy = selectedDuplicatePolicy(group)
  tableActionDuplicateRunPolicies.value = {
    ...tableActionDuplicateRunPolicies.value,
    [group.fingerprint]: policy,
  }
  tableActionConflictPolicyDirty.value = true
  tableActionApplyResult.value = null
  setStatus(`已选择 ${group.fingerprint} = ${policy}（只此次有效）；请重新 dry-run 让选择进入 evidence，重复行仍保持不写。`, 'success')
}

async function saveDuplicateTableScopePolicy(group: DuplicateExpandedGroupView): Promise<void> {
  const action = selectedTableAction.value
  if (!action?.configured) return
  if (!auth.hasPermission('integration:admin')) {
    setStatus('只有管理员可以保存本表重复行策略。', 'error')
    return
  }
  const policy = selectedDuplicatePolicy(group)
  tableActionConflictPolicySaving.value = group.fingerprint
  try {
    const result = await saveIntegrationTableActionConflictPolicies(action.actionId, {
      ...currentScope(),
      conflictType: 'duplicate_expanded_key',
      scope: 'table_scope',
      policies: [{ fingerprint: group.fingerprint, policy }],
    })
    tableActionTableScopePolicies.value = result
    tableActionConflictPolicyDirty.value = true
    tableActionApplyResult.value = null
    setStatus(`已保存本表策略 ${group.fingerprint} = ${policy}；请重新 dry-run 让本表策略进入 evidence。`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    tableActionConflictPolicySaving.value = ''
  }
}

async function revokeDuplicateTableScopePolicy(group: DuplicateExpandedGroupView): Promise<void> {
  const action = selectedTableAction.value
  if (!action?.configured) return
  if (!auth.hasPermission('integration:admin')) {
    setStatus('只有管理员可以撤销本表重复行策略。', 'error')
    return
  }
  tableActionConflictPolicySaving.value = group.fingerprint
  try {
    const result = await deleteIntegrationTableActionConflictPolicies(action.actionId, {
      ...currentScope(),
      conflictType: 'duplicate_expanded_key',
      fingerprints: [group.fingerprint],
    })
    tableActionTableScopePolicies.value = result
    tableActionConflictPolicyDirty.value = true
    tableActionApplyResult.value = null
    setStatus(`已撤销本表策略 ${group.fingerprint}；默认回到 hold。请重新 dry-run 复核。`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    tableActionConflictPolicySaving.value = ''
  }
}

function buildStockPreparationOptionSyncPayload(): Record<string, unknown> {
  const text = stockPreparationOptionSyncText.value.trim()
  if (!text) throw new Error('请填写 optionSets JSON')
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('optionSets JSON 必须是对象')
  }
  const record = parsed as Record<string, unknown>
  if ('optionSets' in record || 'optionSources' in record || 'configInfo' in record) return record
  return { optionSets: record }
}

async function syncStockPreparationOptions(): Promise<void> {
  if (!auth.hasPermission('integration:admin')) {
    setStatus('只有管理员可以同步备料选项。', 'error')
    return
  }
  syncingStockPreparationOptions.value = true
  stockPreparationOptionSyncResult.value = null
  try {
    const result = await syncIntegrationStockPreparationOptions({
      ...currentScope(),
      ...buildStockPreparationOptionSyncPayload(),
    })
    stockPreparationOptionSyncResult.value = result
    const fieldCount = Number(result.target?.fieldCount || 0)
    setStatus(`备料选项同步完成：${fieldCount} 个字段已更新。`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    syncingStockPreparationOptions.value = false
  }
}

async function dryRunTableAction(): Promise<void> {
  const action = selectedTableAction.value
  if (!action?.configured) {
    setStatus('表动作尚未由管理员配置，不能 dry-run。', 'error')
    return
  }
  runningTableAction.value = 'dry-run'
  tableActionDryRunResult.value = null
  tableActionApplyResult.value = null
  tableActionAcceptManualConfirmHold.value = false
  try {
    const result = await dryRunIntegrationTableAction(action.actionId, {
      ...currentScope(),
      parameters: buildTableActionParameters(),
      conflictPolicyReview: buildConflictPolicyReviewPayload(),
    })
    tableActionDryRunResult.value = result
    tableActionDuplicateRunPolicies.value = {}
    tableActionConflictPolicyDirty.value = false
    syncDuplicatePolicyDraftsFromResult(result)
    const manualCount = Number(result.counts?.manual_confirm || 0)
    const planEvidence = isRecord(result.evidence?.plan) ? result.evidence.plan : null
    const duplicateDiagnostics = planEvidence && isRecord(planEvidence.duplicateExpandedKeyDiagnostics)
      ? planEvidence.duplicateExpandedKeyDiagnostics
      : null
    const duplicateGroupCount = duplicateDiagnostics ? Number(duplicateDiagnostics.groupCount || 0) : 0
    const message = isLargeBomBoundedTableActionResult(result)
      ? '表动作 dry-run 返回大 BOM 有界预览；Apply 已阻塞，请走完整展开/后台通道。'
      : duplicateGroupCount > 0
      ? `表动作 dry-run 完成：${duplicateGroupCount} 个重复分组需要 review；重复行保持不写。`
      : manualCount > 0
      ? `表动作 dry-run 完成：${manualCount} 行需要人工确认，apply 会保持这些行不写。`
      : '表动作 dry-run 完成，可进入 apply 确认。'
    setStatus(message, result.canApply ? 'success' : 'error')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    runningTableAction.value = ''
  }
}

async function applyTableAction(): Promise<void> {
  const action = selectedTableAction.value
  if (!action?.configured) {
    setStatus('表动作尚未由管理员配置，不能 apply。', 'error')
    return
  }
  if (!auth.hasPermission('integration:write')) {
    setStatus('当前用户只有 dry-run 读取权限，不能 apply 到备料表。', 'error')
    return
  }
  if (!tableActionDryRunToken.value) {
    setStatus('请先执行 dry-run；apply 必须使用服务端返回的一次性 dry-run token。', 'error')
    return
  }
  runningTableAction.value = 'apply'
  tableActionApplyResult.value = null
  try {
    const result = await applyIntegrationTableAction(action.actionId, {
      ...currentScope(),
      parameters: buildTableActionParameters(),
      confirm: {
        dryRunToken: tableActionDryRunToken.value,
        acceptManualConfirmHold: tableActionAcceptManualConfirmHold.value === true,
      },
    })
    tableActionApplyResult.value = result
    tableActionDryRunResult.value = null
    tableActionAcceptManualConfirmHold.value = false
    setStatus(`表动作 apply 完成：${result.status}`, result.status === 'failed' ? 'error' : 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    runningTableAction.value = ''
  }
}

const PROVENANCE_SOURCE_LABELS: Record<string, string> = {
  staging: '暂存源',
  template: '模板',
  constant: '常量',
  reference_table: '引用表',
}
function provenanceSourceLabel(source: string): string {
  return PROVENANCE_SOURCE_LABELS[source] || source
}

// DF-T2c: derive a draft via the READ-ONLY route, then drive the authoring UI with it. The pasted
// payloadTemplate is RAW/operator-local; the route (DF-T2a) fails closed on redaction markers /
// secrets / outer {Data:…} envelopes, surfaced here as deriveError. No write, no K3 call.
async function deriveTemplateDraft(): Promise<void> {
  deriveError.value = ''
  const raw = payloadTemplateText.value.trim()
  if (!raw) {
    deriveError.value = '请先填写目标模板 JSON'
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    deriveError.value = '目标模板 JSON 解析失败'
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    deriveError.value = '目标模板 JSON 必须是一个对象'
    return
  }
  derivingDraft.value = true
  try {
    const draft = await deriveIntegrationTemplate(parsed as Record<string, unknown>)
    authoredFieldRules.value = Array.isArray(draft.fieldRules) ? draft.fieldRules : []
    authoredGatedFields.value = Array.isArray(draft.gatedFields) ? draft.gatedFields : []
  } catch (error) {
    deriveError.value = error instanceof Error ? error.message : String(error)
    authoredFieldRules.value = []
    authoredGatedFields.value = []
  } finally {
    derivingDraft.value = false
  }
}

// DF-T3b dual-binding picker: bind a domain's mapping sheet (staging system + object). Stored per-domain;
// previewPayload assembles referenceMappingSources from the currently-authored domains.
function onRefMappingSystemChange(domain: string, systemId: string): void {
  const current = referenceMappingBindings.value[domain] || { systemId: '', object: '' }
  referenceMappingBindings.value = { ...referenceMappingBindings.value, [domain]: { ...current, systemId } }
}

function onRefMappingObjectChange(domain: string, object: string): void {
  const current = referenceMappingBindings.value[domain] || { systemId: '', object: '' }
  referenceMappingBindings.value = { ...referenceMappingBindings.value, [domain]: { ...current, object } }
}

async function previewPayload(): Promise<void> {
  try {
    const sourceRecord = JSON.parse(sampleRecordText.value) as Record<string, unknown>
    const template = selectedTemplateMeta()
    const fieldMappings = buildMappings()
    const request: IntegrationTemplatePreviewRequest = {
      sourceRecord,
      fieldMappings,
      template: {
        id: typeof template.id === 'string' ? template.id : targetObjectName.value,
        version: typeof template.version === 'string' ? template.version : undefined,
        documentType: typeof template.documentType === 'string' ? template.documentType : targetObjectName.value,
        bodyKey: typeof template.bodyKey === 'string' ? template.bodyKey : 'Data',
        endpointPath: typeof template.endpointPath === 'string' ? template.endpointPath : undefined,
        schema: targetSchema.value.fields,
      },
    }
    // DF-T1.5 reachability wire: an optional payloadTemplate JSON switches the request to the DF-T1
    // no-write preview (payloadTemplate + derived fieldRules); empty keeps the request byte-compatible
    // with the legacy preview; invalid JSON throws here → error path, no backend call.
    const payloadTemplateRaw = payloadTemplateText.value.trim()
    if (payloadTemplateRaw) {
      const parsed = JSON.parse(payloadTemplateRaw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('目标模板 JSON 必须是一个对象')
      }
      request.payloadTemplate = parsed as Record<string, unknown>
      // DF-T2c: send the AUTHORED rules (derived via the read-only route + edited in the authoring
      // UI) when present; else fall back to the legacy mapping-derived rules (byte-compatible w/ #1970).
      request.fieldRules = authoredFieldRules.value.length > 0
        ? authoredFieldRules.value
        : deriveFieldRulesFromMappings(fieldMappings)
      // DF-T3b dual-binding picker: build referenceMappingSources from the per-domain picker bindings,
      // for ONLY the domains currently authored as from_reference_table (stale bindings for removed
      // domains are dropped; incomplete bindings — missing system or object — are skipped). The route
      // live-bulk-reads each. The SECOND binding (sourceCode column) rides on the from_reference_table
      // rules' sourceField, already in request.fieldRules above.
      const referenceMappingSources: IntegrationReferenceMappingSource[] = []
      for (const domain of referenceMappingDomains.value) {
        const binding = referenceMappingBindings.value[domain]
        if (binding && binding.systemId && binding.object) {
          referenceMappingSources.push({ domain, systemId: binding.systemId, object: binding.object })
        }
      }
      if (referenceMappingSources.length > 0) request.referenceMappingSources = referenceMappingSources
    }
    const result = await previewIntegrationTemplate(request)
    previewText.value = JSON.stringify(result, null, 2)
    previewProvenance.value = summarizeFieldProvenance(result.targetPayloadPreview)
    setStatus(result.valid ? 'Payload 预览通过' : `Payload 预览发现 ${result.errors.length} 个问题`, result.valid ? 'success' : 'error')
  } catch (error) {
    previewText.value = '预览失败'
    previewProvenance.value = null
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

onMounted(() => {
  void refreshBootstrap()
})

watch(showAdvancedConnectors, () => {
  normalizeSystemSelections()
})

watch(sourceSystemId, () => {
  void refreshPlmCapabilitiesForSystem(selectedSourceSystem.value)
})

watch(tableActionProjectNo, () => {
  resetTableActionReview()
})

watch(selectedTableActionId, (actionId) => {
  resetTableActionReview()
  tableActionTableScopePolicies.value = null
  if (actionId) void refreshTableActionConflictPolicies(actionId)
})
</script>

<style scoped>
.integration-workbench__provenance {
  margin-top: 12px;
}
.integration-workbench__provenance-title {
  font-size: 14px;
  margin: 0 0 6px;
}
.integration-workbench__provenance-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 8px;
}
.integration-workbench__provenance-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.integration-workbench__provenance-list li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.integration-workbench__provenance-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: #eef2ff;
  color: #3730a3;
}

.integration-workbench__table-action {
  margin: 16px 0;
  padding: 14px;
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #f8fbff;
}

.integration-workbench__table-action h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.integration-workbench__table-action p {
  margin: 0;
}

.integration-workbench__capability-entry {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid #d7deea;
  border-radius: 8px;
  background: #f8fbff;
}

.integration-workbench__capability-entry > div {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__capability-entry strong {
  color: #1f3551;
}

.integration-workbench__capability-entry p,
.integration-workbench__capability-entry small {
  margin: 0;
  color: #5c6878;
  font-size: 13px;
  line-height: 1.45;
}

.integration-workbench__table-action-review {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.integration-workbench__bounded-preview {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid #f3c8a8;
  border-radius: 6px;
  background: #fff7ed;
}

.integration-workbench__bounded-preview > div:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__bounded-preview strong {
  color: #7c2d12;
}

.integration-workbench__mini-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__mini-list li {
  padding: 8px;
  border: 1px solid #f3d8bd;
  border-radius: 6px;
  background: #fffaf5;
  color: #5b3417;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.integration-workbench {
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px;
  color: #17202a;
}

.integration-workbench__header,
.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__header {
  margin-bottom: 18px;
}

.integration-workbench__flow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.integration-workbench__flow-step,
.integration-workbench__dataset-card,
.integration-workbench__staging-card {
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #ffffff;
}

.integration-workbench__flow-step {
  display: grid;
  gap: 4px;
  padding: 12px;
}

.integration-workbench__flow-step strong {
  color: #1f3551;
  font-size: 13px;
}

.integration-workbench__flow-step span {
  color: #5c6878;
  font-size: 12px;
  line-height: 1.4;
}

.integration-workbench__quick-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: -4px 0 16px;
  padding: 10px 12px;
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #f8fbff;
  color: #3c4b60;
  font-size: 13px;
  line-height: 1.45;
}

.integration-workbench__quick-flow strong {
  color: #1f3551;
}

.integration-workbench__quick-flow span {
  overflow-wrap: anywhere;
}

.integration-workbench__eyebrow {
  margin: 0 0 6px;
  color: #54637a;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

.integration-workbench h1,
.integration-workbench h2 {
  margin: 0;
}

.integration-workbench h1 {
  font-size: 28px;
}

.integration-workbench h2 {
  font-size: 17px;
}

.integration-workbench__lead,
.integration-workbench__panel p {
  margin: 8px 0 0;
  color: #5c6878;
  line-height: 1.5;
}

.integration-workbench__k3-link,
.integration-workbench__button,
.integration-workbench__icon-button {
  border: 1px solid #bfccd9;
  border-radius: 6px;
  background: #ffffff;
  color: #233246;
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
  border-color: #357abd;
}

.integration-workbench__button:disabled,
.integration-workbench__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__button--danger {
  border-color: #c77777;
  color: #8f1d1d;
}

.integration-workbench__status {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #eef4fb;
  color: #24476b;
}

.integration-workbench__status[data-kind="error"] {
  background: #fff0f0;
  color: #9b1c1c;
}

.integration-workbench__status[data-kind="success"] {
  background: #edf7ef;
  color: #17622f;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #ffffff;
}

.integration-workbench__adapter-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__onboarding,
.integration-workbench__readiness {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid #d7deea;
  border-radius: 8px;
  background: #f8fafc;
}

.integration-workbench__onboarding strong,
.integration-workbench__readiness strong {
  color: #1f3551;
}

.integration-workbench__onboarding p,
.integration-workbench__readiness p {
  margin: 4px 0 0;
  color: #5c6878;
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
  border: 1px solid #d7deea;
  border-radius: 8px;
  background: #fbfcfe;
}

.integration-workbench__connection-manager strong {
  color: #1f3551;
}

.integration-workbench__connection-manager p {
  margin: 4px 0 0;
  color: #5c6878;
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__details {
  border-top: 1px solid #e4ebf2;
  padding-top: 10px;
}

.integration-workbench__details summary {
  cursor: pointer;
  color: #1f3551;
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
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #ffffff;
  color: #233246;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  text-align: left;
}

.integration-workbench__inventory-toggle span {
  color: #357abd;
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
  border: 1px solid #e4ebf2;
  border-radius: 6px;
  background: #ffffff;
}

.integration-workbench__inventory-list span,
.integration-workbench__inventory-list small {
  color: #5c6878;
  font-size: 12px;
  line-height: 1.4;
}

.integration-workbench__adapter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid #d8e0e8;
  border-radius: 999px;
  color: #35465c;
  font-size: 13px;
}

.integration-workbench__adapter small {
  color: #8a4d00;
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
  color: #5c6878;
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__hint--strong {
  padding: 10px 12px;
  border-radius: 6px;
  background: #fff8e8;
  color: #744600;
}

.integration-workbench__connection-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: #eef2f7;
  color: #3c4b60;
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__badge[data-status="active"] {
  background: #edf7ef;
  color: #17622f;
}

.integration-workbench__badge[data-status="error"] {
  background: #fff0f0;
  color: #9b1c1c;
}

.integration-workbench__badge[data-status="warning"] {
  background: #fff8e8;
  color: #744600;
}

.integration-workbench__badge[data-status="enabled"] {
  background: #edf7ef;
  color: #17622f;
}

.integration-workbench__badge[data-status="upgrade"] {
  background: #fff8e8;
  color: #744600;
}

.integration-workbench__badge[data-status="loading"] {
  background: #eef2f7;
  color: #3c4b60;
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--systems {
  align-items: start;
}

.integration-workbench__grid--compact {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.integration-workbench__dataset-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.integration-workbench__dataset-card {
  display: grid;
  gap: 10px;
  padding: 14px;
}

.integration-workbench__dataset-head {
  display: grid;
  gap: 4px;
}

.integration-workbench__dataset-kind {
  color: #5c6878;
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__dataset-card strong,
.integration-workbench__staging-card strong {
  color: #1f3551;
}

.integration-workbench__dataset-card p,
.integration-workbench__staging-card p {
  margin: 0;
  color: #5c6878;
  line-height: 1.5;
}

.integration-workbench__metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.integration-workbench__metric-row span,
.integration-workbench__staging-card small {
  display: inline-flex;
  color: #5c6878;
  font-size: 12px;
}

.integration-workbench__staging-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__staging-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
}

.integration-workbench__staging-note {
  grid-column: 1 / -1;
  display: block;
  color: #5c6878;
  line-height: 1.45;
}

.integration-workbench__staging-note--warning {
  color: #92400e;
}

.integration-workbench__system-column {
  display: grid;
  gap: 12px;
}

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: #35465c;
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select,
.integration-workbench textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #bfccd9;
  border-radius: 6px;
  padding: 8px 10px;
  color: #17202a;
  font: inherit;
}

.integration-workbench textarea {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.integration-workbench__schema-list {
  min-height: 84px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #e4ebf2;
  border-radius: 6px;
  background: #f8fafc;
  list-style: none;
}

.integration-workbench__schema-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  color: #42536a;
}

.integration-workbench code {
  color: #1f5f99;
  font-size: 12px;
}

.integration-workbench__schema-list strong {
  color: #9b1c1c;
  font-size: 12px;
}

.integration-workbench__mapping-table {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
}

.integration-workbench__mapping-list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__mapping-card {
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #fbfcfe;
}

.integration-workbench__mapping-card summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 10px 12px;
  color: #1f3551;
  cursor: pointer;
  font-weight: 700;
}

.integration-workbench__mapping-card summary small {
  color: #5c6878;
  font-weight: 600;
}

.integration-workbench__mapping-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(180px, 0.8fr) minmax(180px, 0.8fr) auto;
  gap: 10px;
  padding: 0 12px 12px;
  align-items: start;
}

.integration-workbench__mapping-table th,
.integration-workbench__mapping-table td {
  padding: 8px;
  border-bottom: 1px solid #e4ebf2;
  text-align: left;
}

.integration-workbench__mapping-table th {
  color: #5c6878;
  font-size: 12px;
}

.integration-workbench__mapping-table input[type="checkbox"] {
  width: auto;
}

.integration-workbench__mapping-table textarea {
  min-height: 68px;
  margin-top: 6px;
}

.integration-workbench__mapping-editor textarea {
  min-height: 68px;
  margin-top: 6px;
}

.integration-workbench__mapping-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 6px;
}

.integration-workbench__mapping-rules {
  display: grid;
  grid-template-columns: repeat(2, minmax(72px, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.integration-workbench__inline-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__inline-check input {
  width: auto;
}

.integration-workbench__inline-action {
  width: max-content;
  border: 0;
  background: transparent;
  color: #1f5f99;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 0;
  text-align: left;
}

.integration-workbench__field-help {
  color: #5c6878;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
}

.integration-workbench__run-explainer {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid #d7deea;
  border-radius: 8px;
  background: #f8fafc;
}

.integration-workbench__run-explainer strong {
  color: #1f3551;
}

.integration-workbench__run-explainer ul {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding-left: 18px;
  color: #5c6878;
  line-height: 1.5;
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

.integration-workbench__readiness {
  display: grid;
  grid-template-columns: minmax(220px, 0.4fr) minmax(0, 1fr);
}

.integration-workbench__readiness ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__readiness li {
  display: grid;
  gap: 4px;
  padding: 8px;
  border: 1px solid #e4ebf2;
  border-radius: 6px;
  background: #ffffff;
}

.integration-workbench__readiness li[data-ready="true"] {
  border-color: #b9dfc4;
  background: #f3fbf5;
}

.integration-workbench__readiness li > span {
  color: #7a4a00;
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__readiness li[data-ready="true"] > span {
  color: #17622f;
}

.integration-workbench__readiness small {
  color: #5c6878;
  font-size: 12px;
  line-height: 1.4;
}

.integration-workbench__export {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(160px, 220px) auto;
  align-items: end;
  gap: 12px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid #d7deea;
  border-radius: 8px;
  background: #f8fafc;
}

.integration-workbench__export strong,
.integration-workbench__export p {
  margin: 0;
}

.integration-workbench__export p {
  margin-top: 4px;
  color: #5c6878;
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__observation {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 14px;
}

.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.integration-workbench__muted {
  margin: -4px 0 10px;
  color: #5c6878;
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed #cbd5e1;
  border-radius: 6px;
  color: #5c6878;
}

.integration-workbench__empty--actionable {
  margin-top: 10px;
}

.integration-workbench__empty strong {
  color: #1f3551;
}

.integration-workbench__empty p {
  margin: 6px 0 0;
}

.integration-workbench__record-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__record-list li {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid #e4ebf2;
  border-radius: 6px;
  background: #f8fafc;
}

.integration-workbench__record-list small {
  color: #5c6878;
}

.integration-workbench__run-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.integration-workbench__run-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #5c6878;
}

.integration-workbench__run-metric--write {
  color: #1f6f43;
  font-weight: 600;
}

.integration-workbench__run-metric--fail {
  color: #8f1d1d;
  font-weight: 600;
}

.integration-workbench__run-status {
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 4px;
  background: #e7eef6;
  color: #24476b;
}

.integration-workbench__run-status--succeeded {
  background: #e3f3e8;
  color: #1f6f43;
}

.integration-workbench__run-status--partial {
  background: #fdf3e0;
  color: #8a5a12;
}

.integration-workbench__run-status--failed,
.integration-workbench__run-status--cancelled {
  background: #fbe7e7;
  color: #8f1d1d;
}

.integration-workbench__run-error {
  margin: 0;
  font-size: 12px;
  color: #8f1d1d;
}

.integration-workbench__run-summaries {
  display: grid;
  gap: 4px;
}

/* Inline row-level results: override the global tall/dark `pre` so each
   expanded run stays compact within the record list. */
.integration-workbench__run-summaries pre {
  min-height: 0;
  max-height: 200px;
  margin: 4px 0 0;
}

.integration-workbench__dead-letter-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* DF-N2-3 read-only cross-run provenance timeline (per dead-letter row). */
.integration-workbench__dead-letter-provenance {
  margin-top: 6px;
  display: grid;
  gap: 4px;
}

.integration-workbench__provenance-timeline {
  display: grid;
  gap: 6px;
  padding: 6px 0 0;
}

.integration-workbench__provenance-event-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.integration-workbench__provenance-attrs {
  margin: 2px 0 0;
  font-size: 12px;
  color: #5a6473;
  word-break: break-word;
}

.integration-workbench__badge--retryable {
  background: #e3f3e8;
  color: #1f6f43;
}

.integration-workbench__button--ghost {
  background: transparent;
}

.integration-workbench__link-button {
  border: none;
  background: none;
  padding: 0;
  color: #357abd;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.integration-workbench__link-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__preview {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 16px;
}

.integration-workbench pre {
  min-height: 260px;
  max-height: 420px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid #d8e0e8;
  border-radius: 6px;
  background: #111827;
  color: #e5edf7;
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .integration-workbench__header,
  .integration-workbench__panel-head,
  .integration-workbench__preview,
  .integration-workbench__observation,
  .integration-workbench__flow,
  .integration-workbench__dataset-grid,
  .integration-workbench__inventory,
  .integration-workbench__onboarding,
  .integration-workbench__readiness,
  .integration-workbench__readiness ul,
  .integration-workbench__staging-list,
  .integration-workbench__export,
  .integration-workbench__mapping-editor,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__header,
  .integration-workbench__panel-head {
    display: grid;
  }

  .integration-workbench__onboarding,
  .integration-workbench__readiness {
    display: grid;
  }

  .integration-workbench__onboarding-actions {
    justify-content: flex-start;
  }
}
</style>

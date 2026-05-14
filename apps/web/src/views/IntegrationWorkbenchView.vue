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
          <strong>连接新系统</strong>
          <p>从这里开始接入 PLM、ERP、CRM、SRM、HTTP API 或 SQL 数据源；已配置连接会回到下方数据源/目标选择器。</p>
        </div>
        <div class="integration-workbench__onboarding-actions">
          <router-link class="integration-workbench__button" to="/integrations/k3-wise" data-testid="k3-preset-entry">
            使用 K3 WISE 预设
          </router-link>
          <button type="button" class="integration-workbench__button" data-testid="connect-new-system" @click="showConnectionGuide">
            连接新系统
          </button>
          <button type="button" class="integration-workbench__button" data-testid="show-sql-setup" @click="showSqlSetup">
            查看 SQL / 高级连接
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
          <div v-if="systems.length === 0" class="integration-workbench__empty">暂无连接。请使用 K3 WISE 预设或后续连接向导创建。</div>
          <ul v-else class="integration-workbench__inventory-list">
            <li v-for="system in systems" :key="system.id">
              <strong>{{ system.name }}</strong>
              <span>{{ system.kind }} · {{ system.role }} · {{ connectionStatusLabel(system) }}</span>
              <small v-if="runtimeBlockerForSystem(system)">{{ runtimeBlockerForSystem(system) }}</small>
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
      <div class="integration-workbench__grid integration-workbench__grid--systems">
        <div class="integration-workbench__system-column">
          <h2>数据源</h2>
          <label>
            <span>数据源系统</span>
            <select v-model="sourceSystemId" data-testid="source-system">
              <option value="">请选择数据源系统</option>
              <option v-for="system in sourceSystems" :key="system.id" :value="system.id">
                {{ system.name }} · {{ system.kind }}
              </option>
            </select>
          </label>
          <div v-if="sourceSystems.length === 0" class="integration-workbench__empty integration-workbench__empty--actionable" data-testid="source-empty-state">
            <strong>还没有可读取的数据源。</strong>
            <p>连接 PLM、HTTP API 或启用 SQL 只读通道后，可将数据导入 staging 多维表再清洗。</p>
            <div class="integration-workbench__actions">
              <router-link class="integration-workbench__button" to="/integrations/k3-wise">使用 K3 WISE 预设</router-link>
              <button type="button" class="integration-workbench__button" @click="showSqlSetup">启用 SQL 只读通道</button>
            </div>
          </div>
          <div v-if="sourceRuntimeBlocker" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="source-runtime-blocker">
            {{ sourceRuntimeBlocker }}
          </div>
          <div class="integration-workbench__connection-row">
            <span class="integration-workbench__badge" :data-status="sourceConnectionStatus">{{ sourceConnectionLabel }}</span>
            <button type="button" class="integration-workbench__button" data-testid="test-source-system" @click="testSystem('source')">
              测试来源连接
            </button>
            <button type="button" class="integration-workbench__button" data-testid="load-source-objects" @click="loadObjects('source')">
              加载来源数据集
            </button>
          </div>
          <label>
            <span>来源数据集</span>
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
          <h2>目标</h2>
          <label>
            <span>目标系统</span>
            <select v-model="targetSystemId" data-testid="target-system">
              <option value="">请选择目标系统</option>
              <option v-for="system in targetSystems" :key="system.id" :value="system.id">
                {{ system.name }} · {{ system.kind }}
              </option>
            </select>
          </label>
          <div class="integration-workbench__connection-row">
            <span class="integration-workbench__badge" :data-status="targetConnectionStatus">{{ targetConnectionLabel }}</span>
            <button type="button" class="integration-workbench__button" data-testid="test-target-system" @click="testSystem('target')">
              测试目标连接
            </button>
            <button type="button" class="integration-workbench__button" data-testid="load-target-objects" @click="loadObjects('target')">
              加载目标数据集
            </button>
          </div>
          <label>
            <span>目标数据集 / 模板</span>
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
              打开多维表
            </a>
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
        </article>
      </div>
      <div v-else class="integration-workbench__empty" data-testid="staging-empty">
        暂未加载 staging 契约。可先刷新连接，或填写 Project ID 后创建清洗表。
      </div>

      <div class="integration-workbench__grid integration-workbench__grid--compact">
        <label>
          <span>Project ID（创建清洗表时必填）</span>
          <input v-model="stagingProjectId" data-testid="staging-project-id" placeholder="例如 project_default" />
        </label>
        <label>
          <span>Base ID（可选）</span>
          <input v-model="stagingBaseId" data-testid="staging-base-id" placeholder="留空使用默认 base" />
        </label>
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
          <p>这里只允许白名单转换函数；复杂逻辑应进入 adapter 或后端模板，而不是用户脚本。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="add-mapping" @click="addMapping">
          新增映射
        </button>
      </div>

      <table class="integration-workbench__mapping-table">
        <thead>
          <tr>
            <th>源字段</th>
            <th>目标字段</th>
            <th>转换</th>
            <th>校验</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(mapping, index) in mappings" :key="mapping.id">
            <td><input v-model="mapping.sourceField" :data-testid="`source-field-${index}`" /></td>
            <td><input v-model="mapping.targetField" :data-testid="`target-field-${index}`" /></td>
            <td>
              <select v-model="mapping.transformFn" :data-testid="`transform-fn-${index}`">
                <option v-for="option in transformOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <textarea
                v-if="mapping.transformFn === 'dictMap'"
                v-model="mapping.dictMapText"
                :data-testid="`dict-map-${index}`"
                placeholder="EA=Pcs&#10;KG=Kg"
              ></textarea>
            </td>
            <td>
              <label class="integration-workbench__mapping-check">
                <input v-model="mapping.required" type="checkbox" :data-testid="`required-${index}`" />
                <span>必填</span>
              </label>
              <div class="integration-workbench__mapping-rules">
                <input v-model="mapping.minValueText" :data-testid="`validation-min-${index}`" placeholder="min" />
                <input v-model="mapping.maxValueText" :data-testid="`validation-max-${index}`" placeholder="max" />
              </div>
            </td>
            <td>
              <button type="button" class="integration-workbench__icon-button" @click="removeMapping(index)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>Pipeline 执行</h2>
          <p>先保存 pipeline，再 dry-run。Save-only 推送必须显式勾选，默认不会 Submit / Audit。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="save-pipeline" :disabled="savingPipeline" @click="savePipeline">
          {{ savingPipeline ? '保存中' : '保存 Pipeline' }}
        </button>
      </div>

      <div class="integration-workbench__grid">
        <label>
          <span>Pipeline 名称</span>
          <input v-model="pipelineName" data-testid="pipeline-name" placeholder="例如 PLM material to K3 material" />
        </label>
        <label>
          <span>Pipeline 模式</span>
          <select v-model="pipelineMode" data-testid="pipeline-mode">
            <option value="manual">manual</option>
            <option value="incremental">incremental</option>
            <option value="full">full</option>
          </select>
        </label>
        <label>
          <span>幂等字段</span>
          <input v-model="idempotencyFieldsText" data-testid="idempotency-fields" placeholder="code 或 sourceId,revision" />
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
          <span>已保存 Pipeline ID</span>
          <input v-model="savedPipelineId" data-testid="pipeline-id" placeholder="保存后自动回填，也可粘贴已有 ID" />
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

      <label class="integration-workbench__inline-check">
        <input v-model="allowSaveOnlyRun" type="checkbox" data-testid="allow-save-only-run" />
        <span>允许本次 Save-only 推送。保持 Submit / Audit 关闭。</span>
      </label>

      <div class="integration-workbench__readiness" data-testid="pipeline-readiness">
        <div>
          <strong>Dry-run 前置条件</strong>
          <p>{{ dryRunBlockedSummary }}</p>
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
        <button type="button" class="integration-workbench__button" data-testid="run-dry-run" :disabled="runningPipeline !== '' || !canRunDryRun" @click="executePipeline(true)">
          {{ runningPipeline === 'dry-run' ? 'Dry-run 中' : 'Dry-run' }}
        </button>
        <button type="button" class="integration-workbench__button integration-workbench__button--danger" data-testid="run-save-only" :disabled="runningPipeline !== '' || !allowSaveOnlyRun || !canRunDryRun" @click="executePipeline(false)">
          {{ runningPipeline === 'run' ? '推送中' : 'Save-only 推送' }}
        </button>
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
          <h2>运行观察</h2>
          <p>{{ observationSummary }}。这里显示最近 5 条 run 和 open dead letters，便于清洗后回看失败原因。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="refresh-observation" :disabled="observingPipeline" @click="refreshPipelineObservation(false)">
          {{ observingPipeline ? '刷新中' : '刷新观察' }}
        </button>
      </div>

      <div class="integration-workbench__observation">
        <div>
          <h3>最近运行</h3>
          <div v-if="pipelineRuns.length === 0" class="integration-workbench__empty">暂无运行记录。</div>
          <ol v-else class="integration-workbench__record-list" data-testid="pipeline-runs">
            <li v-for="run in pipelineRuns" :key="run.id">
              <strong>{{ run.status }}</strong>
              <span>{{ run.mode }}</span>
              <span>read {{ run.rowsRead }} / clean {{ run.rowsCleaned }} / write {{ run.rowsWritten }} / fail {{ run.rowsFailed }}</span>
              <small>{{ run.startedAt || run.createdAt || run.id }}</small>
            </li>
          </ol>
        </div>
        <div>
          <h3>Open Dead Letters</h3>
          <div v-if="deadLetters.length === 0" class="integration-workbench__empty">暂无 open dead letters。</div>
          <ol v-else class="integration-workbench__record-list" data-testid="dead-letters">
            <li v-for="deadLetter in deadLetters" :key="deadLetter.id">
              <strong>{{ deadLetter.errorCode }}</strong>
              <span>{{ deadLetter.errorMessage }}</span>
              <small>{{ deadLetter.status }} · {{ deadLetter.createdAt || deadLetter.id }}</small>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <section class="integration-workbench__panel integration-workbench__preview">
      <div>
        <h2>样例记录</h2>
        <textarea v-model="sampleRecordText" data-testid="sample-record" spellcheck="false"></textarea>
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
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { buildXlsxBuffer } from '../multitable/import/xlsx-mapping'
import {
  canReadFromSystem,
  canWriteToSystem,
  getDefaultIntegrationScope,
  getExternalSystemSchema,
  installIntegrationStaging,
  listIntegrationDeadLetters,
  listIntegrationPipelineRuns,
  listIntegrationStagingDescriptors,
  listExternalSystemObjects,
  listIntegrationAdapters,
  listWorkbenchExternalSystems,
  previewIntegrationTemplate,
  runIntegrationPipeline,
  testExternalSystemConnection,
  upsertWorkbenchExternalSystem,
  upsertIntegrationPipeline,
  type IntegrationAdapterMetadata,
  type IntegrationFieldMapping,
  type IntegrationObjectSchema,
  type IntegrationObjectSchemaField,
  type IntegrationDeadLetter,
  type IntegrationPipelineMode,
  type IntegrationPipelineRun,
  type IntegrationPipelineRunResult,
  type IntegrationStagingDescriptor,
  type IntegrationStagingInstallResult,
  type IntegrationStagingOpenTarget,
  type IntegrationSystemObject,
  type WorkbenchExternalSystem,
} from '../services/integration/workbench'

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

type ExportCell = string | number | boolean | null
type ExportRow = Record<string, ExportCell>

const flowSteps = [
  { title: '1. 连接系统', description: '接入 CRM / PLM / ERP / SRM / HTTP / SQL' },
  { title: '2. 选择数据集', description: '选择来源对象、清洗表和目标模板' },
  { title: '3. 多维表清洗', description: '业务人员在表格里修正、审核、补字段' },
  { title: '4. Dry-run / 推送', description: '预览 payload 后导出或 Save-only 写回' },
]

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
const pipelineResultText = ref('尚未执行')
const lastDryRunResult = ref<IntegrationPipelineRunResult | null>(null)
const pipelineRuns = ref<IntegrationPipelineRun[]>([])
const deadLetters = ref<IntegrationDeadLetter[]>([])
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

const adapterMetadataByKind = computed(() => new Map(adapters.value.map((adapter) => [adapter.kind, adapter])))
const inventorySummary = computed(() => `已加载 ${systems.value.length} 个连接 · ${adapters.value.length} 个适配器 · ${stagingDescriptors.value.length} 个 staging 表`)
const visibleAdapters = computed(() => adapters.value.filter((adapter) => showAdvancedConnectors.value || !adapter.advanced))
const hiddenAdvancedSystemCount = computed(() => systems.value.filter((system) => isAdvancedSystem(system)).length)
const visibleSystems = computed(() => systems.value.filter((system) => showAdvancedConnectors.value || !isAdvancedSystem(system)))
const sourceSystems = computed(() => visibleSystems.value.filter(canReadFromSystem))
const targetSystems = computed(() => visibleSystems.value.filter(canWriteToSystem))
const selectedTargetObject = computed(() => targetObjects.value.find((object) => object.name === targetObjectName.value) || null)
const selectedSourceSystem = computed(() => systems.value.find((system) => system.id === sourceSystemId.value) || null)
const selectedTargetSystem = computed(() => systems.value.find((system) => system.id === targetSystemId.value) || null)
const selectedStagingDescriptor = computed(() => stagingDescriptors.value.find((descriptor) => descriptor.id === stagingSheetId.value) || null)
const sourceConnectionStatus = computed(() => selectedSourceSystem.value?.status || 'inactive')
const targetConnectionStatus = computed(() => selectedTargetSystem.value?.status || 'inactive')
const sourceConnectionLabel = computed(() => connectionStatusLabel(selectedSourceSystem.value))
const targetConnectionLabel = computed(() => connectionStatusLabel(selectedTargetSystem.value))
const sourceRuntimeBlocker = computed(() => runtimeBlockerForSystem(selectedSourceSystem.value))
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
const cleansedExportSummary = computed(() => {
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
const hasMappingRules = computed(() => mappings.value.some((mapping) => mapping.sourceField.trim() && mapping.targetField.trim()))
const hasIdempotencyFields = computed(() => parseList(idempotencyFieldsText.value).length > 0)
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
    detail: sourceObjectName.value || '加载来源数据集后才能保存 pipeline。',
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
    detail: targetObjectName.value || '加载目标数据集后才能生成 payload 或保存 pipeline。',
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
const canRunDryRun = computed(() => dryRunReadinessItems.value.every((item) => item.ready))
const dryRunBlockedSummary = computed(() => {
  const missing = dryRunReadinessItems.value.filter((item) => !item.ready)
  if (missing.length === 0) return '已满足 dry-run 前置条件。Dry-run 只生成 preview，不写外部系统。'
  return `还缺 ${missing.length} 项：${missing.map((item) => item.label).join('、')}`
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

function runtimeBlockerForSystem(system: WorkbenchExternalSystem | null): string {
  if (!system) return ''
  const errorText = system.lastError || ''
  if (system.kind === 'erp:k3-wise-sqlserver' && /queryExecutor|executor|injected|注入|执行器/i.test(errorText)) {
    return 'SQL 连接已配置，但当前部署未注入 SQL 执行器；可保留为高级连接，暂不能作为可读 source 执行 dry-run。'
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
  setStatus('连接新系统第一步：优先使用 K3 WISE 预设；PLM/HTTP/SQL 连接向导会在后续版本补齐。', 'idle')
}

function showSqlSetup(): void {
  showAdvancedConnectors.value = true
  inventoryExpanded.value = true
  setStatus('已显示 SQL / 高级连接。SQL source 需要部署 allowlist queryExecutor 后才能读取。', 'idle')
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
  if (sourceSystemId.value && !sourceSystems.value.some((system) => system.id === sourceSystemId.value)) {
    sourceSystemId.value = sourceSystems.value[0]?.id || ''
  }
  if (targetSystemId.value && !targetSystems.value.some((system) => system.id === targetSystemId.value)) {
    targetSystemId.value = targetSystems.value[0]?.id || ''
  }
  if (!sourceSystemId.value) sourceSystemId.value = sourceSystems.value[0]?.id || ''
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
    systems.value = systemList
    stagingDescriptors.value = descriptorList
    normalizeSystemSelections()
    if (!stagingSheetId.value) stagingSheetId.value = descriptorList.find((descriptor) => descriptor.id === 'standard_materials')?.id || descriptorList[0]?.id || ''
    setStatus(`已加载 ${systemList.length} 个连接、${adapterList.length} 个适配器和 ${descriptorList.length} 个 staging 表`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

function connectionStatusLabel(system: WorkbenchExternalSystem | null): string {
  if (!system) return '未选择'
  if (system.status === 'active') return system.lastTestedAt ? '已连接' : '可用'
  if (system.status === 'error') return system.lastError ? `异常：${system.lastError}` : '异常'
  return '未启用'
}

function replaceSystem(updated: WorkbenchExternalSystem): void {
  const index = systems.value.findIndex((system) => system.id === updated.id)
  if (index >= 0) {
    systems.value.splice(index, 1, updated)
  } else {
    systems.value.push(updated)
  }
}

async function testSystem(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  if (!systemId) {
    setStatus(`${side === 'source' ? '数据源' : '目标'}系统未选择`, 'error')
    return
  }
  try {
    const result = await testExternalSystemConnection(systemId, currentScope())
    if (result.system) replaceSystem(result.system)
    const label = side === 'source' ? '数据源' : '目标'
    setStatus(result.ok ? `${label}连接测试通过` : `${label}连接测试失败：${result.message || result.code || 'unknown error'}`, result.ok ? 'success' : 'error')
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
  const projectId = stagingProjectId.value.trim()
  if (!projectId) {
    setStatus('创建清洗表前请填写 Project ID', 'error')
    return
  }
  installingStaging.value = true
  stagingInstallResultText.value = ''
  try {
    const result = await installIntegrationStaging({
      ...currentScope(),
      projectId,
      baseId: stagingBaseId.value.trim() || null,
    })
    stagingOpenTargets.value = normalizeStagingOpenTargets(result)
    stagingInstallResultText.value = JSON.stringify({
      sheetIds: result.sheetIds,
      viewIds: result.viewIds || {},
      targets: stagingOpenTargets.value,
      warnings: result.warnings,
    }, null, 2)
    await refreshBootstrap()
    setStatus(result.warnings.length > 0 ? `清洗表已创建，存在 ${result.warnings.length} 条警告` : '清洗表已创建，可打开多维表处理数据', result.warnings.length > 0 ? 'idle' : 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    installingStaging.value = false
  }
}

async function useStagingAsSource(objectId: string): Promise<void> {
  const descriptor = stagingDescriptors.value.find((item) => item.id === objectId) || null
  const target = stagingOpenTargetById.value.get(objectId)
  if (!descriptor || !target?.sheetId) {
    setStatus('请先创建清洗表，确认该 staging 表已有 sheetId / open link 后再作为来源。', 'error')
    return
  }
  const projectId = stagingProjectId.value.trim() || 'default'
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
    setStatus(`已将 ${stagingDatasetCopy[objectId]?.name || descriptor.name} 设为 Dry-run 来源`, 'success')
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
  const projectId = stagingProjectId.value.trim() || 'default'
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
    setStatus(dryRun ? 'Dry-run 已提交' : 'Save-only 推送已提交', 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    runningPipeline.value = ''
  }
}

async function previewPayload(): Promise<void> {
  try {
    const sourceRecord = JSON.parse(sampleRecordText.value) as Record<string, unknown>
    const template = selectedTemplateMeta()
    const result = await previewIntegrationTemplate({
      sourceRecord,
      fieldMappings: buildMappings(),
      template: {
        id: typeof template.id === 'string' ? template.id : targetObjectName.value,
        version: typeof template.version === 'string' ? template.version : undefined,
        documentType: typeof template.documentType === 'string' ? template.documentType : targetObjectName.value,
        bodyKey: typeof template.bodyKey === 'string' ? template.bodyKey : 'Data',
        endpointPath: typeof template.endpointPath === 'string' ? template.endpointPath : undefined,
        schema: targetSchema.value.fields,
      },
    })
    previewText.value = JSON.stringify(result, null, 2)
    setStatus(result.valid ? 'Payload 预览通过' : `Payload 预览发现 ${result.errors.length} 个问题`, result.valid ? 'success' : 'error')
  } catch (error) {
    previewText.value = '预览失败'
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

onMounted(() => {
  void refreshBootstrap()
})

watch(showAdvancedConnectors, () => {
  normalizeSystemSelections()
})
</script>

<style scoped>
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
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
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

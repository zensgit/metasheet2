<template>
  <section class="k3-setup" data-testid="k3-wise-setup">
    <header class="k3-setup__header">
      <div>
        <p class="k3-setup__eyebrow">ERP Integration</p>
        <h1>K3 WISE 对接配置</h1>
        <p class="k3-setup__lead">先接通 K3 WISE，再把 PLM 数据放进多维表清洗，最后 dry-run 后推送 ERP。</p>
      </div>
      <div class="k3-setup__header-actions">
        <button class="k3-setup__btn" type="button" :disabled="loading" @click="loadSystems">
          {{ loading ? '刷新中' : '刷新' }}
        </button>
        <button class="k3-setup__btn k3-setup__btn--primary" type="button" :disabled="saving" @click="saveConfiguration">
          {{ saving ? '保存中' : '保存配置' }}
        </button>
      </div>
    </header>

    <p v-if="statusMessage" class="k3-setup__status" :data-kind="statusKind">{{ statusMessage }}</p>

    <nav class="k3-setup__journey" aria-label="K3 WISE setup path">
      <div class="k3-setup__journey-step">
        <strong>1. 接通 K3</strong>
        <span>填写地址和授权码</span>
      </div>
      <div class="k3-setup__journey-step">
        <strong>2. 准备多维表</strong>
        <span>安装 staging 表并清洗数据</span>
      </div>
      <div class="k3-setup__journey-step">
        <strong>3. 创建链路</strong>
        <span>生成物料和 BOM pipeline</span>
      </div>
      <div class="k3-setup__journey-step">
        <strong>4. Dry-run 后推送</strong>
        <span>先验证，再打开真实执行</span>
      </div>
    </nav>

    <section class="k3-setup__layout">
      <aside class="k3-setup__rail">
        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>部署测试准备</h2>
            <span>{{ deployGateSummary.ready }}/{{ deployGateChecklist.length }} ready</span>
          </div>
          <div class="k3-setup__gate-summary">
            <span class="k3-setup__badge" data-status="succeeded">ready {{ deployGateSummary.ready }}</span>
            <span v-if="deployGateSummary.missing" class="k3-setup__badge" data-status="failed">missing {{ deployGateSummary.missing }}</span>
            <span v-if="deployGateSummary.external" class="k3-setup__badge" data-status="open">external {{ deployGateSummary.external }}</span>
            <span v-if="deployGateSummary.warning" class="k3-setup__badge" data-status="partial">warning {{ deployGateSummary.warning }}</span>
          </div>
          <div class="k3-setup__gate-list">
            <div v-for="item in deployGateChecklist" :key="item.id" class="k3-setup__gate-item">
              <div class="k3-setup__record-main">
                <strong>{{ item.label }}</strong>
                <span class="k3-setup__badge" :data-status="formatDeployGateStatus(item.status)">{{ item.status }}</span>
              </div>
              <small>{{ item.message }}</small>
            </div>
          </div>
        </div>

        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>已保存系统</h2>
            <span>{{ webApiSystems.length + sqlSystems.length }}</span>
          </div>
          <div v-if="loading" class="k3-setup__empty">Loading...</div>
          <div v-else-if="webApiSystems.length + sqlSystems.length === 0" class="k3-setup__empty">暂无 K3 WISE 系统。</div>
          <div v-else class="k3-setup__saved-list">
            <button
              v-for="system in savedSystems"
              :key="system.id"
              class="k3-setup__saved"
              type="button"
              @click="loadSystemIntoForm(system)"
            >
              <span>{{ system.name }}</span>
              <small>{{ system.kind }} · {{ system.status }}</small>
              <small v-if="system.lastTestedAt">Last test: {{ formatTimestamp(system.lastTestedAt) }}</small>
              <small v-if="system.lastError" class="k3-setup__saved-error">{{ system.lastError }}</small>
            </button>
          </div>
        </div>

        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>连接测试</h2>
          </div>
          <div class="k3-setup__connection-state">
            <div class="k3-setup__record-main">
              <strong>WebAPI 状态</strong>
              <span class="k3-setup__badge" :data-status="webApiConnectionStatus.status">
                {{ webApiConnectionStatus.label }}
              </span>
            </div>
            <small>{{ webApiConnectionStatus.message }}</small>
          </div>
          <button class="k3-setup__btn k3-setup__btn--full" type="button" :disabled="testingWebApi || !form.webApiSystemId" @click="testWebApi">
            {{ testingWebApi ? '测试中' : '测试 WebAPI' }}
          </button>
          <p class="k3-setup__field-note">
            先保存配置，再测试 WebAPI；测试通过后这里会显示已连接和最近测试时间。
          </p>
          <button class="k3-setup__btn k3-setup__btn--full" type="button" :disabled="testingSql || !form.sqlSystemId" @click="testSqlServer">
            {{ testingSql ? '测试中' : '测试 SQL Server' }}
          </button>
          <pre v-if="testResult" class="k3-setup__test-result">{{ testResult }}</pre>
        </div>

        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>清洗链路</h2>
            <span>{{ stagingDescriptorLabel }}</span>
          </div>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="loadingStagingDescriptors"
            @click="loadStagingDescriptors(false)"
          >
            {{ loadingStagingDescriptors ? '刷新中' : '刷新 Staging 契约' }}
          </button>
          <div v-if="stagingDescriptors.length" class="k3-setup__descriptor-list">
            <div v-for="descriptor in stagingDescriptors" :key="descriptor.id" class="k3-setup__descriptor">
              <div class="k3-setup__record-main">
                <strong>{{ descriptor.name }}</strong>
                <span class="k3-setup__badge">{{ getIntegrationStagingFieldCount(descriptor) }} fields</span>
              </div>
              <small>{{ descriptor.id }}</small>
              <small>{{ formatIntegrationStagingDescriptorFieldSummary(descriptor) }}</small>
            </div>
          </div>
          <div v-else class="k3-setup__empty">未加载 Staging 契约。</div>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="installingStaging || stagingIssues.length > 0"
            @click="installStagingTables"
          >
            {{ installingStaging ? '安装中' : '安装 Staging 多维表' }}
          </button>
          <ul v-if="stagingIssues.length" class="k3-setup__issues k3-setup__issues--compact">
            <li v-for="issue in stagingIssues" :key="`staging:${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
          <pre v-if="stagingResult" class="k3-setup__test-result">{{ stagingResult }}</pre>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="creatingPipelines || pipelineIssues.length > 0"
            @click="createPipelineTemplates"
          >
            {{ creatingPipelines ? '创建中' : '创建清洗 Pipeline' }}
          </button>
          <ul v-if="pipelineIssues.length" class="k3-setup__issues k3-setup__issues--compact">
            <li v-for="issue in pipelineIssues" :key="`pipeline:${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
          <pre v-if="pipelineResult" class="k3-setup__test-result">{{ pipelineResult }}</pre>
        </div>

        <details class="k3-setup__panel k3-setup__collapsible-panel">
          <summary class="k3-setup__panel-summary">
            <span>执行 Pipeline</span>
            <small>{{ form.allowLivePipelineRun ? 'run enabled' : 'dry-run first' }}</small>
          </summary>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="isPipelineRunDisabled('material', true)"
            @click="executePipeline('material', true)"
          >
            {{ runningPipeline === 'material:dry-run' ? 'Dry-run 中' : 'Dry-run 物料' }}
          </button>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="isPipelineRunDisabled('material', false)"
            @click="executePipeline('material', false)"
          >
            {{ runningPipeline === 'material:run' ? '执行中' : '执行物料' }}
          </button>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="isPipelineRunDisabled('bom', true)"
            @click="executePipeline('bom', true)"
          >
            {{ runningPipeline === 'bom:dry-run' ? 'Dry-run 中' : 'Dry-run BOM' }}
          </button>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="isPipelineRunDisabled('bom', false)"
            @click="executePipeline('bom', false)"
          >
            {{ runningPipeline === 'bom:run' ? '执行中' : '执行 BOM' }}
          </button>
          <ul v-if="materialRunIssues.length || bomRunIssues.length" class="k3-setup__issues k3-setup__issues--compact">
            <li v-for="issue in [...materialRunIssues, ...bomRunIssues]" :key="`run:${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
          <pre v-if="pipelineRunResult" class="k3-setup__test-result">{{ pipelineRunResult }}</pre>
        </details>

        <details class="k3-setup__panel k3-setup__collapsible-panel">
          <summary class="k3-setup__panel-summary">
            <span>运行观察</span>
            <small>{{ observationSummary }}</small>
          </summary>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="isPipelineObservationDisabled('material')"
            @click="refreshPipelineObservation('material')"
          >
            {{ observingPipeline === 'material' ? '刷新中' : '刷新物料状态' }}
          </button>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="isPipelineObservationDisabled('bom')"
            @click="refreshPipelineObservation('bom')"
          >
            {{ observingPipeline === 'bom' ? '刷新中' : '刷新 BOM 状态' }}
          </button>

          <div class="k3-setup__records">
            <div class="k3-setup__record-head">
              <span>最近运行</span>
              <small>{{ observedPipelineTarget }}</small>
            </div>
            <div v-if="pipelineRuns.length === 0" class="k3-setup__empty">暂无运行记录。</div>
            <template v-else>
              <div v-for="run in pipelineRuns" :key="run.id" class="k3-setup__record">
                <div class="k3-setup__record-main">
                  <strong>{{ run.id }}</strong>
                  <span class="k3-setup__badge" :data-status="run.status">{{ run.status }}</span>
                </div>
                <small>{{ formatRunMetrics(run) }}</small>
                <small>{{ formatTimestamp(run.startedAt || run.createdAt || '') }}</small>
                <small v-if="run.errorSummary" class="k3-setup__saved-error">{{ run.errorSummary }}</small>
              </div>
            </template>
          </div>

          <div class="k3-setup__records">
            <div class="k3-setup__record-head">
              <span>Open Dead Letters</span>
              <small>{{ deadLetters.length }}</small>
            </div>
            <div v-if="deadLetters.length === 0" class="k3-setup__empty">暂无 open dead letters。</div>
            <template v-else>
              <div v-for="deadLetter in deadLetters" :key="deadLetter.id" class="k3-setup__record">
                <div class="k3-setup__record-main">
                  <strong>{{ deadLetter.errorCode }}</strong>
                  <span class="k3-setup__badge" :data-status="deadLetter.status">{{ deadLetter.status }}</span>
                </div>
                <small>{{ deadLetter.id }} · retry {{ deadLetter.retryCount }}</small>
                <small class="k3-setup__saved-error">{{ deadLetter.errorMessage }}</small>
                <small v-if="deadLetter.payloadRedacted">payload redacted</small>
              </div>
            </template>
          </div>
        </details>
      </aside>

      <form class="k3-setup__form" @submit.prevent="saveConfiguration">
        <section class="k3-setup__section k3-setup__section--primary">
          <div class="k3-setup__section-head">
            <h2>基础连接</h2>
            <span>首次部署只需先完成这些字段</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Tenant ID（作用域）</span>
              <input v-model.trim="form.tenantId" placeholder="default" autocomplete="off" />
              <small>单租户实体机测试使用 default；它不是 K3 账套号。</small>
            </label>
            <label class="k3-setup__field">
              <span>Workspace ID（可选）</span>
              <input v-model.trim="form.workspaceId" autocomplete="off" />
              <small>单工作区 PoC 建议留空；需要多工作区隔离时再填真实 ID。</small>
            </label>
            <label class="k3-setup__field">
              <span>系统名称</span>
              <input v-model.trim="form.webApiName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>K3 WISE 版本</span>
              <input v-model.trim="form.version" placeholder="K3 WISE 15.x test" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>环境</span>
              <select v-model="form.environment">
                <option value="test">test</option>
                <option value="uat">uat</option>
                <option value="staging">staging</option>
                <option value="production">production</option>
                <option value="other">other</option>
              </select>
            </label>
            <label class="k3-setup__field k3-setup__field--wide">
              <span>WebAPI Base URL</span>
              <input v-model.trim="form.baseUrl" placeholder="http://k3-server:port" autocomplete="off" />
              <small>只填协议、主机和端口；不要带 /K3API，下面的路径已包含 /K3API。</small>
              <small v-if="baseUrlHasK3ApiPath" class="k3-setup__hint-warning">
                当前 Base URL 含 /K3API；建议改为只到主机端口，保留高级路径的 /K3API/... 默认值。
              </small>
            </label>
            <label class="k3-setup__field">
              <span>认证模式</span>
              <select v-model="form.webApiAuthMode">
                <option value="authority-code">授权码 Token</option>
                <option value="login">账套登录</option>
              </select>
            </label>
            <label v-if="form.webApiAuthMode === 'authority-code'" class="k3-setup__field k3-setup__field--wide">
              <span>授权码</span>
              <input v-model="form.authorityCode" type="password" autocomplete="new-password" />
              <small>只用于保存凭据，不会回显。</small>
            </label>
            <label v-if="form.webApiAuthMode === 'login'" class="k3-setup__field">
              <span>Acct ID</span>
              <input v-model.trim="form.acctId" autocomplete="off" />
            </label>
            <label v-if="form.webApiAuthMode === 'login'" class="k3-setup__field">
              <span>用户名</span>
              <input v-model.trim="form.username" autocomplete="off" />
            </label>
            <label v-if="form.webApiAuthMode === 'login'" class="k3-setup__field">
              <span>密码</span>
              <input v-model="form.password" type="password" autocomplete="new-password" />
            </label>
            <p v-if="form.webApiHasCredentials" class="k3-setup__field-note k3-setup__field-note--wide">
              已保存凭据会保留；留空不会清除旧凭据。
            </p>
          </div>
        </section>

        <details class="k3-setup__section k3-setup__details">
          <summary class="k3-setup__section-summary">
            <span>高级 WebAPI 设置</span>
            <small>路径、语言、超时和 Submit/Audit 策略；默认值通常可直接使用</small>
          </summary>
          <p class="k3-setup__field-note k3-setup__field-note--wide">
            这些路径会相对 WebAPI Base URL 请求。实体机 PoC 推荐 Base URL 只写 http://K3主机:端口，Token/Save/BOM 路径保留 /K3API/...。
          </p>
          <div class="k3-setup__grid">
            <label v-if="form.webApiAuthMode === 'authority-code'" class="k3-setup__field">
              <span>Token Path</span>
              <input v-model.trim="form.tokenPath" autocomplete="off" />
            </label>
            <label v-if="form.webApiAuthMode === 'login'" class="k3-setup__field">
              <span>Login Path</span>
              <input v-model.trim="form.loginPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Health Path</span>
              <input v-model.trim="form.healthPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>LCID</span>
              <input v-model.trim="form.lcid" inputmode="numeric" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Timeout ms</span>
              <input v-model.trim="form.timeoutMs" inputmode="numeric" autocomplete="off" />
            </label>
            <label class="k3-setup__check">
              <input v-model="form.autoSubmit" type="checkbox" />
              <span>Save 后自动 Submit</span>
            </label>
            <label class="k3-setup__check">
              <input v-model="form.autoAudit" type="checkbox" />
              <span>Submit 后自动 Audit</span>
            </label>
            <label class="k3-setup__field">
              <span>Material Save</span>
              <input v-model.trim="form.materialSavePath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Material Submit</span>
              <input v-model.trim="form.materialSubmitPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Material Audit</span>
              <input v-model.trim="form.materialAuditPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Save</span>
              <input v-model.trim="form.bomSavePath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Submit</span>
              <input v-model.trim="form.bomSubmitPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Audit</span>
              <input v-model.trim="form.bomAuditPath" autocomplete="off" />
            </label>
          </div>
        </details>

        <details class="k3-setup__section k3-setup__details">
          <summary class="k3-setup__section-summary">
            <span>SQL Server 通道</span>
            <small>默认关闭；需要读取 K3 表或写中间表时再启用</small>
          </summary>
          <div class="k3-setup__details-toolbar">
            <label class="k3-setup__switch">
              <input v-model="form.sqlEnabled" type="checkbox" />
              <span>{{ form.sqlEnabled ? '启用' : '关闭' }}</span>
            </label>
          </div>
          <div v-if="form.sqlEnabled" class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>名称</span>
              <input v-model.trim="form.sqlName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>模式</span>
              <select v-model="form.sqlMode">
                <option value="readonly">readonly</option>
                <option value="middle-table">middle-table</option>
                <option value="stored-procedure">stored-procedure</option>
              </select>
            </label>
            <label class="k3-setup__field">
              <span>Server</span>
              <input v-model.trim="form.sqlServer" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Database</span>
              <input v-model.trim="form.sqlDatabase" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>SQL 用户名</span>
              <input v-model.trim="form.sqlUsername" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>SQL 密码</span>
              <input v-model="form.sqlPassword" type="password" autocomplete="new-password" />
            </label>
            <label class="k3-setup__field k3-setup__field--wide">
              <span>允许读取表</span>
              <textarea v-model="form.sqlAllowedTables" rows="4" spellcheck="false" />
            </label>
            <label class="k3-setup__field">
              <span>中间表</span>
              <textarea v-model="form.sqlMiddleTables" rows="4" spellcheck="false" />
            </label>
            <label class="k3-setup__field">
              <span>存储过程</span>
              <textarea v-model="form.sqlStoredProcedures" rows="4" spellcheck="false" />
            </label>
          </div>
        </details>

        <section v-if="validationIssues.length" class="k3-setup__section k3-setup__section--issues">
          <div class="k3-setup__section-head">
            <h2>待补字段</h2>
            <span>{{ validationIssues.length }}</span>
          </div>
          <ul class="k3-setup__issues">
            <li v-for="issue in validationIssues" :key="`${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
        </section>

        <section class="k3-setup__section k3-setup__section--primary">
          <div class="k3-setup__section-head">
            <h2>多维表清洗准备</h2>
            <span>PLM 数据先进入 staging 多维表</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Project ID</span>
              <input v-model.trim="form.projectId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Base ID</span>
              <input v-model.trim="form.baseId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM Source System ID</span>
              <input v-model.trim="form.sourceSystemId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>K3 Target System ID</span>
              <input v-model.trim="form.webApiSystemId" autocomplete="off" readonly />
            </label>
            <label class="k3-setup__field">
              <span>物料 Pipeline 名称</span>
              <input v-model.trim="form.materialPipelineName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>物料 Staging 对象</span>
              <select v-if="stagingDescriptors.length" v-model="form.materialStagingObjectId">
                <option v-for="descriptor in stagingDescriptors" :key="`material:${descriptor.id}`" :value="descriptor.id">
                  {{ descriptor.id }}
                </option>
              </select>
              <input v-else v-model.trim="form.materialStagingObjectId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Pipeline 名称</span>
              <input v-model.trim="form.bomPipelineName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Staging 对象</span>
              <select v-if="stagingDescriptors.length" v-model="form.bomStagingObjectId">
                <option v-for="descriptor in stagingDescriptors" :key="`bom:${descriptor.id}`" :value="descriptor.id">
                  {{ descriptor.id }}
                </option>
              </select>
              <input v-else v-model.trim="form.bomStagingObjectId" autocomplete="off" />
            </label>
          </div>
        </section>

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>K3 单据模板</h2>
            <span>表单映射生成 K3 Data JSON</span>
          </div>
          <div class="k3-setup__template-grid">
            <article v-for="template in documentTemplates" :key="template.id" class="k3-setup__template-card">
              <div class="k3-setup__record-main">
                <strong>{{ template.label }}</strong>
                <span class="k3-setup__badge" data-status="succeeded">{{ template.documentType }}</span>
              </div>
              <small>{{ template.id }} · {{ template.version }}</small>
              <table class="k3-setup__mapping-table">
                <thead>
                  <tr>
                    <th>PLM 字段</th>
                    <th>K3 字段</th>
                    <th>转换</th>
                    <th>必填</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="mapping in template.fieldMappings" :key="`${template.id}:${mapping.sourceField}:${mapping.targetField}`">
                    <td>{{ mapping.sourceField }}</td>
                    <td>{{ mapping.targetField }}</td>
                    <td>{{ formatTemplateTransform(mapping.transform) }}</td>
                    <td>{{ isTemplateMappingRequired(mapping) ? '是' : '-' }}</td>
                  </tr>
                </tbody>
              </table>
              <button class="k3-setup__btn" type="button" @click="templatePreviewTarget = template.targetObject">
                预览 {{ template.documentType }} JSON
              </button>
            </article>
          </div>
          <div class="k3-setup__preview-head">
            <strong>{{ templatePreviewTarget === 'material' ? '物料' : 'BOM' }} K3 Data JSON 预览</strong>
            <span>不包含授权码、Token 或密码</span>
          </div>
          <pre class="k3-setup__json-preview">{{ templatePreviewJson }}</pre>
        </section>

        <details class="k3-setup__section k3-setup__details">
          <summary class="k3-setup__section-summary">
            <span>Pipeline 执行参数</span>
            <small>创建 pipeline 后会回填 ID；真实执行默认关闭</small>
          </summary>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>物料 Pipeline ID</span>
              <input v-model.trim="form.materialPipelineId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Pipeline ID</span>
              <input v-model.trim="form.bomPipelineId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>执行模式</span>
              <select v-model="form.pipelineRunMode">
                <option value="manual">manual</option>
                <option value="incremental">incremental</option>
                <option value="full">full</option>
              </select>
            </label>
            <label class="k3-setup__field">
              <span>Sample Limit</span>
              <input v-model.trim="form.pipelineSampleLimit" inputmode="numeric" min="1" max="3" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Cursor</span>
              <input v-model.trim="form.pipelineCursor" autocomplete="off" />
            </label>
            <label class="k3-setup__check">
              <input v-model="form.allowLivePipelineRun" type="checkbox" />
              <span>允许真实执行 Pipeline</span>
            </label>
          </div>
        </details>
      </form>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  K3_WISE_SQLSERVER_KIND,
  K3_WISE_WEBAPI_KIND,
  applyExternalSystemToForm,
  buildK3WiseDocumentPayloadPreview,
  buildK3WiseDeployGateChecklist,
  buildK3WisePipelineObservationQuery,
  buildK3WisePipelinePayloads,
  buildK3WisePipelineRunPayload,
  buildK3WiseSetupPayloads,
  buildK3WiseStagingInstallPayload,
  createDefaultK3WiseSetupForm,
  formatIntegrationStagingDescriptorFieldSummary,
  getIntegrationStagingFieldCount,
  getK3WisePipelineId,
  installIntegrationStaging,
  listK3WiseDocumentTemplates,
  listIntegrationDeadLetters,
  listIntegrationPipelineRuns,
  listIntegrationStagingDescriptors,
  listIntegrationSystems,
  runIntegrationPipeline,
  summarizeK3WiseDeployGateChecklist,
  testIntegrationSystem,
  upsertIntegrationPipeline,
  upsertIntegrationSystem,
  validateK3WisePipelineTemplateForm,
  validateK3WisePipelineObservationForm,
  validateK3WisePipelineRunForm,
  validateK3WiseSetupForm,
  validateK3WiseStagingInstallForm,
  type IntegrationDeadLetter,
  type IntegrationExternalSystem,
  type IntegrationPipelineRun,
  type IntegrationStagingDescriptor,
  type K3WiseDocumentTemplateMapping,
  type K3WisePipelineTarget,
} from '../services/integration/k3WiseSetup'

const form = reactive(createDefaultK3WiseSetupForm())
const webApiSystems = ref<IntegrationExternalSystem[]>([])
const sqlSystems = ref<IntegrationExternalSystem[]>([])
const loading = ref(false)
const saving = ref(false)
const testingWebApi = ref(false)
const testingSql = ref(false)
const installingStaging = ref(false)
const creatingPipelines = ref(false)
const runningPipeline = ref('')
const observingPipeline = ref('')
const loadingStagingDescriptors = ref(false)
const observedPipelineTarget = ref<K3WisePipelineTarget>('material')
const statusMessage = ref('')
const statusKind = ref<'info' | 'success' | 'error'>('info')
const testResult = ref('')
const stagingResult = ref('')
const pipelineResult = ref('')
const pipelineRunResult = ref('')
const pipelineRuns = ref<IntegrationPipelineRun[]>([])
const deadLetters = ref<IntegrationDeadLetter[]>([])
const stagingDescriptors = ref<IntegrationStagingDescriptor[]>([])
const templatePreviewTarget = ref<K3WisePipelineTarget>('material')

const savedSystems = computed(() => [...webApiSystems.value, ...sqlSystems.value])
const documentTemplates = listK3WiseDocumentTemplates()
const validationIssues = computed(() => validateK3WiseSetupForm(form))
const stagingIssues = computed(() => validateK3WiseStagingInstallForm(form))
const pipelineIssues = computed(() => validateK3WisePipelineTemplateForm(form, stagingDescriptors.value))
const materialRunIssues = computed(() => validateK3WisePipelineRunForm(form, 'material'))
const bomRunIssues = computed(() => validateK3WisePipelineRunForm(form, 'bom'))
const deployGateChecklist = computed(() => buildK3WiseDeployGateChecklist(form))
const deployGateSummary = computed(() => summarizeK3WiseDeployGateChecklist(deployGateChecklist.value))
const observationSummary = computed(() => `${pipelineRuns.value.length} runs / ${deadLetters.value.length} open`)
const stagingDescriptorLabel = computed(() => stagingDescriptors.value.length > 0 ? `${stagingDescriptors.value.length} descriptors` : 'not loaded')
const templatePreviewJson = computed(() => JSON.stringify(buildK3WiseDocumentPayloadPreview(templatePreviewTarget.value), null, 2))
const selectedWebApiSystem = computed(() => webApiSystems.value.find((system) => system.id === form.webApiSystemId) || null)
const baseUrlHasK3ApiPath = computed(() => /\/k3api(?:\/|$)/i.test(form.baseUrl.trim()))
const webApiConnectionStatus = computed(() => {
  if (testingWebApi.value) {
    return {
      status: 'partial',
      label: 'testing',
      message: '正在向已保存的 K3 WISE WebAPI 配置发起连接测试。',
    }
  }
  if (!form.webApiSystemId) {
    return {
      status: 'open',
      label: 'not saved',
      message: '还没有保存 K3 WISE WebAPI 配置；保存后才能测试连接。',
    }
  }
  const system = selectedWebApiSystem.value
  if (system?.lastError) {
    return {
      status: 'failed',
      label: 'failed',
      message: `上次连接测试失败：${system.lastError}`,
    }
  }
  if (system?.lastTestedAt) {
    return {
      status: 'succeeded',
      label: 'connected',
      message: `已连接 K3 WISE WebAPI；最近测试 ${formatTimestamp(system.lastTestedAt)}。`,
    }
  }
  return {
    status: 'open',
    label: 'untested',
    message: '配置已保存，但尚未测试；点击“测试 WebAPI”确认是否连上 K3。',
  }
})

function setStatus(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  statusMessage.value = message
  statusKind.value = kind
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTimestamp(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatRunMetrics(run: IntegrationPipelineRun): string {
  return `read ${run.rowsRead} / clean ${run.rowsCleaned} / write ${run.rowsWritten} / failed ${run.rowsFailed}`
}

function formatDeployGateStatus(status: string): string {
  if (status === 'ready') return 'succeeded'
  if (status === 'missing') return 'failed'
  if (status === 'warning') return 'partial'
  return 'open'
}

function formatTemplateTransform(transform: unknown): string {
  if (!transform) return '-'
  const list = Array.isArray(transform) ? transform : [transform]
  return list.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object' && 'fn' in item) return String((item as { fn?: unknown }).fn)
    return String(item)
  }).join(' + ')
}

function isTemplateMappingRequired(mapping: K3WiseDocumentTemplateMapping): boolean {
  const validation = Array.isArray(mapping.validation) ? mapping.validation : []
  return validation.some((item) => Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'required'))
}

function loadSystemIntoForm(system: IntegrationExternalSystem): void {
  Object.assign(form, applyExternalSystemToForm(form, system))
  testResult.value = ''
  setStatus(`已载入 ${system.name}`, 'info')
}

async function loadSystems(): Promise<void> {
  loading.value = true
  try {
    const [webApi, sql] = await Promise.all([
      listIntegrationSystems(K3_WISE_WEBAPI_KIND, form),
      listIntegrationSystems(K3_WISE_SQLSERVER_KIND, form),
    ])
    webApiSystems.value = webApi
    sqlSystems.value = sql
    if (!form.webApiSystemId && webApi[0]) loadSystemIntoForm(webApi[0])
    if (!form.sqlSystemId && sql[0]) loadSystemIntoForm(sql[0])
    setStatus('K3 WISE 配置已刷新', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    loading.value = false
  }
}

async function saveConfiguration(): Promise<void> {
  const issues = validateK3WiseSetupForm(form)
  if (issues.length > 0) {
    setStatus(issues[0].message, 'error')
    return
  }
  saving.value = true
  try {
    const payloads = buildK3WiseSetupPayloads(form)
    const webApi = await upsertIntegrationSystem(payloads.webApi)
    form.webApiSystemId = webApi.id
    form.webApiHasCredentials = webApi.hasCredentials === true
    if (payloads.sqlServer) {
      const sql = await upsertIntegrationSystem(payloads.sqlServer)
      form.sqlSystemId = sql.id
      form.sqlHasCredentials = sql.hasCredentials === true
    }
    await loadSystems()
    setStatus('K3 WISE 对接配置已保存', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    saving.value = false
  }
}

async function testWebApi(): Promise<void> {
  if (!form.webApiSystemId) return
  testingWebApi.value = true
  testResult.value = ''
  try {
    const result = await testIntegrationSystem(form.webApiSystemId, { skipHealth: !form.healthPath.trim() })
    testResult.value = JSON.stringify(result, null, 2)
    await loadSystems()
    setStatus('WebAPI 连接测试完成', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    testingWebApi.value = false
  }
}

async function testSqlServer(): Promise<void> {
  if (!form.sqlSystemId) return
  testingSql.value = true
  testResult.value = ''
  try {
    const result = await testIntegrationSystem(form.sqlSystemId)
    testResult.value = JSON.stringify(result, null, 2)
    await loadSystems()
    setStatus('SQL Server 通道测试完成', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    testingSql.value = false
  }
}

async function loadStagingDescriptors(silent = false): Promise<void> {
  loadingStagingDescriptors.value = true
  try {
    stagingDescriptors.value = await listIntegrationStagingDescriptors()
    if (!silent) setStatus('Staging 契约已刷新', 'success')
  } catch (error) {
    if (!silent) setStatus(formatError(error), 'error')
  } finally {
    loadingStagingDescriptors.value = false
  }
}

async function installStagingTables(): Promise<void> {
  const issues = validateK3WiseStagingInstallForm(form)
  if (issues.length > 0) {
    setStatus(issues[0].message, 'error')
    return
  }
  installingStaging.value = true
  stagingResult.value = ''
  try {
    const result = await installIntegrationStaging(buildK3WiseStagingInstallPayload(form))
    stagingResult.value = JSON.stringify(result, null, 2)
    await loadStagingDescriptors(true)
    setStatus('Staging 多维表已安装或确认存在', result.warnings.length > 0 ? 'info' : 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    installingStaging.value = false
  }
}

async function createPipelineTemplates(): Promise<void> {
  const issues = validateK3WisePipelineTemplateForm(form, stagingDescriptors.value)
  if (issues.length > 0) {
    setStatus(issues[0].message, 'error')
    return
  }
  creatingPipelines.value = true
  pipelineResult.value = ''
  try {
    const payloads = buildK3WisePipelinePayloads(form)
    const [material, bom] = await Promise.all([
      upsertIntegrationPipeline(payloads.material),
      upsertIntegrationPipeline(payloads.bom),
    ])
    form.materialPipelineId = material.id
    form.bomPipelineId = bom.id
    pipelineResult.value = JSON.stringify({
      material: { id: material.id, name: material.name, status: material.status },
      bom: { id: bom.id, name: bom.name, status: bom.status },
    }, null, 2)
    setStatus('PLM → K3 清洗 Pipeline 已创建为 draft', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    creatingPipelines.value = false
  }
}

function isPipelineRunDisabled(target: K3WisePipelineTarget, dryRun: boolean): boolean {
  const issues = target === 'material' ? materialRunIssues.value : bomRunIssues.value
  return Boolean(runningPipeline.value || issues.length > 0 || (!dryRun && !form.allowLivePipelineRun))
}

function isPipelineObservationDisabled(target: K3WisePipelineTarget): boolean {
  return Boolean(observingPipeline.value || validateK3WisePipelineObservationForm(form, target).length > 0)
}

async function refreshPipelineObservation(target: K3WisePipelineTarget, silent = false): Promise<void> {
  const issues = validateK3WisePipelineObservationForm(form, target)
  if (issues.length > 0) {
    if (!silent) setStatus(issues[0].message, 'error')
    return
  }
  observingPipeline.value = target
  observedPipelineTarget.value = target
  try {
    const [runs, openDeadLetters] = await Promise.all([
      listIntegrationPipelineRuns(buildK3WisePipelineObservationQuery(form, target, { limit: 5 })),
      listIntegrationDeadLetters(buildK3WisePipelineObservationQuery(form, target, { status: 'open', limit: 5 })),
    ])
    pipelineRuns.value = runs
    deadLetters.value = openDeadLetters
    if (!silent) {
      setStatus(`${target === 'material' ? '物料' : 'BOM'} Pipeline 运行状态已刷新`, 'success')
    }
  } catch (error) {
    if (!silent) setStatus(formatError(error), 'error')
  } finally {
    observingPipeline.value = ''
  }
}

async function executePipeline(target: K3WisePipelineTarget, dryRun: boolean): Promise<void> {
  const issues = validateK3WisePipelineRunForm(form, target)
  if (issues.length > 0) {
    setStatus(issues[0].message, 'error')
    return
  }
  if (!dryRun && !form.allowLivePipelineRun) {
    setStatus('真实执行前需要勾选允许真实执行 Pipeline', 'error')
    return
  }
  runningPipeline.value = `${target}:${dryRun ? 'dry-run' : 'run'}`
  pipelineRunResult.value = ''
  try {
    const pipelineId = getK3WisePipelineId(form, target)
    const result = await runIntegrationPipeline(pipelineId, buildK3WisePipelineRunPayload(form, target), dryRun)
    pipelineRunResult.value = JSON.stringify({
      target,
      dryRun,
      pipelineId,
      result,
    }, null, 2)
    await refreshPipelineObservation(target, true)
    setStatus(`${target === 'material' ? '物料' : 'BOM'} Pipeline ${dryRun ? 'dry-run' : 'run'} 已提交`, 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    runningPipeline.value = ''
  }
}

onMounted(() => {
  void loadSystems()
  void loadStagingDescriptors(true)
})
</script>

<style scoped>
.k3-setup {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 24px;
  background: #f6f8fb;
  color: #172033;
}

.k3-setup__header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  padding-bottom: 16px;
  border-bottom: 1px solid #d9e1ec;
}

.k3-setup__eyebrow {
  margin: 0 0 4px;
  color: #64748b;
  font-size: 12px;
  text-transform: uppercase;
}

.k3-setup__header h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  color: #111827;
}

.k3-setup__lead {
  margin: 8px 0 0;
  color: #526072;
}

.k3-setup__header-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.k3-setup__journey {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.k3-setup__journey-step {
  min-width: 0;
  padding: 12px;
  border: 1px solid #d9e1ec;
  border-radius: 8px;
  background: #fff;
}

.k3-setup__journey-step strong,
.k3-setup__journey-step span {
  display: block;
  overflow-wrap: anywhere;
}

.k3-setup__journey-step strong {
  color: #111827;
  font-size: 14px;
}

.k3-setup__journey-step span {
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.k3-setup__layout {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.k3-setup__rail,
.k3-setup__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.k3-setup__panel,
.k3-setup__section {
  padding: 16px;
  border: 1px solid #d9e1ec;
  border-radius: 8px;
  background: #fff;
}

.k3-setup__section--primary {
  border-color: #99f6e4;
}

.k3-setup__details[open] {
  border-color: #cbd5e1;
}

.k3-setup__collapsible-panel {
  padding: 0;
}

.k3-setup__collapsible-panel[open] {
  padding: 0 16px 16px;
}

.k3-setup__panel-summary,
.k3-setup__section-summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  cursor: pointer;
  list-style: none;
}

.k3-setup__panel-summary {
  padding: 16px;
}

.k3-setup__collapsible-panel[open] .k3-setup__panel-summary {
  margin: 0 -16px 14px;
  border-bottom: 1px solid #e2e8f0;
}

.k3-setup__section-summary {
  margin: -2px 0 0;
}

.k3-setup__details[open] .k3-setup__section-summary {
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e2e8f0;
}

.k3-setup__panel-summary::-webkit-details-marker,
.k3-setup__section-summary::-webkit-details-marker {
  display: none;
}

.k3-setup__panel-summary::after,
.k3-setup__section-summary::after {
  content: '+';
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #334155;
  font-weight: 700;
}

.k3-setup__collapsible-panel[open] .k3-setup__panel-summary::after,
.k3-setup__details[open] .k3-setup__section-summary::after {
  content: '-';
}

.k3-setup__panel-summary span,
.k3-setup__section-summary span {
  color: #111827;
  font-size: 16px;
  font-weight: 700;
}

.k3-setup__panel-summary small,
.k3-setup__section-summary small {
  color: #64748b;
  font-size: 12px;
}

.k3-setup__details-toolbar {
  margin-bottom: 12px;
}

.k3-setup__panel-head,
.k3-setup__section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.k3-setup__panel-head h2,
.k3-setup__section-head h2 {
  margin: 0;
  font-size: 16px;
  line-height: 1.3;
  color: #111827;
}

.k3-setup__panel-head span,
.k3-setup__section-head span {
  color: #64748b;
  font-size: 12px;
}

.k3-setup__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
  gap: 14px;
}

.k3-setup__field,
.k3-setup__check,
.k3-setup__switch {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.k3-setup__field--wide {
  grid-column: span 2;
}

.k3-setup__field span,
.k3-setup__check span,
.k3-setup__switch span {
  color: #334155;
  font-size: 13px;
  font-weight: 600;
}

.k3-setup__field small,
.k3-setup__field-note {
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.k3-setup__field-note {
  margin: 0;
}

.k3-setup__field-note--wide {
  grid-column: 1 / -1;
}

.k3-setup__hint-warning {
  color: #92400e;
}

.k3-setup__field input,
.k3-setup__field select,
.k3-setup__field textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 10px;
  background: #fff;
  color: #111827;
  font: inherit;
}

.k3-setup__field input[readonly] {
  background: #f8fafc;
  color: #64748b;
}

.k3-setup__field textarea {
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
}

.k3-setup__check,
.k3-setup__switch {
  flex-direction: row;
  align-items: center;
  min-height: 38px;
}

.k3-setup__check input,
.k3-setup__switch input {
  width: 16px;
  height: 16px;
}

.k3-setup__btn {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 12px;
  background: #fff;
  color: #172033;
  font: inherit;
  cursor: pointer;
}

.k3-setup__btn--primary {
  border-color: #0f766e;
  background: #0f766e;
  color: #fff;
}

.k3-setup__btn--full {
  width: 100%;
  margin-top: 8px;
}

.k3-setup__btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.k3-setup__status {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
}

.k3-setup__status[data-kind="success"] {
  border-color: #99f6e4;
  background: #f0fdfa;
  color: #115e59;
}

.k3-setup__status[data-kind="error"] {
  border-color: #fecaca;
  background: #fff1f2;
  color: #9f1239;
}

.k3-setup__saved-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.k3-setup__saved {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px;
  background: #f8fafc;
  color: #172033;
  text-align: left;
  cursor: pointer;
}

.k3-setup__saved small {
  color: #64748b;
}

.k3-setup__saved-error {
  color: #9f1239;
  overflow-wrap: anywhere;
}

.k3-setup__connection-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px;
  background: #f8fafc;
}

.k3-setup__connection-state small {
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.k3-setup__empty {
  color: #64748b;
}

.k3-setup__records {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.k3-setup__descriptor-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.k3-setup__gate-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.k3-setup__gate-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 420px;
  overflow: auto;
}

.k3-setup__gate-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px;
  background: #f8fafc;
}

.k3-setup__gate-item small {
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.k3-setup__descriptor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px;
  background: #f8fafc;
}

.k3-setup__descriptor strong,
.k3-setup__descriptor small {
  overflow-wrap: anywhere;
}

.k3-setup__descriptor small {
  color: #64748b;
  font-size: 12px;
}

.k3-setup__record-head,
.k3-setup__record-main {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.k3-setup__record-head span {
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

.k3-setup__record-head small {
  color: #64748b;
}

.k3-setup__record {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px;
  background: #f8fafc;
}

.k3-setup__record strong {
  overflow-wrap: anywhere;
  color: #172033;
  font-size: 13px;
}

.k3-setup__record small {
  overflow-wrap: anywhere;
  color: #64748b;
}

.k3-setup__badge {
  border-radius: 999px;
  padding: 2px 8px;
  background: #e2e8f0;
  color: #334155;
  font-size: 12px;
  white-space: nowrap;
}

.k3-setup__badge[data-status="succeeded"],
.k3-setup__badge[data-status="replayed"] {
  background: #ccfbf1;
  color: #115e59;
}

.k3-setup__badge[data-status="partial"],
.k3-setup__badge[data-status="open"] {
  background: #fef3c7;
  color: #92400e;
}

.k3-setup__badge[data-status="failed"] {
  background: #ffe4e6;
  color: #9f1239;
}

.k3-setup__test-result {
  overflow: auto;
  max-height: 260px;
  margin: 12px 0 0;
  padding: 10px;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
}

.k3-setup__template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.k3-setup__template-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px;
  background: #f8fafc;
}

.k3-setup__template-card small {
  color: #64748b;
  overflow-wrap: anywhere;
}

.k3-setup__mapping-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}

.k3-setup__mapping-table th,
.k3-setup__mapping-table td {
  border-bottom: 1px solid #e2e8f0;
  padding: 7px 6px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.k3-setup__mapping-table th {
  color: #475569;
  font-weight: 700;
}

.k3-setup__preview-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  color: #334155;
  font-size: 13px;
}

.k3-setup__preview-head span {
  color: #64748b;
}

.k3-setup__json-preview {
  overflow: auto;
  max-height: 260px;
  margin: 8px 0 0;
  padding: 10px;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
}

.k3-setup__section--issues {
  border-color: #fed7aa;
  background: #fff7ed;
}

.k3-setup__issues {
  margin: 0;
  padding-left: 18px;
  color: #9a3412;
}

.k3-setup__issues--compact {
  margin-top: 10px;
  font-size: 13px;
}

@media (max-width: 1100px) {
  .k3-setup__layout {
    grid-template-columns: 1fr;
  }

  .k3-setup__journey {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .k3-setup__rail {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .k3-setup__template-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .k3-setup {
    padding: 16px;
  }

  .k3-setup__header {
    flex-direction: column;
  }

  .k3-setup__header-actions,
  .k3-setup__rail {
    display: flex;
  }

  .k3-setup__journey {
    grid-template-columns: 1fr;
  }

  .k3-setup__grid {
    grid-template-columns: 1fr;
  }

  .k3-setup__field--wide {
    grid-column: auto;
  }
}
</style>

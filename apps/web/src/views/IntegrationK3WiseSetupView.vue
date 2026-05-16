<template>
  <section class="k3-setup" data-testid="k3-wise-setup">
    <header class="k3-setup__header">
      <div>
        <p class="k3-setup__eyebrow">Data Factory Preset</p>
        <h1>K3 WISE 预设配置</h1>
        <p class="k3-setup__lead">K3 WISE 是数据工厂里的物料 / BOM 预设模板；数据仍在多维表中清洗，dry-run 后再 Save-only 推送。</p>
      </div>
      <div class="k3-setup__header-actions">
        <router-link class="k3-setup__btn" data-testid="generic-workbench-link" to="/integrations/workbench">
          进入数据工厂
        </router-link>
        <button class="k3-setup__btn" type="button" :disabled="loading" @click="loadSystems(false)">
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
          <button class="k3-setup__btn k3-setup__btn--full" type="button" :disabled="webApiTestDisabled" @click="testWebApi">
            {{ testingWebApi ? '测试中' : '测试 WebAPI' }}
          </button>
          <p v-if="hasUnsavedWebApiConnectionDraft" class="k3-setup__hint">WebAPI 连接配置有未保存改动，请先保存再测试。</p>
          <p class="k3-setup__field-note">
            先保存配置，再测试 WebAPI；测试通过后这里会显示已连接和最近测试时间。
          </p>
          <button class="k3-setup__btn k3-setup__btn--full" type="button" :disabled="sqlTestDisabled" @click="testSqlServer">
            {{ testingSql ? '测试中' : '测试 SQL Server' }}
          </button>
          <p v-if="hasUnsavedSqlConnectionDraft" class="k3-setup__hint">SQL Server 通道配置有未保存改动，请先保存再测试。</p>
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
          <div v-if="stagingOpenTargets.length" class="k3-setup__open-targets" data-testid="staging-open-targets">
            <div v-for="target in stagingOpenTargets" :key="target.id" class="k3-setup__open-target">
              <div>
                <strong>{{ target.name }}</strong>
                <small>{{ target.description }}</small>
              </div>
              <router-link
                class="k3-setup__btn k3-setup__btn--compact"
                :to="target.openLink"
                :data-testid="`open-staging-${target.id}`"
              >
                打开多维表（新建记录入口）
              </router-link>
            </div>
          </div>
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

        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>PoC 准备</h2>
            <span>{{ gateIssues.length ? `${gateIssues.length} gaps` : 'ready' }}</span>
          </div>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            data-testid="k3-wise-gate-copy-button"
            :disabled="gateIssues.length > 0 || !gateDraftText"
            @click="copyGateDraft"
          >
            复制 GATE JSON
          </button>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            data-testid="k3-wise-gate-download-button"
            :disabled="gateIssues.length > 0 || !gateDraftText"
            @click="downloadGateDraft"
          >
            下载 GATE JSON
          </button>
          <label class="k3-setup__field k3-setup__gate-import">
            <span>导入客户 GATE JSON</span>
            <textarea
              v-model="gateImportText"
              data-testid="k3-wise-gate-import-textarea"
              rows="6"
              spellcheck="false"
              placeholder="粘贴客户回传的 GATE JSON，导入后会清空输入框和密码字段"
            />
          </label>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            data-testid="k3-wise-gate-import-button"
            :disabled="!gateImportText.trim()"
            @click="importGateJson"
          >
            导入 GATE JSON
          </button>
          <ul v-if="gateImportWarnings.length" class="k3-setup__issues k3-setup__issues--compact" data-testid="k3-wise-gate-import-warnings">
            <li v-for="warning in gateImportWarnings" :key="`gate-import:${warning}`">
              {{ warning }}
            </li>
          </ul>
          <ul v-if="gateIssues.length" class="k3-setup__issues k3-setup__issues--compact">
            <li v-for="issue in gateIssues" :key="`gate:${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
          <div class="k3-setup__commands" data-testid="k3-wise-gate-commands">
            <div class="k3-setup__command k3-setup__command--env" data-testid="k3-wise-env-template">
              <div class="k3-setup__command-head">
                <strong>Deploy env</strong>
                <button
                  class="k3-setup__command-copy"
                  type="button"
                  data-testid="k3-wise-copy-env-template"
                  @click="copyGateCommand('Deploy env', gateEnvTemplate)"
                >
                  复制
                </button>
              </div>
              <code>{{ gateEnvTemplate }}</code>
            </div>
            <div class="k3-setup__command k3-setup__command--env" data-testid="k3-wise-postdeploy-bundle">
              <div class="k3-setup__command-head">
                <strong>Deploy signoff bundle</strong>
                <button
                  class="k3-setup__command-copy"
                  type="button"
                  data-testid="k3-wise-copy-postdeploy-bundle"
                  @click="copyGateCommand('Deploy signoff bundle', postdeploySignoffBundle)"
                >
                  复制
                </button>
              </div>
              <code>{{ postdeploySignoffBundle }}</code>
            </div>
            <div
              v-for="command in gateCommandItems"
              :key="command.key"
              class="k3-setup__command"
            >
              <div class="k3-setup__command-head">
                <strong>{{ command.label }}</strong>
                <button
                  class="k3-setup__command-copy"
                  type="button"
                  :data-testid="`k3-wise-copy-command-${command.key}`"
                  @click="copyGateCommand(command.label, command.value)"
                >
                  复制
                </button>
              </div>
              <code>{{ command.value }}</code>
            </div>
          </div>
          <pre v-if="gateDraftText" class="k3-setup__test-result">{{ gateDraftText }}</pre>
        </div>

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
            <span>K3 WebAPI 快速预设；高级上下文默认使用 tenant=default</span>
          </div>
          <div class="k3-setup__grid">
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
              <small>Base URL 只填协议、主机和端口；endpoint path 在高级设置中维护，默认已包含 /K3API/...。</small>
              <small v-if="baseUrlEndpointOverlapWarning" class="k3-setup__hint-warning">
                当前 Base URL 和 endpoint path 都含 /K3API；请求会拼成重复路径。请把 Base URL 改为只到主机端口。
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
            <label class="k3-setup__field">
              <span>Tenant ID（高级上下文）</span>
              <input v-model.trim="form.tenantId" placeholder="default" autocomplete="off" />
              <small>普通单租户部署可留空或使用 default；它不是 K3 账套号。</small>
            </label>
            <label class="k3-setup__field">
              <span>Workspace ID（高级，可选）</span>
              <input v-model.trim="form.workspaceId" autocomplete="off" />
              <small>单工作区 PoC 建议留空；需要多工作区隔离时再填真实 ID。</small>
            </label>
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
            <span>高级 SQL Server 通道</span>
            <small>默认关闭；需要读取 K3 表或写中间表时再启用</small>
          </summary>
          <p class="k3-setup__field-note k3-setup__field-note--wide">
            SQL 通道是高级实施能力：读取必须走 allowlist 表/视图，写入只能走中间表或受控存储过程，不在普通 UI 暴露 K3 核心表直写。
          </p>
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

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>客户 GATE / PLM Source</h2>
            <span>preflight JSON</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Operator</span>
              <input v-model.trim="form.operator" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM Kind</span>
              <input v-model.trim="form.plmKind" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM Read Method</span>
              <select v-model="form.plmReadMethod">
                <option value="api">api</option>
                <option value="database">database</option>
                <option value="table">table</option>
                <option value="file">file</option>
                <option value="manual">manual</option>
              </select>
            </label>
            <label class="k3-setup__field k3-setup__field--wide">
              <span>PLM Base URL</span>
              <input v-model.trim="form.plmBaseUrl" placeholder="https://plm.example.test/" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM Default Product ID</span>
              <input v-model.trim="form.plmDefaultProductId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM 用户名</span>
              <input v-model.trim="form.plmUsername" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM 密码</span>
              <input v-model="form.plmPassword" type="password" autocomplete="new-password" />
              <small>只作为导入客户 GATE 后的本地草稿；导出 JSON 永远使用占位符。</small>
            </label>
            <label class="k3-setup__field">
              <span>Rollback Owner</span>
              <input v-model.trim="form.rollbackOwner" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Rollback Strategy</span>
              <input v-model.trim="form.rollbackStrategy" autocomplete="off" />
            </label>
            <label class="k3-setup__check">
              <input v-model="form.bomEnabled" type="checkbox" />
              <span>启用 BOM PoC</span>
            </label>
            <label v-if="form.bomEnabled" class="k3-setup__field">
              <span>BOM Product ID</span>
              <input v-model.trim="form.bomProductId" autocomplete="off" />
            </label>
          </div>
        </section>

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
              <span>Project ID（高级，可选）</span>
              <input
                :value="form.projectId"
                autocomplete="off"
                data-testid="k3-setup-project-id"
                placeholder="留空自动使用 tenant:integration-core"
                @input="onK3SetupProjectIdInput"
                @change="onK3SetupProjectIdInput"
                @blur="onK3SetupProjectIdInput"
              />
              <small class="k3-setup__hint" data-testid="k3-setup-project-id-hint">
                留空时安装会自动使用插件专用作用域 <code>tenant:integration-core</code>；若自定义，结尾必须是 <code>:integration-core</code>，否则会触发 plugin-scope 警告。
              </small>
              <small class="k3-setup__hint" data-testid="k3-setup-project-id-scope-status">
                {{ k3SetupProjectIdScopeStatus }}
              </small>
            </label>
            <div
              v-if="k3SetupProjectIdScopeWarning"
              class="k3-setup__hint k3-setup__hint--strong k3-setup__field-note--wide"
              role="alert"
              data-testid="k3-setup-project-id-scope-warning"
            >
              <span>{{ k3SetupProjectIdScopeWarning }}</span>
              <button
                class="k3-setup__btn k3-setup__btn--compact"
                type="button"
                data-testid="normalize-k3-setup-project-id"
                @click="normalizeK3SetupProjectIdToScope"
              >
                规范化为 integration 作用域
              </button>
            </div>
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
  applyK3WiseGateJsonToForm,
  buildK3WiseDocumentPayloadPreview,
  buildK3WiseDeployGateChecklist,
  buildK3WisePocCommandSet,
  buildK3WisePocEnvironmentTemplate,
  buildK3WisePostdeploySignoffBundle,
  buildK3WiseSqlConnectionFingerprint,
  buildK3WiseSqlSystemConnectionFingerprint,
  buildK3WiseWebApiConnectionFingerprint,
  buildK3WiseWebApiSystemConnectionFingerprint,
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
  stringifyK3WiseGateDraft,
  summarizeK3WiseDeployGateChecklist,
  testIntegrationSystem,
  upsertIntegrationPipeline,
  upsertIntegrationSystem,
  validateK3WiseGateDraftForm,
  validateK3WisePipelineTemplateForm,
  validateK3WisePipelineObservationForm,
  validateK3WisePipelineRunForm,
  validateK3WiseSetupForm,
  validateK3WiseStagingInstallForm,
  type IntegrationDeadLetter,
  type IntegrationExternalSystem,
  type IntegrationPipelineRun,
  type IntegrationStagingDescriptor,
  type IntegrationStagingInstallResult,
  type K3WiseDocumentTemplateMapping,
  type K3WisePipelineTarget,
} from '../services/integration/k3WiseSetup'
import {
  isIntegrationScopedProjectId,
  normalizeIntegrationProjectId,
} from '../services/integration/workbench'

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
const stagingInstallResult = ref<IntegrationStagingInstallResult | null>(null)
const pipelineResult = ref('')
const pipelineRunResult = ref('')
const gateImportText = ref('')
const gateImportWarnings = ref<string[]>([])
const webApiLastTest = ref<{
  systemId: string
  ok: boolean
  lastTestedAt: string
  lastError: string | null
} | null>(null)
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
const gateIssues = computed(() => validateK3WiseGateDraftForm(form))
const deployGateChecklist = computed(() => buildK3WiseDeployGateChecklist(form))
const deployGateSummary = computed(() => summarizeK3WiseDeployGateChecklist(deployGateChecklist.value))
const gateCommands = buildK3WisePocCommandSet()
const gateEnvTemplate = computed(() => buildK3WisePocEnvironmentTemplate(form))
const postdeploySignoffBundle = computed(() => buildK3WisePostdeploySignoffBundle(form, gateCommands))
const gateCommandItems = [
  { key: 'postdeploy-smoke', label: 'Postdeploy smoke', value: gateCommands.postdeploySmoke },
  { key: 'postdeploy-summary', label: 'Postdeploy summary', value: gateCommands.postdeploySummary },
  { key: 'preflight', label: 'Preflight', value: gateCommands.preflight },
  { key: 'offline-mock', label: 'Offline mock', value: gateCommands.offlineMock },
  { key: 'evidence', label: 'Evidence', value: gateCommands.evidence },
]
const gateDraftText = computed(() => {
  if (gateIssues.value.length > 0) return ''
  try {
    return stringifyK3WiseGateDraft(form)
  } catch {
    return ''
  }
})
const observationSummary = computed(() => `${pipelineRuns.value.length} runs / ${deadLetters.value.length} open`)
const stagingDescriptorLabel = computed(() => stagingDescriptors.value.length > 0 ? `${stagingDescriptors.value.length} descriptors` : 'not loaded')
const templatePreviewJson = computed(() => JSON.stringify(buildK3WiseDocumentPayloadPreview(templatePreviewTarget.value), null, 2))
const stagingOpenTargets = computed(() => buildStagingOpenTargets(stagingInstallResult.value, form.baseId))
const selectedWebApiSystem = computed(() => webApiSystems.value.find((system) => system.id === form.webApiSystemId) || null)
const selectedSqlSystem = computed(() => sqlSystems.value.find((system) => system.id === form.sqlSystemId) || null)
const hasUnsavedWebApiConnectionDraft = computed(() => {
  const system = selectedWebApiSystem.value
  if (!system) return Boolean(form.webApiSystemId)
  return buildK3WiseWebApiConnectionFingerprint(form) !== buildK3WiseWebApiSystemConnectionFingerprint(system)
})
const hasUnsavedSqlConnectionDraft = computed(() => {
  const system = selectedSqlSystem.value
  if (!system) return Boolean(form.sqlSystemId)
  return buildK3WiseSqlConnectionFingerprint(form) !== buildK3WiseSqlSystemConnectionFingerprint(system)
})
const webApiTestDisabled = computed(() => Boolean(testingWebApi.value || !form.webApiSystemId || hasUnsavedWebApiConnectionDraft.value))
const sqlTestDisabled = computed(() => Boolean(testingSql.value || !form.sqlSystemId || hasUnsavedSqlConnectionDraft.value))
const baseUrlHasK3ApiPath = computed(() => /\/k3api(?:\/|$)/i.test(form.baseUrl.trim()))
const endpointPathHasK3ApiPath = computed(() => [
  form.tokenPath,
  form.loginPath,
  form.healthPath,
  form.materialSavePath,
  form.materialSubmitPath,
  form.materialAuditPath,
  form.bomSavePath,
  form.bomSubmitPath,
  form.bomAuditPath,
].some((path) => /\/k3api(?:\/|$)/i.test(path.trim())))
const baseUrlEndpointOverlapWarning = computed(() => baseUrlHasK3ApiPath.value && endpointPathHasK3ApiPath.value)
const k3SetupProjectIdScopeWarning = computed(() => {
  const value = form.projectId.trim()
  if (!value || isIntegrationScopedProjectId(value)) return ''
  return `Project ID「${value}」不是 integration 作用域，安装会触发 plugin-scope 警告。留空可自动作用域，或一键规范化为以 :integration-core 结尾。`
})
const k3SetupProjectIdScopeStatus = computed(() => {
  const value = form.projectId.trim()
  if (!value) return `当前将使用 ${(form.tenantId.trim() || 'default')}:integration-core`
  if (isIntegrationScopedProjectId(value)) return `当前将使用 ${value}`
  return `当前为非 integration 作用域：${value}`
})
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
  if (webApiLastTest.value?.systemId === form.webApiSystemId) {
    if (webApiLastTest.value.ok) {
      return {
        status: 'succeeded',
        label: 'connected',
        message: `已连接 K3 WISE WebAPI；最近测试 ${formatTimestamp(webApiLastTest.value.lastTestedAt)}。`,
      }
    }
    return {
      status: 'failed',
      label: 'failed',
      message: `上次连接测试失败：${webApiLastTest.value.lastError || 'K3 WISE WebAPI returned an unsuccessful test result'}`,
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

type StagingOpenTargetView = {
  id: string
  name: string
  description: string
  sheetId: string
  viewId: string
  openLink: string
}

const STAGING_OPEN_TARGET_COPY: Record<string, { name: string; description: string }> = {
  plm_raw_items: {
    name: '原始数据',
    description: '来源系统拉取后的只读追溯表，先确认数据是否进来。',
  },
  standard_materials: {
    name: '物料清洗',
    description: '业务主要在这里修正物料编码、名称、规格、单位和同步状态。',
  },
  bom_cleanse: {
    name: 'BOM 清洗',
    description: '业务主要在这里修正父子件、数量、单位、序号和版本。',
  },
  integration_exceptions: {
    name: '异常处理',
    description: '缺字段、非法数量、单位映射失败等问题先在这里处理。',
  },
  integration_run_log: {
    name: '运行日志',
    description: '查看 dry-run、Save-only 推送和回写结果。',
  },
}

const STAGING_OPEN_TARGET_ORDER = [
  'standard_materials',
  'bom_cleanse',
  'integration_exceptions',
  'plm_raw_items',
  'integration_run_log',
] as const

function buildMultitableOpenLink(sheetId: string, viewId: string, baseId?: string | null): string {
  const path = `/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}`
  const normalizedBaseId = typeof baseId === 'string' && baseId.trim() ? baseId.trim() : ''
  return normalizedBaseId ? `${path}?baseId=${encodeURIComponent(normalizedBaseId)}` : path
}

function buildStagingOpenTargets(
  result: IntegrationStagingInstallResult | null,
  fallbackBaseId?: string,
): StagingOpenTargetView[] {
  if (!result) return []
  const targetsById = new Map((result.targets ?? []).map((target) => [target.id, target]))
  return STAGING_OPEN_TARGET_ORDER.flatMap((id) => {
    const target = targetsById.get(id)
    const sheetId = target?.sheetId ?? result.sheetIds?.[id]
    const viewId = target?.viewId ?? result.viewIds?.[id]
    if (!sheetId || !viewId) return []
    const copy = STAGING_OPEN_TARGET_COPY[id]
    return [{
      id,
      name: copy.name,
      description: copy.description,
      sheetId,
      viewId,
      openLink: target?.openLink ?? result.openLinks?.[id] ?? buildMultitableOpenLink(sheetId, viewId, target?.baseId ?? fallbackBaseId),
    }]
  })
}

function normalizeK3SetupProjectIdToScope(): void {
  const normalized = normalizeIntegrationProjectId(form.projectId, form.tenantId || 'default')
  form.projectId = normalized
  setStatus(`Project ID 已规范化为 ${normalized}`, 'info')
}

function onK3SetupProjectIdInput(event: Event): void {
  const target = event.target as HTMLInputElement | null
  form.projectId = target?.value ?? ''
}

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

async function copyGateDraft(): Promise<void> {
  if (!gateDraftText.value) return
  try {
    await navigator.clipboard.writeText(gateDraftText.value)
    setStatus('GATE JSON 已复制', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  }
}

async function copyGateCommand(label: string, command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    setStatus(`${label} 命令已复制`, 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  }
}

function downloadGateDraft(): void {
  if (!gateDraftText.value || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([gateDraftText.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'k3-wise-live-poc-gate.json'
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  setStatus('GATE JSON 已生成', 'success')
}

function importGateJson(): void {
  try {
    const result = applyK3WiseGateJsonToForm(form, gateImportText.value)
    Object.assign(form, result.form)
    gateImportWarnings.value = result.warnings
    gateImportText.value = ''
    setStatus(
      result.warnings.length > 0
        ? `GATE JSON 已导入，${result.warnings.length} 项需要人工确认`
        : 'GATE JSON 已导入',
      result.warnings.length > 0 ? 'info' : 'success',
    )
  } catch (error) {
    gateImportWarnings.value = []
    setStatus(formatError(error), 'error')
  }
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

function getTestResultSystem(result: Record<string, unknown>): IntegrationExternalSystem | null {
  const system = result.system
  if (!system || typeof system !== 'object' || Array.isArray(system)) return null
  const candidate = system as Partial<IntegrationExternalSystem>
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.kind !== 'string') return null
  return candidate as IntegrationExternalSystem
}

function upsertLocalWebApiSystem(system: IntegrationExternalSystem): void {
  if (system.kind !== K3_WISE_WEBAPI_KIND) return
  const index = webApiSystems.value.findIndex((item) => item.id === system.id)
  if (index === -1) {
    webApiSystems.value = [system, ...webApiSystems.value]
    return
  }
  const next = [...webApiSystems.value]
  next[index] = { ...next[index], ...system }
  webApiSystems.value = next
}

function buildConnectionTestPayload(): Record<string, unknown> {
  return {
    tenantId: form.tenantId.trim() || 'default',
    workspaceId: form.workspaceId.trim() || null,
    skipHealth: !form.healthPath.trim(),
  }
}

function loadSystemIntoForm(system: IntegrationExternalSystem): void {
  Object.assign(form, applyExternalSystemToForm(form, system))
  testResult.value = ''
  webApiLastTest.value = null
  setStatus(`已载入 ${system.name}`, 'info')
}

async function loadSystems(silent = false): Promise<void> {
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
    if (!silent) setStatus('K3 WISE 配置已刷新', 'success')
  } catch (error) {
    if (!silent) setStatus(formatError(error), 'error')
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
  webApiLastTest.value = null
  try {
    const payloads = buildK3WiseSetupPayloads(form)
    const webApi = await upsertIntegrationSystem(payloads.webApi)
    form.webApiSystemId = webApi.id
    form.webApiHasCredentials = webApi.hasCredentials === true
    form.authorityCode = ''
    form.acctId = ''
    form.username = ''
    form.password = ''
    if (payloads.sqlServer) {
      const sql = await upsertIntegrationSystem(payloads.sqlServer)
      form.sqlSystemId = sql.id
      form.sqlHasCredentials = sql.hasCredentials === true
      form.sqlUsername = ''
      form.sqlPassword = ''
    }
    await loadSystems(true)
    setStatus('K3 WISE 预设配置已保存', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    saving.value = false
  }
}

async function testWebApi(): Promise<void> {
  if (!form.webApiSystemId || hasUnsavedWebApiConnectionDraft.value) return
  testingWebApi.value = true
  testResult.value = ''
  try {
    const result = await testIntegrationSystem(form.webApiSystemId, buildConnectionTestPayload())
    testResult.value = JSON.stringify(result, null, 2)
    const testedSystem = getTestResultSystem(result)
    if (testedSystem) upsertLocalWebApiSystem(testedSystem)
    const lastTestedAt = testedSystem?.lastTestedAt || new Date().toISOString()
    const lastError = typeof result.message === 'string' ? result.message : testedSystem?.lastError || null
    webApiLastTest.value = {
      systemId: form.webApiSystemId,
      ok: result.ok === true,
      lastTestedAt,
      lastError,
    }
    testingWebApi.value = false
    void loadSystems(true)
    setStatus(result.ok === true ? 'WebAPI 连接测试完成' : 'WebAPI 连接测试失败', result.ok === true ? 'success' : 'error')
  } catch (error) {
    webApiLastTest.value = {
      systemId: form.webApiSystemId,
      ok: false,
      lastTestedAt: new Date().toISOString(),
      lastError: formatError(error),
    }
    setStatus(formatError(error), 'error')
  } finally {
    testingWebApi.value = false
  }
}

async function testSqlServer(): Promise<void> {
  if (!form.sqlSystemId || hasUnsavedSqlConnectionDraft.value) return
  testingSql.value = true
  testResult.value = ''
  try {
    const result = await testIntegrationSystem(form.sqlSystemId, buildConnectionTestPayload())
    testResult.value = JSON.stringify(result, null, 2)
    await loadSystems(true)
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
  stagingInstallResult.value = null
  try {
    const result = await installIntegrationStaging(buildK3WiseStagingInstallPayload(form))
    if (result.projectId) form.projectId = result.projectId
    stagingInstallResult.value = result
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
  void loadSystems(true)
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

.k3-setup__hint {
  margin: 6px 0 0;
  color: #9a3412;
  font-size: 12px;
  line-height: 1.4;
}

.k3-setup__hint--strong {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid #facc15;
  border-radius: 6px;
  padding: 10px;
  background: #fefce8;
  color: #744600;
}

.k3-setup__hint--strong span {
  min-width: 0;
  overflow-wrap: anywhere;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 12px;
  background: #fff;
  color: #172033;
  font: inherit;
  cursor: pointer;
  text-decoration: none;
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

.k3-setup__btn--compact {
  flex: 0 0 auto;
  white-space: nowrap;
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

.k3-setup__commands {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.k3-setup__command {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.k3-setup__command-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.k3-setup__command-head strong {
  color: #334155;
  font-size: 12px;
}

.k3-setup__command-copy {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 3px 8px;
  background: #fff;
  color: #334155;
  font-size: 12px;
  cursor: pointer;
}

.k3-setup__command-copy:hover {
  border-color: #94a3b8;
  background: #f8fafc;
}

.k3-setup__commands code {
  display: block;
  overflow-wrap: anywhere;
  border-radius: 6px;
  padding: 8px;
  background: #f1f5f9;
  color: #172033;
  font-size: 12px;
}

.k3-setup__command--env code {
  white-space: pre-wrap;
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

.k3-setup__open-targets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.k3-setup__open-target {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  min-width: 0;
  border: 1px solid #ccfbf1;
  border-radius: 6px;
  padding: 10px;
  background: #f0fdfa;
}

.k3-setup__open-target div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.k3-setup__open-target strong,
.k3-setup__open-target small {
  overflow-wrap: anywhere;
}

.k3-setup__open-target strong {
  color: #115e59;
  font-size: 13px;
}

.k3-setup__open-target small {
  color: #475569;
  font-size: 12px;
  line-height: 1.35;
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

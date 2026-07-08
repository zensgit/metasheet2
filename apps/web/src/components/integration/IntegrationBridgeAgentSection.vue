<template>
  <section id="int-sec-bridge-agent" class="integration-workbench__panel" data-testid="bridge-agent-section">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>{{ bi('Bridge Agent 观测', 'Bridge Agent Observability') }}</h2>
            <p>{{ bi(
              '只读可观测：查看已注册 Bridge Agent 实例的连通状态、暴露对象与 schema 形状。本区没有写入路径、没有本机 config 编辑入口，也不会触发计划任务的启停。',
              'Read-only observability: check the reachability, exposed objects, and schema shape of registered Bridge Agent instances. This section has no write path, no local-config editing, and never starts or stops a scheduled task.',
            ) }}</p>
          </div>
          <button
            v-if="bridgeSystems.length > 0"
            type="button"
            class="integration-workbench__button"
            data-testid="bridge-agent-check-all"
            :disabled="checkingAll"
            @click="checkAll"
          >
            <el-icon><Refresh /></el-icon>
            {{ checkingAll ? bi('检查中…', 'Checking…') : bi('全部检查', 'Check all') }}
          </button>
        </div>
      </template>

      <div v-if="bridgeSystems.length === 0" class="integration-workbench__empty" data-testid="bridge-agent-empty-state">
        <strong data-testid="bridge-agent-empty-what">{{ bi(
          '这里展示已注册的 Bridge Agent 实例（kind = bridge:legacy-sql-readonly）的在线状态、暴露对象与 schema 预览。',
          'This shows the online status, exposed objects, and schema preview of registered Bridge Agent instances (kind = bridge:legacy-sql-readonly).',
        ) }}</strong>
        <p data-testid="bridge-agent-empty-first-step">{{ bi(
          '第一步：在上方“连接管理”区新增一个连接，类型选择只读 Bridge Agent；本机 Agent 通常由实施人员按 runbook 部署后再在此注册。',
          'First step: add a connection in the “Connections” area above and choose the read-only Bridge Agent type — the local agent is usually deployed per the runbook by an implementer before it is registered here.',
        ) }}</p>
      </div>

      <template v-else>
        <div class="bridge-agent__cards" data-testid="bridge-agent-cards">
          <div
            v-for="system in bridgeSystems"
            :key="system.id"
            class="bridge-agent__card"
            :data-testid="`bridge-agent-card-${system.id}`"
          >
            <div class="bridge-agent__card-head">
              <el-icon class="bridge-agent__card-icon"><Connection /></el-icon>
              <strong :data-testid="`bridge-agent-card-name-${system.id}`">{{ system.name }}</strong>
              <span class="bridge-agent__badge bridge-agent__badge--readonly" :data-testid="`bridge-agent-card-readonly-${system.id}`">
                <el-icon><Lock /></el-icon>{{ bi('只读', 'Read-only') }}
              </span>
            </div>
            <div class="bridge-agent__card-body">
              <span
                class="bridge-agent__badge"
                :class="statusBadgeClass(system.id)"
                :data-status="statusDataAttr(system.id)"
                :data-testid="`bridge-agent-card-status-${system.id}`"
              >{{ statusLabel(system.id) }}</span>
              <span class="bridge-agent__meta" :data-testid="`bridge-agent-card-checked-at-${system.id}`">
                {{ bi('最近检查：', 'Last checked: ') }}{{ formatCheckedAt(system.id) }}
              </span>
            </div>
            <p v-if="statusErrorLabel(system.id)" class="bridge-agent__error" :data-testid="`bridge-agent-card-error-${system.id}`">
              {{ statusErrorLabel(system.id) }}
            </p>
            <button
              type="button"
              class="integration-workbench__button"
              :data-testid="`bridge-agent-card-check-${system.id}`"
              :disabled="isChecking(system.id)"
              @click="checkSystem(system)"
            >
              <el-icon><Refresh /></el-icon>
              {{ isChecking(system.id) ? bi('检查中…', 'Checking…') : bi('检查连接', 'Check connection') }}
            </button>
            <button
              type="button"
              class="integration-workbench__button"
              :data-testid="`bridge-agent-probe-${system.id}`"
              :disabled="isProbing(system.id)"
              @click="runProbe(system)"
            >
              <el-icon><Refresh /></el-icon>
              {{ isProbing(system.id) ? bi('探测中…', 'Probing…') : bi('一键探测', 'One-click probe') }}
            </button>

            <div
              v-if="probeResultFor(system.id)"
              class="bridge-agent__probe-evidence"
              :data-testid="`bridge-agent-probe-evidence-${system.id}`"
            >
              <h4>{{ bi('探测证据（values-free）', 'Probe evidence (values-free)') }}</h4>
              <p
                class="bridge-agent__probe-overall"
                :data-result="probeResultFor(system.id)!.overallPass ? 'pass' : 'fail'"
                :data-testid="`bridge-agent-probe-overall-${system.id}`"
              >{{ overallLabel(probeResultFor(system.id)!) }}</p>
              <ul>
                <li
                  v-for="step in probeResultFor(system.id)!.steps"
                  :key="step.step"
                  :data-testid="`bridge-agent-probe-step-${step.step}-${system.id}`"
                  :data-ok="step.ok ? 'true' : 'false'"
                >
                  <strong>{{ probeStepLabel(step.step) }}</strong>
                  <span> — ok: {{ step.ok ? 'true' : 'false' }}</span>
                  <span v-if="step.durationBucket"> · durationBucket: {{ step.durationBucket }}</span>
                  <span v-if="step.objectCount !== undefined"> · objectCount: {{ step.objectCount }}</span>
                  <span v-if="step.fieldCount !== undefined"> · fieldCount: {{ step.fieldCount }}</span>
                  <span v-if="step.skipped" :data-testid="`bridge-agent-probe-step-skipped-${system.id}`">
                    · {{ bi('未采样对象（对象列表为空）', 'no object sampled (empty object list)') }}
                  </span>
                  <template v-if="!step.ok">
                    <p
                      class="bridge-agent__error"
                      :data-testid="`bridge-agent-probe-step-error-${step.step}-${system.id}`"
                    >{{ probeStepErrorLabel(step) }}</p>
                    <p
                      class="bridge-agent__probe-guidance"
                      :data-testid="`bridge-agent-probe-step-guidance-${step.step}-${system.id}`"
                    >{{ probeStepGuidance(step.step, step.code) }}</p>
                  </template>
                </li>
              </ul>
            </div>

            <div
              class="bridge-agent__task-status"
              :data-testid="`bridge-agent-task-status-${system.id}`"
            >
              <h4>{{ bi('计划任务运行态提示', 'Scheduled task status (guidance)') }}</h4>
              <p class="bridge-agent__task-note" :data-testid="`bridge-agent-task-managed-${system.id}`">
                <el-icon><Clock /></el-icon>
                <span>{{ bi(
                  '按部署惯例：本 Agent 通常由本机 Windows 计划任务（Scheduled Task）常驻管理，而非本页直接控制。',
                  'By deployment convention: this Agent is normally kept running by a local Windows Scheduled Task, not controlled from this page.',
                ) }}</span>
              </p>
              <p
                :data-testid="`bridge-agent-task-last-check-${system.id}`"
                :data-result="taskLastCheckResult(system.id)"
              >{{ bi('最近探测结果（非任务运行态）：', 'Last probe result (not task run-state): ') }}{{ taskLastCheckLabel(system.id) }}</p>
              <p class="bridge-agent__task-guidance" :data-testid="`bridge-agent-task-guidance-${system.id}`">
                {{ bi(
                  '启动方式提示：安装/查看/启停计划任务由本机运维按 Bridge Agent 运维 runbook 操作；本页不提供启停或本机配置入口。',
                  'Start/stop guidance: installing, checking, or starting/stopping the scheduled task is done by local operations per the Bridge Agent ops runbook; this page provides no start/stop or local-config entry point.',
                ) }}
              </p>
            </div>
          </div>
        </div>

        <div class="bridge-agent__instances">
          <h3>{{ bi('实例列表', 'Instances') }}</h3>
          <table class="bridge-agent__table" data-testid="bridge-agent-instance-list">
            <thead>
              <tr>
                <th>{{ bi('名称', 'Name') }}</th>
                <th>
                  <el-tooltip :content="fieldHint('bridgeAgent.instancePicker')" placement="top">
                    <span>{{ bi('用途', 'Role') }}</span>
                  </el-tooltip>
                </th>
                <th>{{ bi('状态', 'Status') }}</th>
                <th>
                  <el-tooltip :content="fieldHint('bridgeAgent.credentialStatus')" placement="top">
                    <span>{{ bi('凭据', 'Credentials') }}</span>
                  </el-tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="system in bridgeSystems" :key="system.id" :data-testid="`bridge-agent-instance-row-${system.id}`">
                <td :data-testid="`bridge-agent-instance-name-${system.id}`">{{ system.name }}</td>
                <td>{{ roleLabel(system) }}</td>
                <td :data-testid="`bridge-agent-instance-status-${system.id}`">{{ coarseStatusLabel(system) }}</td>
                <td :data-testid="`bridge-agent-instance-credential-${system.id}`">{{ credentialLabel(system) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="bridge-agent__objects">
          <div class="bridge-agent__objects-head">
            <h3>{{ bi('对象列表', 'Objects') }}</h3>
            <label class="bridge-agent__instance-picker">
              <span>{{ bi('实例', 'Instance') }}</span>
              <select v-model="selectedSystemId" data-testid="bridge-agent-instance-picker">
                <option v-for="system in bridgeSystems" :key="system.id" :value="system.id">{{ system.name }}</option>
              </select>
            </label>
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="bridge-agent-objects-refresh"
              :disabled="objectsLoading"
              @click="loadObjects"
            >
              <el-icon><Refresh /></el-icon>
              {{ objectsLoading ? bi('加载中…', 'Loading…') : bi('刷新对象列表', 'Reload objects') }}
            </button>
          </div>

          <p v-if="objectsErrored" class="bridge-agent__error" data-testid="bridge-agent-objects-error">
            {{ bi('对象列表加载失败，请检查连接状态后重试。', 'Failed to load the object list; check the connection status and retry.') }}
          </p>

          <div v-if="objectsLoading" class="integration-workbench__hint" data-testid="bridge-agent-objects-loading">
            {{ bi('加载中…', 'Loading…') }}
          </div>

          <div
            v-else-if="objectsLoaded && objects.length === 0 && !objectsErrored"
            class="integration-workbench__empty"
            data-testid="bridge-agent-objects-empty"
          >
            <strong data-testid="bridge-agent-objects-empty-what">{{ bi(
              '该实例当前没有可读对象（本机 allowlist 为空）。',
              'This instance currently has no readable objects (the local allowlist is empty).',
            ) }}</strong>
            <p data-testid="bridge-agent-objects-empty-first-step">{{ bi(
              '第一步：在本机 Bridge Agent 配置中为该 endpoint 添加至少一个 allowlist 对象，再点击“刷新对象列表”。',
              'First step: add at least one allowlisted object to this endpoint in the local Bridge Agent config, then click “Reload objects”.',
            ) }}</p>
          </div>

          <table v-else-if="objects.length > 0" class="bridge-agent__table" data-testid="bridge-agent-objects-list">
            <thead>
              <tr>
                <th>{{ bi('对象', 'Object') }}</th>
                <th>Label</th>
                <th>
                  <el-tooltip :content="fieldHint('bridgeAgent.objectAllowlist')" placement="top">
                    <span>{{ bi('字段数', 'Fields') }}</span>
                  </el-tooltip>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="object in objects" :key="object.name">
                <tr :data-testid="`bridge-agent-object-row-${object.name}`">
                  <td>{{ object.name }}</td>
                  <td>{{ object.label || object.name }}</td>
                  <td :data-testid="`bridge-agent-object-field-count-${object.name}`">{{ formatFieldCount(object) }}</td>
                  <td>
                    <button
                      type="button"
                      class="integration-workbench__link-button"
                      :data-testid="`bridge-agent-object-schema-toggle-${object.name}`"
                      @click="toggleSchema(object.name)"
                    >{{ expandedObject === object.name ? bi('收起 schema', 'Hide schema') : bi('查看 schema', 'View schema') }}</button>
                  </td>
                </tr>
                <tr v-if="expandedObject === object.name" :data-testid="`bridge-agent-schema-row-${object.name}`">
                  <td colspan="4">
                    <div
                      v-if="schemaLoading[object.name]"
                      class="integration-workbench__hint"
                      :data-testid="`bridge-agent-schema-loading-${object.name}`"
                    >{{ bi('Schema 加载中…', 'Loading schema…') }}</div>
                    <p
                      v-else-if="schemaErrored[object.name]"
                      class="bridge-agent__error"
                      :data-testid="`bridge-agent-schema-error-${object.name}`"
                    >{{ bi('Schema 加载失败，请重试。', 'Failed to load the schema; retry.') }}</p>
                    <table
                      v-else-if="schemaByObject[object.name]"
                      class="bridge-agent__table"
                      :data-testid="`bridge-agent-schema-${object.name}`"
                    >
                      <thead>
                        <tr>
                          <th>{{ bi('字段', 'Field') }}</th>
                          <th>{{ bi('类型', 'Type') }}</th>
                          <th>
                            <el-tooltip :content="fieldHint('bridgeAgent.schemaPreview')" placement="top">
                              <span>{{ bi('必填', 'Required') }}</span>
                            </el-tooltip>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="field in schemaByObject[object.name]"
                          :key="field.name"
                          :data-testid="`bridge-agent-schema-field-${object.name}-${field.name}`"
                        >
                          <td>{{ field.name }}</td>
                          <td>{{ field.type || bi('未提供', 'N/A') }}</td>
                          <td>{{ field.required ? bi('是', 'Yes') : bi('否', 'No') }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <!-- BA-UI-3 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-3):
             values-free config-validation checklist, scoped to the instance selected above (reuses
             `selectedSystemId` + the already-fetched `objects` — zero new network calls). -->
        <div class="bridge-agent__config-check" data-testid="bridge-agent-config-check">
          <h3>
            <el-icon class="bridge-agent__card-icon"><List /></el-icon>
            {{ bi('配置校验', 'Config validation') }}
          </h3>
          <p class="integration-workbench__hint">{{ bi(
            '针对当前选中实例的公开配置形状与已加载的对象列表做只读校验；只显示通过/提示/未通过状态与固定说明文字，不回显任何具体配置值。',
            "Read-only checklist against the selected instance's public config shape and the already-loaded object list; only a pass/attention/fail status and fixed copy are shown — no configuration value is ever echoed.",
          ) }}</p>
          <ul class="bridge-agent__checklist" data-testid="bridge-agent-config-check-list">
            <li
              v-for="item in configCheckItems"
              :key="item.id"
              class="bridge-agent__checklist-item"
              :data-testid="`bridge-agent-config-check-item-${item.id}`"
              :data-status="item.status"
            >
              <el-icon
                class="bridge-agent__checklist-icon"
                :class="`bridge-agent__checklist-icon--${item.status}`"
              >
                <CircleCheck v-if="item.status === 'pass'" />
                <Warning v-else-if="item.status === 'warn'" />
                <CircleClose v-else />
              </el-icon>
              <span class="bridge-agent__checklist-title">{{ configCheckTitleLabel(item.id) }}</span>
              <span
                class="bridge-agent__badge"
                :class="`bridge-agent__badge--check-${item.status}`"
              >{{ configCheckStatusLabel(item.status) }}</span>
              <span
                class="bridge-agent__checklist-text"
                :data-testid="`bridge-agent-config-check-item-label-${item.id}`"
              >{{ configCheckItemLabel(item) }}</span>
            </li>
          </ul>
        </div>

        <!-- BA-UI-3: change-suggestion / implementation checklist builder — operator-typed object/
             field-KEY names (never values) -> a values-free, copyable suggestion text. Purely local:
             no apply endpoint, no local-config write, no .ps1 invocation (lock §3). -->
        <div class="bridge-agent__suggestion" data-testid="bridge-agent-suggestion-builder">
          <h3>
            <el-icon class="bridge-agent__card-icon"><DocumentCopy /></el-icon>
            {{ bi('变更建议 / 实施清单', 'Change suggestion / implementation checklist') }}
          </h3>
          <p class="integration-workbench__hint">{{ bi(
            '在此列出你希望新增暴露的对象与字段名（仅名称，不涉及任何取值）；生成的建议文本供人工确认后，由受控后端或运维脚本落地——本页不会据此做任何直接修改，也不会调用任何写入接口。',
            'List the objects and field-key names you want to newly expose here (names only, never values); the generated suggestion text is for a human to hand to the controlled backend or ops script to apply — this page never makes any direct change or calls any write endpoint from it.',
          ) }}</p>

          <div
            v-for="(row, index) in suggestionDrafts"
            :key="index"
            class="bridge-agent__suggestion-row"
            :data-testid="`bridge-agent-suggestion-row-${index}`"
          >
            <label class="bridge-agent__suggestion-field">
              <span>{{ bi('对象名', 'Object name') }}</span>
              <input
                v-model="row.objectName"
                type="text"
                :data-testid="`bridge-agent-suggestion-object-${index}`"
                :placeholder="bi('例如 material_extra', 'e.g. material_extra')"
              >
            </label>
            <label class="bridge-agent__suggestion-field">
              <span>{{ bi('字段名（逗号分隔）', 'Field names (comma-separated)') }}</span>
              <input
                v-model="row.fieldKeysText"
                type="text"
                :data-testid="`bridge-agent-suggestion-fields-${index}`"
                :placeholder="bi('例如 field_a, field_b', 'e.g. field_a, field_b')"
              >
            </label>
            <button
              type="button"
              class="integration-workbench__link-button"
              :data-testid="`bridge-agent-suggestion-remove-${index}`"
              :disabled="suggestionDrafts.length <= 1"
              @click="removeSuggestionDraftRow(index)"
            >{{ bi('删除', 'Remove') }}</button>
          </div>
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="bridge-agent-suggestion-add-row"
            @click="addSuggestionDraftRow"
          >{{ bi('添加一行', 'Add row') }}</button>

          <div
            v-if="suggestionResult.entries.length === 0"
            class="integration-workbench__empty"
            data-testid="bridge-agent-suggestion-empty"
          >
            <strong data-testid="bridge-agent-suggestion-empty-what">{{ bi(
              '这里会把上面填写的对象/字段名整理成一份可复制的变更建议文本。',
              'This turns the object/field names you enter above into a copyable change-suggestion text.',
            ) }}</strong>
            <p data-testid="bridge-agent-suggestion-empty-first-step">{{ bi(
              '第一步：在上方填写至少一个对象名（可选填字段名），建议文本会自动生成。',
              'First step: enter at least one object name above (field names are optional); the suggestion text is generated automatically.',
            ) }}</p>
          </div>
          <div v-else class="bridge-agent__suggestion-output">
            <h4>{{ bi('生成的建议文本（可复制）', 'Generated suggestion text (copyable)') }}</h4>
            <textarea
              class="bridge-agent__suggestion-text"
              data-testid="bridge-agent-suggestion-text"
              readonly
              :value="suggestionResult.text"
            />
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="bridge-agent-suggestion-copy"
              @click="copySuggestionText"
            >
              <el-icon><DocumentCopy /></el-icon>
              {{ bi('复制建议文本', 'Copy suggestion text') }}
            </button>
            <span
              v-if="copyState === 'copied'"
              data-testid="bridge-agent-suggestion-copy-state"
              class="integration-workbench__hint"
            >{{ bi('已复制', 'Copied') }}</span>
            <span
              v-else-if="copyState === 'failed'"
              data-testid="bridge-agent-suggestion-copy-state"
              class="bridge-agent__error"
            >{{ bi('复制失败，请手动选择文本复制。', 'Copy failed; select the text manually to copy.') }}</span>
          </div>

          <!-- BA-APPLY-1 (docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2
               形态 A, #3876): export the SAME drafts as a machine-readable, values-free implementation
               checklist. Independently gated (own guided-empty state), sibling to the prose suggestion
               above rather than nested inside it. EXPORT/render only — no apply endpoint, no write, no
               Agent write. -->
          <div class="bridge-agent__checklist-export">
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="bridge-agent-checklist-export"
              @click="toggleChecklist"
            >
              <el-icon><DocumentCopy /></el-icon>
              {{ checklistVisible ? bi('收起实施清单', 'Hide implementation checklist') : bi('导出实施清单', 'Export implementation checklist') }}
            </button>

            <template v-if="checklistVisible">
              <p class="integration-workbench__hint">{{ bi(
                '机读格式：仅含对象名、字段键名与固定操作枚举（add_readonly_object / add_readonly_field），不含取值/host/凭据/自由文本；本导出不会调用任何写入接口，也不会做任何直接修改——供人工确认后交由受控后端或运维脚本按既有 runbook 应用。',
                'Machine-readable: object names, field-key names, and a fixed operation enum only (add_readonly_object / add_readonly_field) — never a value/host/credential/free-form text; this export calls no write endpoint and makes no direct change — a human hands it to the controlled backend or an ops script to apply per the existing runbook.',
              ) }}</p>

              <div
                v-if="implementationChecklist.checklist.operations.length === 0"
                class="integration-workbench__empty"
                data-testid="bridge-agent-checklist-empty"
              >
                <strong data-testid="bridge-agent-checklist-empty-what">{{ bi(
                  '这里会把上面填写的对象/字段名整理成一份机读的实施清单（JSON）。',
                  'This turns the object/field names you enter above into a machine-readable implementation checklist (JSON).',
                ) }}</strong>
                <p data-testid="bridge-agent-checklist-empty-first-step">{{ bi(
                  '第一步：在上方填写至少一个对象名（可选填字段名），清单会自动生成。',
                  'First step: enter at least one object name above (field names are optional); the checklist is generated automatically.',
                ) }}</p>
              </div>
              <div v-else class="bridge-agent__suggestion-output" data-testid="bridge-agent-checklist-output">
                <h4>{{ bi('机读实施清单（JSON，可复制/下载）', 'Machine-readable implementation checklist (JSON; copyable/downloadable)') }}</h4>
                <textarea
                  class="bridge-agent__suggestion-text"
                  data-testid="bridge-agent-checklist-text"
                  readonly
                  :value="checklistText"
                />
                <button
                  type="button"
                  class="integration-workbench__button"
                  data-testid="bridge-agent-checklist-copy"
                  @click="copyChecklistText"
                >
                  <el-icon><DocumentCopy /></el-icon>
                  {{ bi('复制清单 JSON', 'Copy checklist JSON') }}
                </button>
                <button
                  type="button"
                  class="integration-workbench__button"
                  data-testid="bridge-agent-checklist-download"
                  @click="downloadChecklistJson"
                >
                  <el-icon><DocumentCopy /></el-icon>
                  {{ bi('下载清单 JSON', 'Download checklist JSON') }}
                </button>
                <span
                  v-if="checklistCopyState === 'copied'"
                  data-testid="bridge-agent-checklist-copy-state"
                  class="integration-workbench__hint"
                >{{ bi('已复制', 'Copied') }}</span>
                <span
                  v-else-if="checklistCopyState === 'failed'"
                  data-testid="bridge-agent-checklist-copy-state"
                  class="bridge-agent__error"
                >{{ bi('复制失败，请手动选择文本复制。', 'Copy failed; select the text manually to copy.') }}</span>
              </div>
            </template>
          </div>
        </div>
      </template>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// BA-UI-1 (docs/development/bridge-agent-admin-page-design-lock-20260707.md): Bridge Agent read-only
// observability section. Self-contained (same shape as IntegrationReadSourceConfigPanel.vue) — the
// parent view hands down the already-fetched `systems` list + `scope`; this component owns its own
// local state/service calls for the three READ-ONLY generic routes it consumes: POST
// /external-systems/:id/test, GET /external-systems/:id/objects, GET /external-systems/:id/schema.
// ZERO new backend routes (see the BA-UI-1 verification MD's scout findings) and ZERO write path —
// this file never references an upsert/delete/pipeline/dead-letter/staging service function, and
// `POST /query/:object` (the data-plane read) is never called here either (design-lock §4).
//
// Security bounds (lock §2.1, binding):
//   - No credential/host/connection-string is ever rendered — only the coarse `system.hasCredentials`
//     boolean ("已配置/未配置"), never `system.credentials`. BA-UI-3 (below) is a lock-authorized,
//     narrower exception for `system.config`: its pure checklist (bridgeAgentConfigCheck.ts) reads a
//     handful of `system.config` KEY NAMES for PRESENCE/SHAPE only (is baseUrl set? is its hostname
//     loopback-shaped? is authMode declared? …) — no config VALUE is ever placed into the DOM, only a
//     fixed pass/warn/fail status + a non-interpolated `labelKey` string. `system.config` itself is
//     still never read directly by THIS file — only handed, opaque, to the pure util below.
//   - No raw error text is ever rendered. Every failure surface routes through the IU-1
//     `integrationErrorCodeDisplayLabel` helper (label-only). Unlike the closed, backend-owned code
//     families IU-1 already labels, a Bridge Agent HTTP error body can carry an operator-supplied
//     `error.code` (see errorCodeLabels.ts's BRIDGE_AGENT_* comment) — so even the registered CODE
//     STRING itself is never interpolated into the DOM here, only its mapped display label (an
//     unregistered/dynamic code safely degrades to the generic "unknown error" label). Object/schema
//     load failures carry no code at all (the shared `parseIntegrationResponse` helper does not
//     preserve one), so those use a fixed, values-free bilingual string.
//   - BA-UI-3's change-suggestion builder (buildBridgeAgentChangeSuggestion) never calls any apply
//     endpoint, never edits local config, never touches the .ps1 script — it is a pure, local text
//     generator from OPERATOR-TYPED object/field-KEY names (never values), gated by an identifier-safe
//     pattern so a secret/host/connection-string-shaped string typed into a name field is dropped
//     (counted, never echoed) rather than rendered (lock §3: applied only by a controlled backend or
//     ops script, never this page).
import { computed, reactive, ref, watch } from 'vue'
import { CircleCheck, CircleClose, Clock, Connection, DocumentCopy, List, Lock, Refresh, Warning } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import {
  bridgeAgentConfigCheckLabel,
  buildBridgeAgentChangeSuggestion,
  buildImplementationChecklist,
  computeBridgeAgentConfigCheck,
  type BridgeAgentConfigCheckItem,
  type BridgeAgentConfigCheckStatus,
  type BridgeAgentSuggestionObjectDraft,
} from '../../services/integration/bridgeAgentConfigCheck'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../../services/integration/errorCodeLabels'
import { integrationFieldHint, type IntegrationFieldHintKey } from '../../services/integration/fieldHints'
import {
  getExternalSystemSchema,
  listExternalSystemObjects,
  testExternalSystemConnection,
  type IntegrationObjectSchemaField,
  type IntegrationScope,
  type IntegrationSystemObject,
  type WorkbenchExternalSystem,
} from '../../services/integration/workbench'

// The one external-system kind this section observes — mirrors
// plugins/plugin-integration-core/index.cjs's `.registerAdapter('bridge:legacy-sql-readonly', ...)`.
const BRIDGE_AGENT_KIND = 'bridge:legacy-sql-readonly'

const props = defineProps<{
  systems: WorkbenchExternalSystem[]
  scope: IntegrationScope
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}
function fieldHint(key: IntegrationFieldHintKey): string {
  return integrationFieldHint(key, locale.value)
}

const bridgeSystems = computed(() => props.systems.filter((system) => system.kind === BRIDGE_AGENT_KIND))

// --- Agent status cards (testConnection) -------------------------------------------------------

interface CheckState {
  checking: boolean
  hasChecked: boolean
  ok: boolean
  code: string | null
  checkedAt: string | null
}

// Read-only default for render-time lookups: the template helpers below must NEVER create/mutate
// reactive entries during render (that would schedule a redundant re-render pass); only
// checkSystem writes into checkStates.
const UNCHECKED_STATE: Readonly<CheckState> = Object.freeze({
  checking: false,
  hasChecked: false,
  ok: false,
  code: null,
  checkedAt: null,
})

const checkStates = reactive<Record<string, CheckState>>({})
const checkingAll = ref(false)

function stateFor(systemId: string): Readonly<CheckState> {
  return checkStates[systemId] || UNCHECKED_STATE
}

function isChecking(systemId: string): boolean {
  return stateFor(systemId).checking
}

async function checkSystem(system: WorkbenchExternalSystem): Promise<void> {
  checkStates[system.id] = { ...stateFor(system.id), checking: true }
  let ok = false
  let code: string | null = null
  try {
    const result = await testExternalSystemConnection(system.id, props.scope)
    ok = result.ok === true
    code = typeof result.code === 'string' ? result.code : null
  } catch {
    ok = false
    code = null
  }
  checkStates[system.id] = {
    checking: false,
    hasChecked: true,
    ok,
    code,
    // Client-side "most recent check" timestamp — the platform's clock, not a value read off the wire.
    checkedAt: new Date().toISOString(),
  }
}

async function checkAll(): Promise<void> {
  checkingAll.value = true
  try {
    for (const system of bridgeSystems.value) {
      // Sequential, one instance at a time: a gentle probe cadence rather than a concurrent burst
      // against what is typically a single localhost Bridge Agent process per instance.
      // eslint-disable-next-line no-await-in-loop
      await checkSystem(system)
    }
  } finally {
    checkingAll.value = false
  }
}

function statusLabel(systemId: string): string {
  const state = stateFor(systemId)
  if (state.checking) return bi('检查中…', 'Checking…')
  if (!state.hasChecked) return bi('尚未检查', 'Not checked yet')
  return state.ok ? bi('在线', 'Online') : bi('离线', 'Offline')
}

function statusDataAttr(systemId: string): 'unknown' | 'online' | 'offline' {
  const state = stateFor(systemId)
  if (!state.hasChecked) return 'unknown'
  return state.ok ? 'online' : 'offline'
}

function statusBadgeClass(systemId: string): string {
  const attr = statusDataAttr(systemId)
  if (attr === 'online') return 'bridge-agent__badge--online'
  if (attr === 'offline') return 'bridge-agent__badge--offline'
  return ''
}

// Label-only — see the script-block security-bounds note: neither the raw code nor the raw message
// is ever interpolated into the template, only this mapped, closed-vocabulary display string.
function statusErrorLabel(systemId: string): string | null {
  const state = stateFor(systemId)
  if (!state.hasChecked || state.ok) return null
  return integrationErrorCodeDisplayLabel(state.code, locale.value)
}

function formatCheckedAt(systemId: string): string {
  const iso = stateFor(systemId).checkedAt
  if (!iso) return bi('从未', 'Never')
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
}

// --- Instance list (values-free: name / role / coarse status / credential boolean only) --------

function roleLabel(system: WorkbenchExternalSystem): string {
  if (system.role === 'target') return bi('目标', 'Target')
  if (system.role === 'bidirectional') return bi('双向', 'Bidirectional')
  return bi('数据源', 'Source')
}

function coarseStatusLabel(system: WorkbenchExternalSystem): string {
  if (system.status === 'active') return bi('启用', 'Active')
  if (system.status === 'inactive') return bi('停用', 'Inactive')
  return bi('异常', 'Error')
}

// Lock §2.1: "凭据状态最多'已配置/未配置'布尔" — never anything more specific than this boolean
// (never system.config, never system.credentials, never system.lastError).
function credentialLabel(system: WorkbenchExternalSystem): string {
  return system.hasCredentials ? bi('已配置', 'Configured') : bi('未配置', 'Not configured')
}

// --- Selected instance -> objects ---------------------------------------------------------------

const selectedSystemId = ref('')

const objects = ref<IntegrationSystemObject[]>([])
const objectsLoading = ref(false)
const objectsLoaded = ref(false)
const objectsErrored = ref(false)

async function loadObjects(): Promise<void> {
  const systemId = selectedSystemId.value
  if (!systemId) {
    objects.value = []
    objectsLoaded.value = false
    return
  }
  objectsLoading.value = true
  objectsErrored.value = false
  try {
    objects.value = await listExternalSystemObjects(systemId, props.scope)
  } catch {
    // Fixed, values-free copy only — never the thrown error's message (see security-bounds note).
    objects.value = []
    objectsErrored.value = true
  } finally {
    objectsLoading.value = false
    objectsLoaded.value = true
  }
}

// keyField is not currently part of the /objects wire shape (see the BA-UI-1 verification MD's
// backend-scout finding) — render fieldCount when present, an explicit N/A otherwise, never a guess.
function formatFieldCount(object: IntegrationSystemObject): string {
  return typeof object.fieldCount === 'number' ? String(object.fieldCount) : bi('未提供', 'N/A')
}

// --- Per-object schema preview (fetched on demand, cached per object name) ----------------------

const expandedObject = ref('')
const schemaLoading = reactive<Record<string, boolean>>({})
const schemaErrored = ref<Record<string, boolean>>({})
const schemaByObject = ref<Record<string, IntegrationObjectSchemaField[]>>({})

async function toggleSchema(objectName: string): Promise<void> {
  if (expandedObject.value === objectName) {
    expandedObject.value = ''
    return
  }
  expandedObject.value = objectName
  if (schemaByObject.value[objectName] || !selectedSystemId.value) return
  schemaLoading[objectName] = true
  schemaErrored.value = { ...schemaErrored.value, [objectName]: false }
  try {
    const schema = await getExternalSystemSchema(selectedSystemId.value, { ...props.scope, object: objectName })
    // Explicit field mapping (name/type/required) only — never a spread of unknown keys, so an
    // unexpected extra key on the wire response can never ride along into the DOM.
    schemaByObject.value = {
      ...schemaByObject.value,
      [objectName]: schema.fields.map((field) => ({ name: field.name, type: field.type, required: field.required })),
    }
  } catch {
    schemaErrored.value = { ...schemaErrored.value, [objectName]: true }
  } finally {
    schemaLoading[objectName] = false
  }
}

// --- BA-UI-2 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-2): values-
// free one-click probe. Sequential health -> objects -> schema, early-stopping at the first step that
// fails (a later step is simply never called — no partial/best-effort continuation). Reuses the exact
// same three read-only generic service calls the rest of this section already consumes above
// (testExternalSystemConnection / listExternalSystemObjects / getExternalSystemSchema) — ZERO new
// backend routes, zero new credential path. Evidence is ephemeral component state only (no
// persistence/backend storage; BA-UI-3's change-suggestion flow is a later, unopened slice).
//
// Evidence vocabulary (values-free, per lock §3): ok (boolean) / durationBucket (coarse bucket, never
// a raw millisecond count that could fingerprint infra) / objectCount (objects step) / fieldCount of a
// single SAMPLED object (schema step, never the object's name or any field value) / a humanized error
// label + guidance line on failure, both routed through the IU-1 `errorCodeLabels` module (never a raw
// code string, never a raw error message — see the script-block security-bounds note above, which this
// slice does not relax).

type ProbeStepKey = 'health' | 'objects' | 'schema'
type DurationBucket = '<1s' | '1-5s' | '>5s'

interface ProbeStepResult {
  step: ProbeStepKey
  ok: boolean
  // Absent only for the schema step when it is SKIPPED (objects step returned zero objects — nothing
  // to sample; this is not a failure, so no fetch/timing happened for this step).
  durationBucket?: DurationBucket
  objectCount?: number // objects step only
  fieldCount?: number // schema step only — field count of the single sampled object
  skipped?: boolean // schema step only
  // Real registered code for a health failure (its response carries `.code`); ALWAYS null for
  // objects/schema failures — their thrown Error carries no machine-readable code (BA-UI-1 scout
  // finding: workbench.ts's parseIntegrationResponse only preserves `.message`). Routing a `null` code
  // through the same IU-1 label helper still yields a coarse, values-free "unknown error" label — it is
  // deliberately NOT a special-cased string here.
  code: string | null
}

interface ProbeRunResult {
  overallPass: boolean
  failedStep: ProbeStepKey | null
  steps: ProbeStepResult[]
}

const probing = reactive<Record<string, boolean>>({})
const probeResults = reactive<Record<string, ProbeRunResult>>({})

function isProbing(systemId: string): boolean {
  return Boolean(probing[systemId])
}

function probeResultFor(systemId: string): ProbeRunResult | null {
  return probeResults[systemId] || null
}

function bucketFor(durationMs: number): DurationBucket {
  if (durationMs < 1000) return '<1s'
  if (durationMs < 5000) return '1-5s'
  return '>5s'
}

// Times a step and normalizes both the success and throw paths into one shape — `Date.now()` (not
// `performance.now()`) so tests can pin exact deltas via `vi.spyOn(Date, 'now')` without needing fake
// timers to cooperate with real microtask scheduling.
async function measureStep<T>(
  fn: () => Promise<T>,
): Promise<{ durationBucket: DurationBucket; value: T | null; threw: boolean }> {
  const start = Date.now()
  try {
    const value = await fn()
    return { durationBucket: bucketFor(Date.now() - start), value, threw: false }
  } catch {
    return { durationBucket: bucketFor(Date.now() - start), value: null, threw: true }
  }
}

function probeStepLabel(step: ProbeStepKey): string {
  if (step === 'health') return bi('健康检查', 'Health check')
  if (step === 'objects') return bi('对象列表', 'Objects')
  return bi('Schema 预览', 'Schema preview')
}

// Always routed through the IU-1 module — see the `code` field comment on ProbeStepResult above for
// why a `null` code (objects/schema) is expected and still renders a humanized, values-free label.
function probeStepErrorLabel(step: ProbeStepResult): string {
  return integrationErrorCodeDisplayLabel(step.code, locale.value)
}

const PROBE_STEP_FALLBACK_GUIDANCE: Record<ProbeStepKey, { zh: string; en: string }> = {
  health: {
    zh: '本机 Bridge Agent 可能未启动或不可达，请检查其计划任务/进程后重新探测。',
    en: 'The local Bridge Agent may not be running or reachable; check its scheduled task or process, then re-probe.',
  },
  objects: {
    zh: '请检查连接状态后重试对象列表探测。',
    en: 'Check the connection status, then retry the objects probe.',
  },
  schema: {
    zh: '请检查所采样对象是否仍在本机 allowlist 中后重试。',
    en: 'Check whether the sampled object is still allowlisted locally, then retry.',
  },
}

// A registered code's own hint (IU-6 hint style — e.g. BRIDGE_AGENT_UNREACHABLE/TIMEOUT already carry
// one) takes precedence when present; otherwise this fixed, values-free per-step fallback guarantees a
// guidance line always renders on failure, even for the codeless objects/schema routes.
function probeStepGuidance(step: ProbeStepKey, code: string | null): string {
  const hint = integrationErrorCodeHint(code, locale.value)
  if (hint) return hint
  return locale.value === 'zh-CN' ? PROBE_STEP_FALLBACK_GUIDANCE[step].zh : PROBE_STEP_FALLBACK_GUIDANCE[step].en
}

function overallLabel(result: ProbeRunResult): string {
  if (result.overallPass) return 'PASS'
  return `FAIL: ${probeStepLabel(result.failedStep as ProbeStepKey)}`
}

async function runProbe(system: WorkbenchExternalSystem): Promise<void> {
  const systemId = system.id
  probing[systemId] = true
  const steps: ProbeStepResult[] = []
  let failedStep: ProbeStepKey | null = null
  try {
    // Step 1/3: health — the SAME generic test route the status card above uses.
    const health = await measureStep(() => testExternalSystemConnection(systemId, props.scope))
    const healthOk = !health.threw && health.value?.ok === true
    const healthCode = !healthOk && !health.threw && typeof health.value?.code === 'string' ? health.value.code : null
    steps.push({ step: 'health', ok: healthOk, durationBucket: health.durationBucket, code: healthCode })
    if (!healthOk) {
      failedStep = 'health'
      return
    }

    // Step 2/3: objects — early-stop here means schema (step 3) is NEVER called.
    const objects = await measureStep(() => listExternalSystemObjects(systemId, props.scope))
    const objectsOk = !objects.threw
    steps.push({
      step: 'objects',
      ok: objectsOk,
      durationBucket: objects.durationBucket,
      objectCount: objectsOk ? (objects.value?.length ?? 0) : undefined,
      code: null,
    })
    if (!objectsOk) {
      failedStep = 'objects'
      return
    }

    // Step 3/3: schema of a single sampled object (the first object returned). An empty allowlist
    // (objectCount === 0) is NOT a failure — there is simply nothing to sample, so this step is marked
    // skipped rather than run.
    const sample = objects.value && objects.value.length > 0 ? objects.value[0] : null
    if (!sample) {
      steps.push({ step: 'schema', ok: true, skipped: true, code: null })
      return
    }
    const schema = await measureStep(() => getExternalSystemSchema(systemId, { ...props.scope, object: sample.name }))
    const schemaOk = !schema.threw
    steps.push({
      step: 'schema',
      ok: schemaOk,
      durationBucket: schema.durationBucket,
      fieldCount: schemaOk ? (schema.value?.fields.length ?? 0) : undefined,
      code: null,
    })
    if (!schemaOk) failedStep = 'schema'
  } finally {
    probeResults[systemId] = { overallPass: failedStep === null, failedStep, steps }
    probing[systemId] = false
  }
}

// --- BA-UI-4 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-4): a
// read-only "scheduled task status" guidance card. FIRST version, per lock: "只读显示，不
// start/stop" — no control of any kind lives in this file for the scheduled task (no button, no
// service call, no local-config write).
//
// Why this renders STATIC guidance rather than a live task-state field: the BA-UI-1 backend scout
// established that none of the three generic routes this section consumes expose Windows Scheduled
// Task state. `testConnection()`'s `/health`-derived `status`/`ok`/`connected` fields describe HTTP
// reachability of the Agent process, not whether the OS scheduled task that launched it is
// Running/Stopped/Ready — that distinction only exists on the host, surfaced by
// `scripts/ops/bridge-agent-readonly-scheduled-task.ps1 -Action Status` (which itself deliberately
// avoids calling `/health` — see the runbook). No new backend route is added to bridge that gap
// (out of this slice's authorization; the lock's zero-new-route posture from BA-UI-1/2 continues
// unchanged). So rather than inventing a "running/stopped" badge from data that was never asked for,
// this card renders (a) a fixed, values-free statement of the deployment convention, (b) the
// existing BA-UI-2 probe's last COARSE outcome relabeled as what it actually is (a reachability
// probe result, not task run-state), and (c) a fixed pointer to the runbook process for anyone who
// needs to actually install/inspect/start/stop the task.
function taskLastCheckResult(systemId: string): 'pass' | 'fail' | 'unknown' {
  const result = probeResultFor(systemId)
  if (!result) return 'unknown'
  return result.overallPass ? 'pass' : 'fail'
}

// Deliberately coarse (lock §3 BA-UI-4: "PASS/FAIL/未探测 coarse only") — unlike `overallLabel()`
// above (which names the failed step for the probe-evidence panel), this card never names a step;
// it only ever renders one of the three words below.
function taskLastCheckLabel(systemId: string): string {
  const result = taskLastCheckResult(systemId)
  if (result === 'unknown') return bi('未探测', 'Not probed yet')
  return result === 'pass' ? 'PASS' : 'FAIL'
}

watch(
  bridgeSystems,
  (list) => {
    if (list.length === 0) {
      selectedSystemId.value = ''
      return
    }
    if (!list.some((system) => system.id === selectedSystemId.value)) {
      selectedSystemId.value = list[0].id
    }
  },
  { immediate: true },
)

watch(
  selectedSystemId,
  () => {
    expandedObject.value = ''
    schemaByObject.value = {}
    schemaErrored.value = {}
    void loadObjects()
  },
  { immediate: true },
)

// --- BA-UI-3 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-3): config
// validation + change-suggestion checklist. Both cards are purely DERIVED/LOCAL — zero new network
// calls: the checklist is computed off state this section already holds (the selected instance's
// `system.config` + the already-fetched `objects` name list), and the suggestion builder is a local
// text generator over operator-typed drafts. Neither ever calls an apply endpoint, edits local config,
// or touches the .ps1 script (lock §3: applied only by a controlled backend or ops script).

const selectedBridgeSystem = computed(() => bridgeSystems.value.find((system) => system.id === selectedSystemId.value) || null)

// Values-free by construction: computeBridgeAgentConfigCheck() never returns a config value, only a
// fixed status + labelKey per item (see bridgeAgentConfigCheck.ts's module header).
const configCheckItems = computed<BridgeAgentConfigCheckItem[]>(() => {
  const system = selectedBridgeSystem.value
  if (!system) return []
  return computeBridgeAgentConfigCheck({
    config: system.config,
    objectNames: objects.value.map((object) => object.name),
  })
})

function configCheckItemLabel(item: BridgeAgentConfigCheckItem): string {
  return bridgeAgentConfigCheckLabel(item.labelKey, locale.value)
}

function configCheckStatusLabel(status: BridgeAgentConfigCheckStatus): string {
  if (status === 'pass') return bi('通过', 'Pass')
  if (status === 'warn') return bi('提示', 'Attention')
  return bi('未通过', 'Fail')
}

function configCheckTitleLabel(id: BridgeAgentConfigCheckItem['id']): string {
  if (id === 'requiredFields') return bi('必填字段', 'Required fields')
  if (id === 'limits') return bi('Limits', 'Limits')
  if (id === 'authMode') return bi('Auth mode', 'Auth mode')
  if (id === 'localhostBoundary') return bi('本机边界', 'Localhost boundary')
  if (id === 'rawSqlForbidden') return bi('禁止 raw SQL', 'Raw SQL forbidden')
  return bi('对象 allowlist 完整性', 'Object allowlist completeness')
}

// --- Change-suggestion builder: operator-typed object/field-KEY names (never values) -> a values-free
// copyable suggestion text. Row state stays as raw strings (comma-separated field keys) so the input
// controls are simple text fields; parsing/validation happens in the pure util on every recompute.
interface SuggestionDraftRow {
  objectName: string
  fieldKeysText: string
}

function newSuggestionDraftRow(): SuggestionDraftRow {
  return { objectName: '', fieldKeysText: '' }
}

const suggestionDrafts = ref<SuggestionDraftRow[]>([newSuggestionDraftRow()])

function addSuggestionDraftRow(): void {
  suggestionDrafts.value = [...suggestionDrafts.value, newSuggestionDraftRow()]
}

function removeSuggestionDraftRow(index: number): void {
  if (suggestionDrafts.value.length <= 1) return
  suggestionDrafts.value = suggestionDrafts.value.filter((_, i) => i !== index)
}

const suggestionResult = computed(() => {
  const drafts: BridgeAgentSuggestionObjectDraft[] = suggestionDrafts.value.map((row) => ({
    objectName: row.objectName,
    fieldKeys: row.fieldKeysText.split(',').map((key) => key.trim()).filter(Boolean),
  }))
  return buildBridgeAgentChangeSuggestion(drafts, locale.value, selectedBridgeSystem.value?.name ?? null)
})

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')

async function copySuggestionText(): Promise<void> {
  copyState.value = 'idle'
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(suggestionResult.value.text)
      copyState.value = 'copied'
      return
    }
  } catch {
    // fall through to the failed state below
  }
  copyState.value = 'failed'
}

watch(suggestionDrafts, () => {
  copyState.value = 'idle'
}, { deep: true })

// --- BA-APPLY-1 (docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 A,
// #3876): "导出实施清单" — renders the SAME operator-typed drafts above as a machine-readable, values-
// free implementation checklist (`buildImplementationChecklist`), instead of the prose suggestion text.
// This is an EXPORT/render only: no apply endpoint, no local-config write, no .ps1 invocation, no Agent
// write — the JSON below is handed to a controlled backend or ops script by a human (a LATER, unopened
// rung). `implementationChecklist` recomputes from `suggestionDrafts` directly (not from
// `suggestionResult.entries`) so this surface independently re-applies the safe-identifier gate rather
// than trusting the sibling suggestion builder's output.
const implementationChecklist = computed(() => {
  const drafts: BridgeAgentSuggestionObjectDraft[] = suggestionDrafts.value.map((row) => ({
    objectName: row.objectName,
    fieldKeys: row.fieldKeysText.split(',').map((key) => key.trim()).filter(Boolean),
  }))
  return buildImplementationChecklist(drafts)
})

// The exact serialized artifact — `{ schemaVersion, operations }` only, no counts/labels/free text —
// is what gets previewed, copied, and downloaded.
const checklistText = computed(() => JSON.stringify(implementationChecklist.value.checklist, null, 2))

const checklistVisible = ref(false)

function toggleChecklist(): void {
  checklistVisible.value = !checklistVisible.value
}

const checklistCopyState = ref<'idle' | 'copied' | 'failed'>('idle')

async function copyChecklistText(): Promise<void> {
  checklistCopyState.value = 'idle'
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(checklistText.value)
      checklistCopyState.value = 'copied'
      return
    }
  } catch {
    // fall through to the failed state below
  }
  checklistCopyState.value = 'failed'
}

// Values-free by construction: the downloaded file's own content is `checklistText` (object names/
// field-key names/op enum only — see the module header) and its filename carries nothing but a
// client-side timestamp, never a system name or config value.
function downloadChecklistJson(): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([checklistText.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `bridge-agent-implementation-checklist-${Date.now()}.json`
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

watch(suggestionDrafts, () => {
  checklistCopyState.value = 'idle'
}, { deep: true })
</script>

<style scoped>
/* Verbatim copies of the base rules from IntegrationWorkbenchView.vue's <style scoped> block that
   this new section's markup also needs — see IntegrationMonitoringSection.vue's style block comment
   for why duplication (not relocation) is correct: Vue's scoped CSS only reaches elements rendered by
   the SAME SFC that declared the rule. */
.integration-workbench h2 {
  margin: 0;
  font-size: 17px;
}

.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__button,
.integration-workbench__link-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.integration-workbench__button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  padding: 8px 12px;
}

.integration-workbench__button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__link-button {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.integration-workbench__hint {
  margin-top: 10px;
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

/* BA-UI-1 own classes below (fresh prefix — not extracted from the parent view). */

.bridge-agent__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.bridge-agent__card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.bridge-agent__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ms-text-1);
}

.bridge-agent__card-icon {
  color: var(--ms-text-3);
}

.bridge-agent__card-head strong {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bridge-agent__card-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 700;
}

.bridge-agent__badge--readonly {
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
}

.bridge-agent__badge--online {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.bridge-agent__badge--offline {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.bridge-agent__meta {
  color: var(--ms-text-3);
}

.bridge-agent__error {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
  font-size: 12px;
}

.bridge-agent__probe-evidence {
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__probe-evidence h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ms-text-1);
}

.bridge-agent__probe-evidence ul {
  margin: 0;
  padding-left: 16px;
  display: grid;
  gap: 6px;
}

.bridge-agent__probe-overall {
  margin: 0 0 6px;
  font-weight: 700;
  color: var(--ms-text-1);
}

.bridge-agent__probe-overall[data-result='fail'] {
  color: var(--el-color-danger);
}

.bridge-agent__probe-overall[data-result='pass'] {
  color: var(--el-color-success-dark-2);
}

.bridge-agent__probe-guidance {
  margin: 2px 0 0;
  color: var(--ms-text-3);
}

/* BA-UI-4 own classes below — a neutral, non-badge-colored box (see the script-block comment above
   for why: this is guidance/convention + a relabeled probe result, never a live "task running"
   signal, so it deliberately does NOT borrow the online/offline badge coloring). */

.bridge-agent__task-status {
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__task-status h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ms-text-1);
}

.bridge-agent__task-status p {
  margin: 0 0 6px;
}

.bridge-agent__task-status p:last-child {
  margin-bottom: 0;
}

.bridge-agent__task-note {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bridge-agent__task-guidance {
  color: var(--ms-text-3);
}

.bridge-agent__instances,
.bridge-agent__objects {
  margin-top: 20px;
}

.bridge-agent__objects-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.bridge-agent__instance-picker {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__instance-picker select {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--ms-text-1);
  font: inherit;
}

.bridge-agent__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.bridge-agent__table th,
.bridge-agent__table td {
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding: 6px 8px;
  text-align: left;
  color: var(--ms-text-1);
}

.bridge-agent__table th {
  color: var(--ms-text-2);
  font-weight: 600;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head {
    display: grid;
  }

  .bridge-agent__objects-head {
    display: grid;
  }
}

/* BA-UI-3 own classes below (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3
   BA-UI-3) — fresh prefixes, token-only colors, same discipline as the BA-UI-1 classes above. */

.bridge-agent__config-check,
.bridge-agent__suggestion {
  margin-top: 20px;
}

.bridge-agent__config-check h3,
.bridge-agent__suggestion h3 {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bridge-agent__checklist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}

.bridge-agent__checklist-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 13px;
  color: var(--ms-text-1);
}

.bridge-agent__checklist-icon--pass {
  color: var(--el-color-success);
}

.bridge-agent__checklist-icon--warn {
  color: var(--el-color-warning);
}

.bridge-agent__checklist-icon--fail {
  color: var(--el-color-danger);
}

.bridge-agent__checklist-title {
  font-weight: 700;
  min-width: 140px;
}

.bridge-agent__checklist-text {
  color: var(--ms-text-2);
  flex: 1;
  min-width: 200px;
}

.bridge-agent__badge--check-pass {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.bridge-agent__badge--check-warn {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.bridge-agent__badge--check-fail {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.bridge-agent__suggestion-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 10px;
}

.bridge-agent__suggestion-field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
  flex: 1;
  min-width: 180px;
}

.bridge-agent__suggestion-field input {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--ms-text-1);
  font: inherit;
}

.bridge-agent__suggestion-output {
  margin-top: 12px;
  display: grid;
  gap: 8px;
}

.bridge-agent__suggestion-output h4 {
  margin: 0;
  font-size: 12px;
  color: var(--ms-text-1);
}

.bridge-agent__suggestion-text {
  width: 100%;
  min-height: 120px;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  background: var(--ms-bg-page);
  font: inherit;
  font-family: inherit;
  white-space: pre-wrap;
  resize: vertical;
}
</style>

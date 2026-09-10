<template>
  <PageShell width="default">
    <PageHeader
      :title="bi('集成帮助中心', 'Integration Help Center')"
      :subtitle="bi('数据工厂 / 读取源 / 组合链的使用说明与排障参考', 'Usage guidance and troubleshooting reference for Data Factory read sources and compositions')"
      back-to="/integrations/workbench"
      :back-label="bi('返回数据工厂', 'Back to Data Factory')"
    />

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-glossary">
      <h2>{{ bi('术语对照表', 'Terminology reference') }}</h2>
      <p>
        {{ bi(
          '同一个概念在界面的不同角落经常有不同叫法——按钮上一个词、下拉框标签上又是另一个词、日志和错误码里还有第三个词。下表把常见叫法收口到一个统一说法，帮你在读排障提示时对上号。',
          'The same concept often goes by different names in different corners of the UI — one word on a button, another on the dropdown label right next to it, and a third in logs or error codes. The table below collapses the common names into one unified term, so you can match them up when reading a troubleshooting message.',
        ) }}
      </p>
      <div class="integration-help__table-wrap">
        <table class="integration-help__table" data-testid="help-glossary-table">
          <thead>
            <tr>
              <th>{{ bi('统一叫法', 'Unified name') }}</th>
              <th>{{ bi('你会在哪里看到它的别名', 'Where you will see its aliases') }}</th>
              <th>{{ bi('一句话是什么', 'What it is, in one line') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in INTEGRATION_HELP_GLOSSARY"
              :key="entry.id"
              :data-testid="`help-glossary-row-${entry.id}`"
            >
              <td><strong>{{ bi(entry.termZh, entry.termEn) }}</strong></td>
              <td>{{ bi(entry.aliasesZh, entry.aliasesEn) }}</td>
              <td>{{ bi(entry.meaningZh, entry.meaningEn) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-case-sql-source">
      <h2>{{ bi('案例一：SQL 只读源 → 多维表', 'Walkthrough one: SQL read-only source → multi-dimensional table') }}</h2>
      <p>
        {{ bi(
          '最常见的主旅程：把一个 SQL 数据库里的一张表或视图整表拉进多维表清洗，Dry-run 确认无误后推送到目标多维表。以下每一步写清楚在哪个分区、点什么按钮、成功长什么样、常见失败去哪看。',
          'The most common main journey: pull a whole table or view from a SQL database into a multi-dimensional table to clean, confirm with a dry-run, then push it to a target multi-dimensional table. Each step below states where it lives, what to click, what success looks like, and where to look on common failure.',
        ) }}
      </p>
      <ol class="integration-help__case-steps" data-testid="help-case-sql-source-steps">
        <li
          v-for="(step, index) in sqlSourceCaseSteps"
          :key="step.id"
          class="integration-help__case-step"
          :data-testid="`help-case-sql-source-step-${index + 1}`"
        >
          <strong>{{ index + 1 }}. {{ bi(step.titleZh, step.titleEn) }}</strong>
          <dl>
            <dt>{{ bi('在哪', 'Where') }}</dt>
            <dd>{{ bi(step.whereZh, step.whereEn) }}</dd>
            <dt>{{ bi('点什么', 'What to click') }}</dt>
            <dd>{{ bi(step.actionZh, step.actionEn) }}</dd>
            <dt>{{ bi('成功长什么样', 'What success looks like') }}</dt>
            <dd>{{ bi(step.successZh, step.successEn) }}</dd>
            <dt>{{ bi('常见失败与去哪看', 'Common failure & where to look') }}</dt>
            <dd>{{ bi(step.failureZh, step.failureEn) }}</dd>
          </dl>
        </li>
      </ol>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-case-k3-wise">
      <h2>{{ bi('案例二：K3 WISE 预设', 'Walkthrough two: the K3 WISE preset') }}</h2>
      <p>
        {{ bi(
          '一条更短的旅程：用现成的 K3 WISE 预设模板读取物料 / BOM，不用手填连接参数。K3 目标永久只读——Dry-run 后只能导出，或把结果推送到多维表，永远不会写回 K3。',
          'A shorter journey: use the ready-made K3 WISE preset template to read materials / BOMs, with no connection parameters to fill in by hand. The K3 target is permanently read-only — after a dry-run you can only export the result or push it into a multi-dimensional table; it is never written back to K3.',
        ) }}
      </p>
      <ol class="integration-help__case-steps" data-testid="help-case-k3-wise-steps">
        <li
          v-for="(step, index) in k3WiseCaseSteps"
          :key="step.id"
          class="integration-help__case-step"
          :data-testid="`help-case-k3-wise-step-${index + 1}`"
        >
          <strong>{{ index + 1 }}. {{ bi(step.titleZh, step.titleEn) }}</strong>
          <dl>
            <dt>{{ bi('在哪', 'Where') }}</dt>
            <dd>{{ bi(step.whereZh, step.whereEn) }}</dd>
            <dt>{{ bi('点什么', 'What to click') }}</dt>
            <dd>{{ bi(step.actionZh, step.actionEn) }}</dd>
            <dt>{{ bi('成功长什么样', 'What success looks like') }}</dt>
            <dd>{{ bi(step.successZh, step.successEn) }}</dd>
            <dt>{{ bi('常见失败与去哪看', 'Common failure & where to look') }}</dt>
            <dd>{{ bi(step.failureZh, step.failureEn) }}</dd>
          </dl>
        </li>
      </ol>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-when-to-use">
      <h2>{{ bi('何时用读取源 vs 组合', 'When to use a read source vs. a composition') }}</h2>
      <p>
        {{ bi(
          '读取源（单跳）：一次调用就能直接取到你需要的记录或列表——例如按业务键取一条记录的详情。',
          'Read source (single hop): one call gets you the record or list you need directly — e.g. fetching a single record\'s detail by its business key.',
        ) }}
      </p>
      <p>
        {{ bi(
          '组合（两跳）：需要先用第一跳的输出作为第二跳的输入才能拿到最终数据——例如先按业务键定位到一个内部标识，再用这个内部标识取到关联记录。两跳之间的交接完全由平台完成，浏览器和使用者都不会看到中间值。',
          'Composition (two hops): the first hop\'s output becomes the second hop\'s input before you get the final data — e.g. resolving a business key to an internal identifier, then using that identifier to fetch a linked record. The handoff between hops happens entirely on the platform; the browser and the end user never see the intermediate value.',
        ) }}
      </p>
      <ul class="integration-help__compare-list" data-testid="help-when-to-use-compare">
        <li>
          <strong>{{ bi('选读取源，当…', 'Choose a read source when…') }}</strong>
          {{ bi('目标数据一次调用就能取到，不需要先定位一个中间标识。', 'the target data can be fetched in one call, with no need to first resolve an intermediate identifier.') }}
        </li>
        <li>
          <strong>{{ bi('选组合，当…', 'Choose a composition when…') }}</strong>
          {{ bi('必须先定位一个中间标识，再用它取最终数据（两跳链）。', 'you must first resolve an intermediate identifier, then use it to fetch the final data (a two-hop chain).') }}
        </li>
      </ul>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-error-codes">
      <h2>{{ bi('错误码对照表', 'Error code reference') }}</h2>
      <p>
        {{ bi(
          '机器码只用于排障；正常使用时页面只展示下表右侧的人话说明。本表由错误码标签模块自动生成——新增/调整标签会自动出现在这里，不需要手改本页。',
          'The raw machine code is only for troubleshooting — normal usage only ever shows the human-readable text on the right. This table is generated automatically from the error-code label module — a future label addition/change appears here with no edits to this page.',
        ) }}
      </p>
      <div class="integration-help__table-wrap">
        <table class="integration-help__table" data-testid="help-error-code-table">
          <thead>
            <tr>
              <th>{{ bi('机器码', 'Code') }}</th>
              <th>{{ bi('说明', 'Meaning') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in errorCodeEntries"
              :key="entry.code"
              :data-testid="`help-error-code-row-${entry.code}`"
            >
              <td><code>{{ entry.code }}</code></td>
              <td>
                <div>{{ bi(entry.zh, entry.en) }}</div>
                <small v-if="entry.hint">{{ bi(entry.hint.zh, entry.hint.en) }}</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-faq">
      <h2>{{ bi('常见排障 FAQ', 'Common troubleshooting FAQ') }}</h2>
      <details
        v-for="(item, index) in faqItems"
        :key="index"
        class="integration-help__faq-item"
        :data-testid="`help-faq-${index}`"
      >
        <summary :data-testid="`help-faq-question-${index}`">{{ bi(item.zhQ, item.enQ) }}</summary>
        <p :data-testid="`help-faq-answer-${index}`">{{ bi(item.zhA, item.enA) }}</p>
      </details>
    </el-card>
  </PageShell>
</template>

<script lang="ts">
// Plain (non-setup) <script> block, alongside <script setup> below, SOLELY so
// INTEGRATION_HELP_GLOSSARY can be a real named export of this SFC's module — <script setup> itself
// cannot contain ES module exports (Vue SFC compiler hard error). Same two-block pattern already used
// by ApprovalFormBuilder.vue's STALE_SLOT_RETRY_MESSAGE / GENERIC_RETRY_MESSAGE exports. The spec
// imports this constant to assert the rendered glossary table's row count against it (single-source,
// same pattern as `errorCodeEntries` in the <script setup> block below).
export interface GlossaryEntry {
  id: string
  termZh: string
  termEn: string
  aliasesZh: string
  aliasesEn: string
  meaningZh: string
  meaningEn: string
}

// Terminology reference (G12/G41). Every `aliasesZh`/`aliasesEn` value below is grounded in a real
// occurrence — see docs/development/integration-help-sql-journey-design-20260910.md for the full
// file:line citation list. A deletion here shows up as a red assertion in the spec rather than
// silently shrinking both sides together (see the spec's row-count tripwire test).
export const INTEGRATION_HELP_GLOSSARY: GlossaryEntry[] = [
  {
    id: 'connection',
    termZh: '连接',
    termEn: 'Connection',
    aliasesZh: '外接数据源、外部系统、连接草稿、adapter',
    aliasesEn: 'external data source, external system, connection draft, adapter',
    meaningZh: '一条指向外部系统或数据库的配置；编辑中叫“连接草稿”，保存后叫“连接”——两者说的是同一条记录，真实账号密码不在这里保存。',
    meaningEn: 'A configuration pointing at one external system or database — called "connection draft" while being edited, "connection" once saved; both names refer to the same record, and real credentials are never stored here.',
  },
  {
    id: 'dataset-object',
    termZh: '数据集 / 对象',
    termEn: 'Dataset / Object',
    aliasesZh: '来源对象、目标对象、表或视图',
    aliasesEn: 'source object, target object, table or view',
    meaningZh: '连接里具体能读或能写的一张表、一个视图或一个业务对象；同一个选择器，标题里叫“对象”，紧挨着的下拉框标签又叫“数据集”。',
    meaningEn: 'One specific table, view, or business object you can read from or write to inside a connection; the very same picker is titled "object" while the dropdown label right next to it says "dataset".',
  },
  {
    id: 'staging-table',
    termZh: '清洗表',
    termEn: 'Staging table',
    aliasesZh: 'staging 多维表、staging 表',
    aliasesEn: 'staging multi-dimensional table, staging table',
    meaningZh: '把外部数据先落到一张 MetaSheet 多维表里，供业务人员在表格中修正、审核、补字段，再作为 Dry-run 的来源或目标。',
    meaningEn: 'A MetaSheet multi-dimensional table that first holds the pulled data, so a business user can fix, review, and fill in fields in the grid before it is used as a dry-run source or target.',
  },
  {
    id: 'read-source',
    termZh: '读取源',
    termEn: 'Read source',
    aliasesZh: 'read source、resolver_lookup（单跳读取模式）',
    aliasesEn: 'read source, resolver_lookup (the single-hop read mode)',
    meaningZh: '一次调用就能取到目标记录或列表的、经过“选系统→定形状→探测→审批”四步固化下来的可复用读取配置。',
    meaningEn: 'A reusable read configuration — hardened through the four steps "pick system, define shape, probe, approve" — that fetches the target record or list in a single call.',
  },
  {
    id: 'composition',
    termZh: '组合',
    termEn: 'Composition',
    aliasesZh: 'combination、两跳组合',
    aliasesEn: 'combination, two-hop composition',
    meaningZh: '把两个已审批的读取源接成一条两跳链——第一跳的输出自动成为第二跳的输入，中间值不会展示给使用者。',
    meaningEn: 'Chains two already-approved read sources into a two-hop flow — the first hop\'s output automatically becomes the second hop\'s input, and the intermediate value is never shown to the user.',
  },
  {
    id: 'pipeline',
    termZh: '清洗流程',
    termEn: 'Pipeline',
    aliasesZh: '“保存清洗流程”按钮、pipeline（配置与代码里的技术叫法）、管道（通俗直译，页面上不会这样写）',
    aliasesEn: 'the "Save cleansing flow" button, pipeline (the technical name used in config/code), the literal Mandarin gloss "管道" (not actually printed in the UI)',
    meaningZh: '把连接、对象、清洗映射保存成的一份可重复运行的配置；保存本身不调用任何外部系统，真正的读写发生在 Dry-run / Save-only 推送时。',
    meaningEn: 'The saved, re-runnable configuration built from a connection + object + cleansing mapping; saving it never calls any external system — the actual read/write only happens at dry-run / Save-only push time.',
  },
  {
    id: 'dead-letter',
    termZh: '死信',
    termEn: 'Dead letter',
    aliasesZh: 'dead letter、deadLetter',
    aliasesEn: 'dead letter, deadLetter',
    meaningZh: '一次失败的 pipeline 运行留下的记录，可在“监控与死信”分区查看详情并重放。',
    meaningEn: 'The record left behind by one failed pipeline run; you can inspect and replay it from the "Monitoring & Dead Letters" section.',
  },
]
</script>

<script setup lang="ts">
// IU-6c help center (design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md
// #3739): a read-only reference page for the Data Factory / integration surface. Sections:
//   1. Terminology reference (G12/G41 gap-close, docs/development/integration-help-sql-journey-
//      design-20260910.md): the same concept has several names across the UI (button copy, dropdown
//      label, error text, code/prop names) — this table collapses them to one unified name. The alias
//      column is grounded in a real grep of IntegrationWorkbenchView.vue, components/integration/*.vue
//      (direct children only) and App.vue's nav copy — see the design doc for the full file:line list.
//   2. Two end-to-end walkthroughs (G12/G41): "SQL read-only source -> multi-dimensional table" (the
//      main journey the old page never mentioned) and the shorter "K3 WISE preset" journey. Steps are
//      grounded in the actual button/testid labels in IntegrationConnectionSection.vue,
//      IntegrationObjectTemplateSection.vue, IntegrationCleaningDatasetSection.vue and
//      IntegrationPipelineRunSection.vue — never invented UI. Case two's "K3 target is permanently
//      read-only" line intentionally matches the in-flight fix/integration-k3-writeback-copy-and-codes
//      branch's direction (a734f8add, not yet on this branch) rather than today's still-visible
//      Save-only-to-K3 affordance — see the design doc for why.
//   3. When to use a read source (single hop) vs. a composition (two hop) — values-free explanation.
//   4. Error-code reference table — SINGLE SOURCE: iterates `integrationErrorCodeEntries()` from the
//      IU-1 label module (errorCodeLabels.ts) rather than copying label text into this view, so a
//      future label addition/removal is reflected here automatically (see IntegrationHelpView.spec.ts
//      "single-source tripwire": rendered row count === the module's registered code count).
//   5. Common troubleshooting FAQ — distilled from docs/development/integration-composition-entity-e2e-
//      runbook-20260705.md and integration-core-external-api-read-self-service-entity-e2e-runbook-
//      20260702.md, plus two new entries for the read-source-vs-pipeline and permission-visibility
//      questions (values-free; no real material/BOM numbers, only descriptive placeholders).
// Zero behavior change elsewhere: this view has no service calls, no write path, no permission-gated
// action — it only reads the (already-loaded) label module and renders static, values-free copy.
import { computed } from 'vue'
import { useLocale } from '../composables/useLocale'
import { integrationErrorCodeEntries, type IntegrationErrorCodeEntry } from '../services/integration/errorCodeLabels'
import PageShell from '../components/layout/PageShell.vue'
import PageHeader from '../components/layout/PageHeader.vue'

const { locale } = useLocale()

// Same locale pattern as the rest of the integration surface (errorCodeLabels/fieldHints): reads
// `locale.value` synchronously, safe to call directly from the template.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// Single-source (IU-6c hard requirement): NEVER hand-copy label text here — always iterate the
// module's own registered entries so additions/removals need zero edits to this view.
const errorCodeEntries = computed<IntegrationErrorCodeEntry[]>(() => integrationErrorCodeEntries())

interface HelpCaseStep {
  id: string
  titleZh: string
  titleEn: string
  whereZh: string
  whereEn: string
  actionZh: string
  actionEn: string
  successZh: string
  successEn: string
  failureZh: string
  failureEn: string
}

// Case one: SQL read-only source -> multi-dimensional table (G12/G41 main journey). Every location
// and button label below is grounded in the real component copy — see the design doc for citations.
const sqlSourceCaseSteps: HelpCaseStep[] = [
  {
    id: 'register-data-source',
    titleZh: '登记外接数据源',
    titleEn: 'Register the external data source',
    whereZh: '在数据工厂 · 连接管理里登记外接数据源（旧版本在独立的「外接数据源」页 /data-sources）。',
    whereEn: 'Register it under Data Factory · Connections (an older build has a separate "Data Sources" page at /data-sources).',
    actionZh: '点“新建数据源”，选类型 PostgreSQL / SQL Server / MySQL，填 Host / Port / Database 与只读账号密码（用占位符，不要填真实值）。',
    actionEn: 'Click "New data source", pick type PostgreSQL / SQL Server / MySQL, and fill in Host / Port / Database plus a read-only account (use placeholders, never real values).',
    successZh: '数据源出现在列表里，状态可用；它的 ID 就是后面要在连接草稿里引用的 connectionId。',
    successEn: 'The data source appears in the list in a usable state; its ID is the connectionId you will reference from the connection draft next.',
    failureZh: '连接测试失败——回到 /data-sources 检查 Host / Port / 凭据是否正确，这一步的排障在数据源页，不在数据工厂。',
    failureEn: 'Connection test fails — go back to /data-sources and check Host / Port / credentials; this failure is diagnosed on the data source page, not in the Data Factory.',
  },
  {
    id: 'connection-draft',
    titleZh: '新增连接草稿并用 connectionId 引用',
    titleEn: 'Add a connection draft that references the connectionId',
    whereZh: '数据工厂 · 连接管理，勾选“显示 SQL / 高级连接”后点“新增连接草稿”。',
    whereEn: 'Data Factory · Connections — check "Show SQL / advanced connectors", then click "Add connection draft".',
    actionZh: '连接类型选 “Read-only SQL data source”（kind: data-source:sql-readonly）；connectionId 下拉选刚注册的数据源；对象(表 / 视图) 下拉选一张要读的表或视图；点“保存连接设置”。',
    actionEn: 'Set the connection type to "Read-only SQL data source" (kind: data-source:sql-readonly), pick the connectionId you just registered, pick the object (table / view) to read, then click "Save connection".',
    successZh: '提示保存成功，这条连接出现在“已配置连接”清单里。',
    successEn: 'A save-succeeded status appears and the connection shows up in the "configured connections" list.',
    failureZh: 'connectionId 下拉是空的、或表 / 视图列表为空——回第一步确认数据源已保存，并确认当前账号对该库有权限。',
    failureEn: 'The connectionId dropdown is empty, or the table/view list is empty — go back to step one and confirm the data source was saved and the current account has access to that database.',
  },
  {
    id: 'pick-dataset',
    titleZh: '选择系统与数据集',
    titleEn: 'Pick the system and dataset',
    whereZh: '数据工厂 · 清洗映射（“选择系统与数据集”面板）。',
    whereEn: 'Data Factory · Cleansing & Mapping (the "Pick system and dataset" panel).',
    actionZh: '来源系统选刚保存的连接，点“加载来源对象”，在“来源数据集”下拉里选那张表或视图（同一个选择器，标题叫“对象”，下拉标签叫“数据集”——见上方术语表）。',
    actionEn: 'Pick the connection you just saved as the source system, click "Load source objects", and pick the table/view from the "source dataset" dropdown (the same picker is titled "object" but the dropdown label says "dataset" — see the glossary above).',
    successZh: 'schema 字段列表加载出来，说明这个对象确实可读。',
    successEn: 'The schema field list loads, confirming the object is actually readable.',
    failureZh: '提示加载 SQL 表 / 视图失败——回连接草稿确认 connectionId 与对象是否仍然有效，表可能已被删除或权限已被收回。',
    failureEn: 'A "failed to load SQL table/view" message appears — go back to the connection draft and confirm the connectionId and object are still valid; the table may have been dropped or access revoked.',
  },
  {
    id: 'cleansing-mapping',
    titleZh: '清洗映射',
    titleEn: 'Cleanse and map',
    whereZh: '数据工厂 · 清洗映射。',
    whereEn: 'Data Factory · Cleansing & Mapping.',
    actionZh: '点“创建清洗表”生成一张 staging 多维表；在多维表里修正、审核、补字段；配置字段映射规则。',
    actionEn: 'Click "Create cleansing table" to generate a staging multi-dimensional table, fix/review/fill fields in the grid, then configure the field-mapping rules.',
    successZh: '状态显示“清洗表已创建”，可以在 staging 卡片上选择“作为 Dry-run 来源”。',
    successEn: 'The status shows "cleansing table created", and you can pick "use as dry-run source" on the staging card.',
    failureZh: '保存版本时报 500——大概率是数据库迁移还没跑到位，这是常见部署缺口，不是配置写错了。',
    failureEn: 'Save-version returns a 500 — most likely the required database migrations have not been applied yet; this is a common deployment gap, not a configuration mistake.',
  },
  {
    id: 'dry-run',
    titleZh: 'Dry-run',
    titleEn: 'Dry-run',
    whereZh: '数据工厂 · 运行与推送。',
    whereEn: 'Data Factory · Run & Push.',
    actionZh: '点“Dry-run”。',
    actionEn: 'Click "Dry-run".',
    successZh: '只读取来源数据、生成目标 payload 预览，不写入 K3 或其他任何外部系统。',
    successEn: 'It only reads the source data and generates a target payload preview — it does not write to K3 or any other external system.',
    failureZh: '按钮置灰或提示前置条件未满足——按提示补齐连接 / 对象 / 映射，不要跳过直接推送。',
    failureEn: 'The button is disabled or a readiness message appears — fill in the missing connection / object / mapping as instructed rather than skipping straight to push.',
  },
  {
    id: 'push-to-multitable',
    titleZh: '推送到多维表',
    titleEn: 'Push to the multi-dimensional table',
    whereZh: '数据工厂 · 运行与推送。',
    whereEn: 'Data Factory · Run & Push.',
    actionZh: '目标选 MetaSheet 多维表（已建好的 staging 多维表也可以直接作为目标）；勾选“允许本次 Save-only 推送”；点“Save-only 推送”。也可以先点“导出”，选 CSV 或 Excel 做人工复核。',
    actionEn: 'Set the target to a MetaSheet multi-dimensional table (an existing staging table can be used as the target directly), check "allow this Save-only push", then click "Save-only push". You can also click "Export" first and pick CSV or Excel for manual review.',
    successZh: '成功后展示写入数与目标记录信息；可以在“监控与死信”分区看到这次运行的记录。',
    successEn: 'On success it shows the write count and target record info; you can see this run recorded under "Monitoring & Dead Letters".',
    failureZh: '推送失败会写入一条死信——回“监控与死信”分区打开这条死信排查，或对照错误码表核对机器码。',
    failureEn: 'A failed push writes a dead letter — open it from "Monitoring & Dead Letters" to investigate, or check the machine code against the error-code table.',
  },
]

// Case two: the K3 WISE preset (G12/G41, shorter journey). "K3 target is permanently read-only"
// intentionally matches the in-flight fix/integration-k3-writeback-copy-and-codes direction — see
// the module header comment above and the design doc.
const k3WiseCaseSteps: HelpCaseStep[] = [
  {
    id: 'open-preset',
    titleZh: '打开 K3 WISE 预设',
    titleEn: 'Open the K3 WISE preset',
    whereZh: '/integrations/k3-wise（也可以从数据工厂 · 连接管理点“使用 K3 WISE 预设”进入）。',
    whereEn: '/integrations/k3-wise (or click "Use K3 WISE preset" from Data Factory · Connections).',
    actionZh: '不需要手填连接参数——预设已经带好物料 / BOM 模板，直接进入下一步准备多维表。',
    actionEn: 'No connection parameters to fill in by hand — the preset already ships a material / BOM template; move straight to preparing the multi-dimensional table.',
    successZh: '预设页打开，看到“准备多维表”与“Dry-run 后推送”两个步骤提示。',
    successEn: 'The preset page opens, showing the "prepare multi-dimensional table" and "dry-run then push" step hints.',
    failureZh: '页面打不开或提示无权限——这条路由需要 integration:write 权限，找管理员确认账号权限。',
    failureEn: 'The page fails to load or reports no permission — this route requires the integration:write permission; ask an admin to confirm your account has it.',
  },
  {
    id: 'install-staging',
    titleZh: '安装 Staging 多维表',
    titleEn: 'Install the staging multi-dimensional table',
    whereZh: 'K3 WISE 预设页的“准备多维表”区。',
    whereEn: 'The "prepare multi-dimensional table" area of the K3 WISE preset page.',
    actionZh: '点“安装 Staging 多维表”。',
    actionEn: 'Click "Install staging table".',
    successZh: '提示“Staging 多维表已安装或确认存在”。',
    successEn: 'A "staging table installed or confirmed to exist" message appears.',
    failureZh: '提示安装失败——详情见服务端日志；先确认数据库迁移已跑到位。',
    failureEn: 'An install-failed message appears — see the server log for detail; first confirm the required database migrations have been applied.',
  },
  {
    id: 'dry-run-material-bom',
    titleZh: 'Dry-run 物料或 BOM',
    titleEn: 'Dry-run material or BOM',
    whereZh: 'K3 WISE 预设页，物料或 BOM 卡片。',
    whereEn: 'The K3 WISE preset page, on the material or BOM card.',
    actionZh: '点“Dry-run 物料”或“Dry-run BOM”。',
    actionEn: 'Click "Dry-run material" or "Dry-run BOM".',
    successZh: '预览生成，只读取 K3 数据，不写入 K3 或任何其他外部系统。',
    successEn: 'A preview is generated by reading K3 only — nothing is written to K3 or any other external system.',
    failureZh: '一个物料存在多个 BOM 报“存在歧义”不是 bug——收窄筛选条件或换一条能唯一区分候选记录的规则。',
    failureEn: 'A material with multiple BOMs reporting "ambiguous" is not a bug — narrow the filter or use a resolver rule that can uniquely tell the candidates apart.',
  },
  {
    id: 'export-or-push',
    titleZh: '导出或写入多维表（K3 目标永久只读）',
    titleEn: 'Export or push to a multi-dimensional table (the K3 target is permanently read-only)',
    whereZh: 'K3 WISE 预设页 / 数据工厂 · 运行与推送。',
    whereEn: 'The K3 WISE preset page / Data Factory · Run & Push.',
    actionZh: 'K3 目标永久只读，Dry-run 之后不会有写回 K3 的选项——点“打开多维表”把结果落到 staging 多维表，或用导出功能落 CSV / Excel。',
    actionEn: 'The K3 target is permanently read-only, so a dry-run here never turns into a save into K3 — click "open the multi-dimensional table" to land the result in the staging table, or use export for CSV / Excel.',
    successZh: '多维表里出现本次 Dry-run 的数据，或导出文件下载完成。',
    successEn: 'The dry-run data appears in the multi-dimensional table, or the exported file finishes downloading.',
    failureZh: '打开多维表提示表不存在——回“安装 Staging 多维表”步骤重新安装，或确认 sheetId 没有被外部删除。',
    failureEn: 'Opening the table reports it does not exist — go back to "install staging table" and reinstall, or confirm the sheetId was not deleted elsewhere.',
  },
]

type FaqItem = { zhQ: string; enQ: string; zhA: string; enA: string }

// Distilled from the composition entity e2e runbook (20260705) and the external-API read
// self-service entity e2e runbook (20260702) — see module header. Values-free: no real material/BOM
// numbers, only descriptive placeholders (field/code names, never business data). The last two
// entries (read-source-vs-pipeline, permission-visibility) close the G12/G41 gap analysis.
const faqItems: FaqItem[] = [
  {
    zhQ: '探测返回"未找到目标数据容器"（READ_SOURCE_PROBE_CONTAINER_NOT_FOUND / READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND）怎么办？',
    zhA: '说明容器路径（containerPaths）与目标系统实际返回形状不匹配。先重新运行一次"定位容器探测"确认真实返回结构，再核对/修正 containerPaths；同一模式在不同环境上的真实形状也可能不同，不要凭猜测直接改。',
    enQ: 'The probe returns "container not found" (READ_SOURCE_PROBE_CONTAINER_NOT_FOUND / READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND) — what should I do?',
    enA: 'This means the configured container path does not match the target system\'s actual response shape. Re-run "locate container probe" to confirm the real structure, then check/fix containerPaths — the same mode can return a different shape per environment, so do not guess.',
  },
  {
    zhQ: '一个物料存在多个 BOM，返回"存在多个 BOM"（K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS / READ_SOURCE_RESOLVER_AMBIGUOUS）是 bug 吗？',
    zhA: '不是。这是唯一性策略的正确行为——平台从不按状态 / 版本 / 日期自动选择候选记录，多条候选时会如实报告"存在歧义"，避免静默选错。需要收窄筛选条件，或改用能唯一区分候选记录的解析规则。',
    enQ: 'A material has multiple BOMs and the system reports "ambiguous — multiple BOMs exist" — is this a bug?',
    enA: 'No. This is the uniqueness policy working correctly — the platform never auto-picks a candidate by status / version / date; when more than one row matches, it reports ambiguity instead of silently guessing wrong. Narrow the filter, or use a resolver rule that can uniquely tell the candidates apart.',
  },
  {
    zhQ: '凭证（credentials）在哪里配置？',
    zhA: '凭证在后端注册，不在这个页面填写——读取源配置面板从不展示或保存凭证字段。若运行时报"凭证缺失"类错误，需要请管理员确认该外部系统已在部署环境上登记凭证。',
    enQ: 'Where are credentials configured?',
    enA: 'Credentials are registered on the backend — this page never shows or stores a credential field. If a run fails with a "credentials missing" error, ask an admin to confirm the external system has credentials registered on the deployed environment.',
  },
  {
    zhQ: '保存版本时报 500，是我配置写错了吗？',
    zhA: '大概率不是——先确认数据库迁移已执行到位，这是常见的部署缺口而不是配置错误；确认迁移已跑后再排查配置本身。',
    enQ: 'Save-version returns a 500 error — did I misconfigure something?',
    enA: 'Probably not — first confirm the required database migrations have been applied; a save-version 500 on an un-migrated database is a common deployment gap, not a config mistake. Check the configuration itself only after confirming migrations.',
  },
  {
    zhQ: '组合运行报"该步骤尚未执行"（STEP_NOT_RUN）正常吗？',
    zhA: '正常。这是两跳链路的 fail-closed 设计——任意一跳失败后，后续步骤一律标记为"未执行"，绝不会继续用错误的中间结果往下跑。',
    enQ: 'Is it expected for a composition run to report "step not run" (STEP_NOT_RUN)?',
    enA: 'Yes. This is the two-hop chain\'s fail-closed design — once one hop fails, every step after it is clamped to "not run" rather than continuing with a bad intermediate result.',
  },
  {
    zhQ: '组合运行报通用的"该步骤执行失败"（STEP_FAILED），看不出具体原因怎么办？',
    zhA: '这是一个粗粒度兜底码，可能是系统类型不匹配、凭证缺失或网络错误等多种原因之一。请对比该跳读取源配置的 requiredKind 与已注册外部系统的 kind 是否一致，确认凭证已在该环境注册，也可单独重跑该跳自身的读取来定位问题。',
    enQ: 'A composition run reports the generic "step failed" (STEP_FAILED) with no further detail — what should I check?',
    enA: 'This is a coarse fallback code that can mean a system-kind mismatch, missing credentials, or a network error, among others. Compare that hop\'s requiredKind against the registered external system\'s kind, confirm credentials are registered, and try re-running that hop\'s own standalone read to isolate the problem.',
  },
  {
    zhQ: 'keyField 和 containerPaths 具体是做什么的，为什么保存前必须先探测？',
    zhA: 'keyField 是按业务键定位单条记录的字段名，containerPaths 是数据在返回体中的容器路径；两者都强依赖目标系统的真实返回形状，即使是"已验证"的模式在不同环境上也可能不同，所以必须先跑"定位容器探测"确认真实结构，再保存版本。',
    enQ: 'What are keyField and containerPaths for, and why must I probe before saving?',
    enA: 'keyField names the field used to locate a single record by its business key, and containerPaths is where the data lives inside the response body — both depend on the target system\'s real response shape, which can differ by environment even for an already-verified mode. Always probe first to confirm the real structure before saving.',
  },
  {
    zhQ: '我该用"读取源"还是直接建清洗流程（pipeline）？',
    zhA: '只是把一张表 / 视图整表拉进多维表清洗、Dry-run 后推送——像案例一那样——不需要先建"读取源"，在连接管理新增连接草稿、选对象、清洗、Dry-run 即可。"读取源"是另一套需要先"选系统→定形状→探测→审批"四步固化下来的可复用配置，用于按业务键取单条记录、尤其是要在"组合"里被复用做两跳查询的场景；只做整表清洗不需要它。',
    enQ: 'Should I use a "read source", or just build a cleansing pipeline directly?',
    enA: 'If you are only pulling a whole table/view into a multi-dimensional table to clean, dry-run, and push — like walkthrough one — you do not need a read source first: add a connection draft under Connections, pick the object, clean it, and dry-run. A "read source" is a separate, reusable configuration hardened through the four steps "pick system, define shape, probe, approve", meant for fetching a single record by business key — especially when it will be reused inside a "composition" two-hop chain. A whole-table cleanse does not need one.',
  },
  {
    zhQ: '为什么我看不到某个分区或按钮？',
    zhA: '数据工厂、外接数据源以及页面内的各个分区 / 按钮都按权限码控制显示——不是所有账号都能看到全部内容。具体应该开通哪些权限码，请查阅本次改动附带的设计文档中的角色 / 权限对照表；这里不重复列码。',
    enQ: 'Why can\'t I see a certain section or button?',
    enA: 'Visibility of the Data Factory nav entry, the Data Sources page, and individual sections/buttons on this page is all controlled by permission codes — not every account sees everything. For exactly which codes to grant, see the role/permission table in the design doc that ships with this change; this page does not repeat that list here.',
  },
]
</script>

<style scoped>
.integration-help__section {
  margin-bottom: var(--ms-space-5);
}
.integration-help__section h2 {
  margin: 0 0 var(--ms-space-3);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}
.integration-help__section p {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  line-height: 1.6;
}
.integration-help__compare-list {
  margin: 0;
  padding-left: var(--ms-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}
.integration-help__compare-list strong {
  margin-right: var(--ms-space-2);
  color: var(--ms-text-1);
}
.integration-help__table-wrap {
  overflow-x: auto;
}
.integration-help__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.integration-help__table th,
.integration-help__table td {
  border-bottom: 1px solid var(--ms-border-light);
  padding: var(--ms-space-2) var(--ms-space-3);
  text-align: left;
  vertical-align: top;
}
.integration-help__table small {
  display: block;
  margin-top: var(--ms-space-1);
  color: var(--ms-text-3);
}
.integration-help__case-steps {
  margin: 0;
  padding-left: var(--ms-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}
.integration-help__case-step > strong {
  color: var(--ms-text-1);
}
.integration-help__case-step dl {
  margin: var(--ms-space-2) 0 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--ms-space-1) var(--ms-space-3);
}
.integration-help__case-step dt {
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
  white-space: nowrap;
}
.integration-help__case-step dd {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.6;
}
.integration-help__faq-item {
  padding: var(--ms-space-2) 0;
  border-bottom: 1px solid var(--ms-border-light);
}
.integration-help__faq-item:last-child {
  border-bottom: none;
}
.integration-help__faq-item summary {
  cursor: pointer;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.integration-help__faq-item p {
  margin: var(--ms-space-2) 0 0;
  color: var(--ms-text-2);
  line-height: 1.6;
}
</style>

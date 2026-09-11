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
      <p class="integration-help__callout" data-testid="help-case-sql-source-real-values">
        {{ bi(
          '配置表单里请填真实值。表单输入框里的灰字（例如 Host 框里的样例地址、Database 框里的样例库名）是 HTML placeholder 提示，不会被提交；尖括号写法的占位符只用于文档、截图和验收证据，填进真实表单会让连接不可用。判断连接是否可用的唯一动作是点「测试连接」——「创建」只把配置落库，不会拨号。',
          'Fill the real configuration form with real values. The grey text inside an input (the sample address in Host, the sample database name in Database) is an HTML placeholder hint and is never submitted; angle-bracket placeholders belong in docs, screenshots and acceptance evidence only — typed into a real form they leave the connection unusable. The only action that tells you whether a connection works is "Test connection"; "Create" merely persists the configuration and never dials out.',
        ) }}
      </p>
      <ol class="integration-help__case-steps" data-testid="help-case-sql-source-steps">
        <li
          v-for="(step, index) in INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS"
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
            <dt>{{ bi('这一步对应的代码', 'The code this step maps to') }}</dt>
            <dd :data-testid="`help-case-sql-source-anchors-${step.id}`">
              <code v-for="anchor in step.anchors" :key="`${anchor.file}:${anchor.token}`" class="integration-help__anchor">
                {{ anchor.file }} · {{ anchor.token }}
              </code>
            </dd>
          </dl>
        </li>
      </ol>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-case-k3-wise">
      <h2>{{ bi('案例二：K3 WISE 预设', 'Walkthrough two: the K3 WISE preset') }}</h2>
      <p>
        {{ bi(
          '这条旅程的真实方向是 PLM → K3 预览，不是“读 K3”：预设页先接通 K3 通道，再安装 staging 多维表，然后生成两条 PLM 来源、K3 目标的 draft pipeline；Dry-run 读的是 PLM 来源，产出的是“如果真要写，会发给 K3 的那份 payload”的预览。K3 目标永久只读，预览由本地组装，不向 K3 发出任何请求。',
          'The real direction of this journey is PLM → K3 preview, not "reading K3": the preset page first connects the K3 channel, installs the staging multi-dimensional table, then generates two draft pipelines whose source is PLM and whose target is K3. A dry-run reads the PLM source and produces a preview of the request payload that a real transfer would have sent to the ERP. The K3 target is permanently read-only, and the preview is composed locally without issuing any request to it.',
        ) }}
      </p>
      <p class="integration-help__callout" data-testid="help-case-k3-wise-preview-not-saved">
        {{ bi(
          '预览结果不会被保存：它只在这次请求的响应里返回并显示在页面上，刷新即消失，既不会落进 staging 多维表，也不会落进任何目标系统。「打开多维表（新建记录入口）」是一个纯导航链接，跳到该 staging 表的多维表页面，点它不触发任何保存动作；这个按钮由「安装 Staging 多维表」的结果驱动，和 Dry-run 结果无关。要让数据真正落进多维表，需要在数据工厂把目标设为 MetaSheet 多维表后做一次显式推送，或者导出 CSV / Excel。',
          'The preview result is not persisted: it comes back in that one response, is rendered on the page, and is gone on reload — it does not land in the staging multi-dimensional table, nor in any target system. "Open the multi-dimensional table (new-record entry)" is a plain navigation link to that staging table\'s grid page; clicking it triggers no persistence call at all, and the link is driven by the staging-install result rather than by any dry-run. To actually land rows in a multi-dimensional table, set the target to a MetaSheet multi-dimensional table in the Data Factory and run one explicit push, or export CSV / Excel.',
        ) }}
      </p>
      <ol class="integration-help__case-steps" data-testid="help-case-k3-wise-steps">
        <li
          v-for="(step, index) in INTEGRATION_HELP_K3_WISE_CASE_STEPS"
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
            <dt>{{ bi('这一步对应的代码', 'The code this step maps to') }}</dt>
            <dd :data-testid="`help-case-k3-wise-anchors-${step.id}`">
              <code v-for="anchor in step.anchors" :key="`${anchor.file}:${anchor.token}`" class="integration-help__anchor">
                {{ anchor.file }} · {{ anchor.token }}
              </code>
            </dd>
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

// ---------------------------------------------------------------------------------------------
// End-to-end walkthroughs (G12/G41, rewritten 2026-09-10 after review).
//
// REVIEW FINDING THIS SHAPE ANSWERS. The first version of these two walkthroughs described an
// operation chain that does not exist: step one told the reader to type placeholders into the real
// data-source form and then promised a usable connection, and case two claimed the K3 dry-run
// "only reads K3" and that "open the multi-dimensional table" saves the preview. Copy that merely
// EXISTS is not copy that is TRUE, and a test that only asserts the copy is rendered cannot tell
// the two apart.
//
// So every step carries `anchors`: the file plus a literal token (route path, data-testid, button
// label, function name) that must be findable in that file for the step's described action to be
// real. The spec reads those files off disk and asserts each token is present — deleting a button,
// renaming a testid or moving a route turns the corresponding step red instead of leaving the help
// center quietly describing a dead control. Anchors are IDENTIFIERS ONLY: never an error-code
// literal, because the page's error-code vocabulary has exactly one source (the IU-1 label module's
// `integrationErrorCodeEntries()` table further down) and a code pasted into prose here would be a
// second one.
export interface HelpCaseStepAnchor {
  /** Repo-root-relative path of the file that proves this step's action exists. */
  file: string
  /** A literal that must occur in that file (route path, data-testid, label, function name). */
  token: string
}

export interface HelpCaseStep {
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
  anchors: HelpCaseStepAnchor[]
}

// Case one: SQL read-only source -> multi-dimensional table.
//
// The producer chain, read out before rewriting (the reason the placeholder claim had to go):
//   DataSourcesView.vue `ds-test-draft` -> runDraftTest() -> data-sources/api.ts
//     testDataSourceDraftConnection() -> POST /api/data-sources/test -> routes/data-sources.ts ->
//     DataSourceManager.testEphemeralConnection() — this is the ONLY step that dials the database.
//   DataSourcesView.vue `ds-submit` -> submit() -> buildCreatePayload() -> POST /api/data-sources ->
//     manager.addDataSource() -> addDataSourceInternal(config, false) — persists WITHOUT connecting.
// That asymmetry is the whole point: a placeholder host saves successfully and only fails later, so
// "it saved" can never be reported as "the connection works".
export const INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS: HelpCaseStep[] = [
  {
    id: 'register-data-source',
    titleZh: '在「外接数据源」页填真实连接参数',
    titleEn: 'Fill the real connection parameters on the Data Sources page',
    whereZh: '「外接数据源」页 /data-sources。数据工厂 · 连接管理只会按 ID 引用这里的数据源，不在那边重复填账号密码。',
    whereEn: 'The Data Sources page at /data-sources. Data Factory · Connections only references a source registered here by id; it never asks you to re-enter the account there.',
    actionZh: '点「新建数据源」打开表单，填 ID、名称、类型（PostgreSQL / SQL Server / MySQL）、Host、Port、Database 和一个只读账号——全部填目标库的真实值，并保持「只读」勾选。输入框里的灰字是 placeholder 属性的示例提示，不是可提交的值。',
    actionEn: 'Click "New data source" to open the form and fill in id, name, type (PostgreSQL / SQL Server / MySQL), host, port, database and a read-only account — all with the target database\'s real values, leaving the read-only box checked. The grey text inside each input is a placeholder attribute hint, not a submittable value.',
    successZh: '表单保持展开，底部操作区有「测试连接」和「创建」两个按钮——新建模式下「测试连接」始终提供，不按字段是否填满来置灰，所以下一步随时可以用它验证。',
    successEn: 'The form stays open with two buttons in its action row — "Test connection" and "Create". In create mode the test button is always offered (it is not greyed out based on how complete the fields are), so the next step can verify at any point.',
    failureZh: 'SQL Server 源提示需要 Host 或 Server 之一——这条校验在提交前就拦住了，补一个即可；Postgres / MySQL 只认 Host。',
    failureEn: 'A SQL Server source reports that either host or server is required — that check fires before submit, so fill one in; Postgres / MySQL accept host only.',
    anchors: [
      { file: 'apps/web/src/router/appRoutes.ts', token: "path: '/data-sources'" },
      { file: 'apps/web/src/views/DataSourcesView.vue', token: 'ds-new-button' },
      { file: 'apps/web/src/views/DataSourcesView.vue', token: 'ds-field-host' },
      { file: 'apps/web/src/views/DataSourcesView.vue', token: 'ds-field-readonly' },
    ],
  },
  {
    id: 'test-then-create',
    titleZh: '先「测试连接」，再「创建」',
    titleEn: 'Test the connection first, then create',
    whereZh: '同一个新建表单的底部操作区。',
    whereEn: 'The action row at the bottom of that same create form.',
    actionZh: '先点「测试连接」——它把当前表单内容发给一个临时测试接口，真正拨号，然后原样丢弃：不保存、不注册任何数据源。看到「连接成功」后再点「创建」。',
    actionEn: 'Click "Test connection" first — it posts the current form to an ephemeral test endpoint that really dials out and then throws everything away: nothing is stored, nothing is registered. Only after you see "connection succeeded" do you click "Create".',
    successZh: '表单下方出现「连接成功 · 延迟」；点「创建」后数据源出现在列表里，它的 ID 就是后面连接草稿里要引用的 connectionId。',
    successEn: 'A "connection succeeded · latency" line appears under the form; after "Create" the source shows up in the list, and its id is the connectionId you will reference from the connection draft.',
    failureZh: '出现「连接失败」时，提示里不会回显你填的 Host 或账号（服务端会把提交的标识符从驱动原文里剔掉）——真实原因看服务端日志，或对已保存的源用列表行里的「测试连接」。注意「创建」本身不拨号，所以填错也会保存成功：保存成功不等于连得上。',
    failureEn: 'On "connection failed" the message does not echo the host or account you typed (the server strips submitted identifiers out of the driver text) — read the server log for the real cause, or use the row-level "Test connection" on an already-saved source. Note that "Create" itself never dials, so a wrong value still saves successfully: saved is not the same as reachable.',
    anchors: [
      { file: 'apps/web/src/views/DataSourcesView.vue', token: 'ds-test-draft' },
      { file: 'apps/web/src/data-sources/api.ts', token: "'/api/data-sources/test'" },
      { file: 'apps/web/src/views/DataSourcesView.vue', token: 'ds-submit' },
      { file: 'apps/web/src/data-sources/buildPayload.ts', token: 'export function buildCreatePayload' },
      { file: 'packages/core-backend/src/data-adapters/DataSourceManager.ts', token: 'addDataSourceInternal(config, false)' },
      { file: 'packages/core-backend/src/data-adapters/DataSourceManager.ts', token: 'async testEphemeralConnection' },
    ],
  },
  {
    id: 'connection-draft',
    titleZh: '新增连接草稿并用 connectionId 引用',
    titleEn: 'Add a connection draft that references the connectionId',
    whereZh: '数据工厂 · 连接管理，勾选「显示 SQL / 高级连接」后点「新增连接草稿」。',
    whereEn: 'Data Factory · Connections — check "Show SQL / advanced connectors", then click "Add connection draft".',
    actionZh: '连接类型选 “Read-only SQL data source”（kind: data-source:sql-readonly）；connectionId 下拉选刚注册的数据源；对象(表 / 视图) 下拉选一张要读的表或视图；点「保存连接设置」。',
    actionEn: 'Set the connection type to "Read-only SQL data source" (kind: data-source:sql-readonly), pick the connectionId you just registered, pick the object (table / view) to read, then click "Save connection".',
    successZh: '提示保存成功，这条连接出现在「已配置连接」清单里。',
    successEn: 'A save-succeeded status appears and the connection shows up in the "configured connections" list.',
    failureZh: 'connectionId 下拉为空、或表 / 视图列表为空——这一步是真实读库，所以它会先于其他步骤暴露上一步没测出来的连接问题：回 /data-sources 用「测试连接」确认，并确认账号对该库有权限。',
    failureEn: 'The connectionId dropdown is empty, or the table/view list is empty — this step reads the database for real, so it is where a connection problem you skipped testing surfaces first: go back to /data-sources, run "Test connection", and confirm the account can see that database.',
    anchors: [
      { file: 'apps/web/src/components/integration/IntegrationConnectionSection.vue', token: 'show-advanced-connectors' },
      { file: 'apps/web/src/components/integration/IntegrationConnectionSection.vue', token: 'data-source-bridge-id' },
      { file: 'apps/web/src/components/integration/IntegrationConnectionSection.vue', token: 'save-connection-draft' },
      { file: 'plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs', token: "label: 'Read-only SQL data source'" },
    ],
  },
  {
    id: 'pick-dataset',
    titleZh: '选择系统与数据集',
    titleEn: 'Pick the system and dataset',
    whereZh: '数据工厂 · 清洗映射（「选择系统与数据集」面板）。',
    whereEn: 'Data Factory · Cleansing & Mapping (the "Pick system and dataset" panel).',
    actionZh: '来源系统选刚保存的连接，点「加载来源对象」，在「来源数据集（从哪里取数）」下拉里选那张表或视图（同一个选择器，标题叫“对象”，下拉标签叫“数据集”——见上方术语表）。',
    actionEn: 'Pick the connection you just saved as the source system, click "Load source objects", and pick the table/view from the "source dataset" dropdown (the same picker is titled "object" but the dropdown label says "dataset" — see the glossary above).',
    successZh: '数据集下拉被填满，字段列表加载出来，说明这个对象确实可读。',
    successEn: 'The dataset dropdown fills in and the field list loads, confirming the object is actually readable.',
    failureZh: '提示加载失败——回连接草稿确认 connectionId 与对象是否仍然有效，表可能已被删除或权限已被收回。',
    failureEn: 'A load-failed message appears — go back to the connection draft and confirm the connectionId and object are still valid; the table may have been dropped or access revoked.',
    anchors: [
      { file: 'apps/web/src/components/integration/IntegrationObjectTemplateSection.vue', token: 'load-source-objects' },
      { file: 'apps/web/src/components/integration/IntegrationObjectTemplateSection.vue', token: 'data-testid="source-object"' },
    ],
  },
  {
    id: 'cleansing-mapping',
    titleZh: '创建清洗表并配置映射',
    titleEn: 'Create the cleansing table and map the fields',
    whereZh: '数据工厂 · 清洗映射。',
    whereEn: 'Data Factory · Cleansing & Mapping.',
    actionZh: '点「创建清洗表」生成一张 staging 多维表；在多维表里修正、审核、补字段；配置字段映射规则。',
    actionEn: 'Click "Create cleansing table" to generate a staging multi-dimensional table, fix/review/fill fields in the grid, then configure the field-mapping rules.',
    successZh: '状态显示清洗表已创建，可以在 staging 卡片上选择「作为 Dry-run 来源」。',
    successEn: 'The status shows the cleansing table was created, and you can pick "use as dry-run source" on the staging card.',
    failureZh: '保存版本时报 500——大概率是数据库迁移还没跑到位，这是常见部署缺口，不是配置写错了。',
    failureEn: 'Save-version returns a 500 — most likely the required database migrations have not been applied yet; this is a common deployment gap, not a configuration mistake.',
    anchors: [
      { file: 'apps/web/src/components/integration/IntegrationCleaningDatasetSection.vue', token: 'install-staging' },
      { file: 'apps/web/src/components/integration/IntegrationCleaningDatasetSection.vue', token: '创建清洗表' },
    ],
  },
  {
    id: 'dry-run',
    titleZh: 'Dry-run',
    titleEn: 'Dry-run',
    whereZh: '数据工厂 · 运行与推送。',
    whereEn: 'Data Factory · Run & Push.',
    actionZh: '点「Dry-run」。',
    actionEn: 'Click "Dry-run".',
    successZh: '来源被读取、按映射转换，并生成目标 payload 预览；目标系统的写入调用在 dry-run 分支上根本不会执行。平台自己仍会记一条本次运行的记录（details 里标记为 dry-run），所以「监控与死信」的运行列表里能看到它；但 dry-run 的失败行只出现在预览自带的错误清单里，不会生成死信。',
    successEn: 'The source is read, transformed by your mapping, and a target payload preview is produced; the target-system write call is simply not reached on the dry-run branch. The platform still records the run itself (flagged as a dry run in its details), so it appears in the run list under "Monitoring & Dead Letters" — but a dry run\'s failed rows only show up in the preview\'s own error list; they never become dead letters.',
    failureZh: '按钮置灰或提示前置条件未满足——按提示补齐连接 / 对象 / 映射，不要跳过直接推送。',
    failureEn: 'The button is disabled or a readiness message appears — fill in the missing connection / object / mapping as instructed rather than skipping straight to push.',
    anchors: [
      { file: 'apps/web/src/components/integration/IntegrationPipelineRunSection.vue', token: 'run-dry-run' },
      { file: 'plugins/plugin-integration-core/lib/pipeline-runner.cjs', token: 'attachDryRunTargetPreview' },
      { file: 'plugins/plugin-integration-core/lib/pipeline-runner.cjs', token: 'if (!dryRun && cleanRecords.length > 0)' },
      { file: 'plugins/plugin-integration-core/lib/pipeline-runner.cjs', token: 'async function writeDeadLetter(input) {' },
      { file: 'plugins/plugin-integration-core/lib/pipeline-runner.cjs', token: 'let run = await runLogger.startRun({' },
    ],
  },
  {
    id: 'push-to-multitable',
    titleZh: '推送到多维表',
    titleEn: 'Push to the multi-dimensional table',
    whereZh: '数据工厂 · 运行与推送。',
    whereEn: 'Data Factory · Run & Push.',
    actionZh: '目标选 MetaSheet 多维表（已建好的 staging 多维表也可以直接作为目标）；勾选「允许本次 Save-only 推送」；点「Save-only 推送」。也可以先点「导出」，选 CSV 或 Excel 做人工复核。',
    actionEn: 'Set the target to a MetaSheet multi-dimensional table (an existing staging table can be used as the target directly), check the box that allows this one push, then click the push button. You can also click "Export" first and pick CSV or Excel for manual review.',
    successZh: '成功后展示写入数与目标记录信息；可以在「监控与死信」分区看到这次运行的记录。',
    successEn: 'On success it shows the write count and target record info; you can see this run recorded under "Monitoring & Dead Letters".',
    failureZh: '推送失败会写入一条死信——回「监控与死信」分区打开这条死信排查，或对照下方错误码表核对机器码。',
    failureEn: 'A failed push writes a dead letter — open it from "Monitoring & Dead Letters" to investigate, or check the machine code against the error-code table below.',
    anchors: [
      { file: 'apps/web/src/components/integration/IntegrationPipelineRunSection.vue', token: 'allow-save-only-run' },
      { file: 'apps/web/src/components/integration/IntegrationPipelineRunSection.vue', token: 'run-save-only' },
      { file: 'apps/web/src/views/IntegrationWorkbenchView.vue', token: 'export-cleansed-result' },
    ],
  },
]

// Case two: the K3 WISE preset.
//
// The producer chain, read out before rewriting (the reason "only reads K3" and "opening the
// multi-dimensional table saves the preview" had to go):
//   IntegrationK3WiseSetupView.vue journey nav = connect K3 -> prepare multi-dim table -> create
//     pipelines -> dry-run then push. Step one DOES require typing the WebAPI address + authority
//     code; there is a "保存配置" then "测试 WebAPI" pair.
//   buildK3WisePipelinePayloads() sets sourceSystemId = the PLM source system and targetSystemId =
//     the K3 WebAPI system, with descriptions "Draft PLM material/BOM cleansing pipeline" — so the
//     READ side is PLM, and K3 is the (fenced) write side.
//   executePipeline(target, true) -> POST .../dry-run -> pipeline-runner.runPipeline ->
//     attachDryRunTargetPreview -> targetAdapter.previewUpsert(); the K3 WebAPI adapter's
//     previewUpsert composes the Save body and returns it WITHOUT calling login() or issuing any
//     request, while its upsert() refuses permanently via the four-layer K3 write fence.
//   "打开多维表（新建记录入口）" is a <router-link :to="target.openLink"> built by
//     buildStagingOpenTargets()/buildMultitableOpenLink() from the STAGING INSTALL result — pure
//     navigation to /multitable/:sheetId/:viewId, no save call anywhere on that path.
export const INTEGRATION_HELP_K3_WISE_CASE_STEPS: HelpCaseStep[] = [
  {
    id: 'connect-k3',
    titleZh: '接通 K3 通道',
    titleEn: 'Connect the K3 channel',
    whereZh: '/integrations/k3-wise（也可以从数据工厂 · 连接管理点「使用 K3 WISE 预设」进入）。',
    whereEn: '/integrations/k3-wise (or click "Use K3 WISE preset" from Data Factory · Connections).',
    actionZh: '预设带的是物料 / BOM 的对象模板和字段映射，连接参数仍然要填：按页面第一步填 WebAPI 地址与授权码，先点「保存配置」，再点「测试 WebAPI」（SQL Server 通道同理）。和案例一一样，这里填真实值，先保存后测试——有未保存改动时页面会直接拦住测试。',
    actionEn: 'The preset ships the material / BOM object templates and field mappings; the connection parameters are still yours to enter. Follow the page\'s first step: type the WebAPI address and authority code, click "Save configuration", then click "Test WebAPI" (same for the SQL Server channel). As in walkthrough one these are real values, and save comes before test — the page blocks testing while an unsaved draft exists.',
    successZh: '「WebAPI 状态」徽标变为已连接并显示最近测试时间。',
    successEn: 'The "WebAPI status" badge flips to connected and shows the last-tested timestamp.',
    failureZh: '页面打不开或提示无权限——这条路由需要写权限，找管理员确认账号权限；测试失败时页面只给一句概述，原始诊断 JSON 在可折叠的排障区里。',
    failureEn: 'The page fails to load or reports no permission — this route requires the integration write permission; ask an admin. If a test fails the page shows one summary line, with the raw diagnostic JSON inside the collapsible troubleshooting block.',
    anchors: [
      { file: 'apps/web/src/router/appRoutes.ts', token: "path: '/integrations/k3-wise'" },
      { file: 'apps/web/src/components/integration/IntegrationConnectionSection.vue', token: 'k3-preset-entry' },
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: '测试 WebAPI' },
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: 'connection-test-summary' },
    ],
  },
  {
    id: 'install-staging',
    titleZh: '安装 Staging 多维表',
    titleEn: 'Install the staging multi-dimensional table',
    whereZh: 'K3 WISE 预设页左侧「清洗链路」面板。',
    whereEn: 'The "cleansing chain" panel on the left of the K3 WISE preset page.',
    actionZh: '点「安装 Staging 多维表」。',
    actionEn: 'Click "Install staging table".',
    successZh: '状态提示 Staging 多维表已安装或确认存在；安装结果里带着每张表的 sheetId / viewId，于是面板下方出现「打开多维表（新建记录入口）」链接。',
    successEn: 'The status says the staging tables were installed or confirmed present; the install result carries each table\'s sheetId / viewId, which is what makes the "Open the multi-dimensional table (new-record entry)" links appear below the panel.',
    failureZh: '提示安装失败——详情见服务端日志；先确认数据库迁移已跑到位。按钮置灰时看它下面列出的待补字段。',
    failureEn: 'An install-failed message appears — see the server log for detail, and first confirm the database migrations have been applied. If the button is disabled, read the missing-field list under it.',
    anchors: [
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: '安装 Staging 多维表' },
      { file: 'apps/web/src/services/integration/k3WiseSetup.ts', token: "'/api/integration/staging/install'" },
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: 'staging-open-targets' },
    ],
  },
  {
    id: 'create-pipelines',
    titleZh: '创建 PLM → K3 的清洗 Pipeline',
    titleEn: 'Create the PLM → K3 cleansing pipelines',
    whereZh: 'K3 WISE 预设页的「多维表清洗准备」区 +「清洗链路」面板。',
    whereEn: 'The "multi-dimensional table preparation" section plus the "cleansing chain" panel on the preset page.',
    actionZh: '填「PLM Source System ID」（来源）与只读展示的「K3 Target System ID」（目标），选好物料 / BOM 的 Staging 对象，点「创建清洗 Pipeline」。',
    actionEn: 'Fill in "PLM Source System ID" (the source) and the read-only "K3 Target System ID" (the target), pick the material / BOM staging objects, then click "Create cleansing pipelines".',
    successZh: '生成两条 draft 状态的 pipeline（物料一条、BOM 一条），方向都是 PLM 来源 → K3 目标；页面把两条的 id / 名称 / 状态回显出来。',
    successEn: 'Two draft pipelines are created (one material, one BOM), both running from the PLM source to the K3 target; the page echoes each one\'s id, name and status.',
    failureZh: '这一页是 PLM-first 创建器：如果当前只有 MetaSheet staging 多维表而没有 PLM 来源，按页面提示回数据工厂，选 MetaSheet staging 作为来源去建清洗流程。',
    failureEn: 'This page is a PLM-first builder: if you only have a MetaSheet staging table and no PLM source, follow the page hint back to the Data Factory and build the flow with the MetaSheet staging source instead.',
    anchors: [
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: 'PLM Source System ID' },
      { file: 'apps/web/src/services/integration/k3WiseSetup.ts', token: 'export function buildK3WisePipelinePayloads' },
      { file: 'apps/web/src/services/integration/k3WiseSetup.ts', token: 'sourceSystemId,' },
      { file: 'apps/web/src/services/integration/k3WiseSetup.ts', token: 'targetSystemId,' },
    ],
  },
  {
    id: 'dry-run-preview',
    titleZh: 'Dry-run 物料 / BOM：读 PLM，产出 K3 payload 预览',
    titleEn: 'Dry-run material / BOM: read PLM, produce the K3 payload preview',
    whereZh: 'K3 WISE 预设页的「执行 Pipeline」折叠区。',
    whereEn: 'The "run pipeline" collapsible block on the preset page.',
    actionZh: '点「Dry-run 物料」或「Dry-run BOM」。',
    actionEn: 'Click "Dry-run material" or "Dry-run BOM".',
    successZh: '页面回显一段预览：每行的 PLM 来源值、按映射转换后的值，以及目标侧会发出的请求形状（方法、路径、body）。这份 payload 由适配器在本地组装，dry-run 分支上不会调用目标的写入方法，也不会向 ERP 发出任何请求；预览只在响应里，不落库。',
    successEn: 'The page echoes a preview: each row\'s PLM source values, the mapped values, and the shape of the request the target side would receive (method, path, body). That payload is composed locally by the adapter; on the dry-run branch the target\'s write method is never invoked and no request goes to the ERP, and the preview lives in the response only — nothing is persisted.',
    failureZh: '一个物料存在多个 BOM 报“存在歧义”不是 bug——收窄筛选条件或换一条能唯一区分候选记录的规则。旁边的「执行物料 / 执行 BOM」是真实执行按钮，对 K3 目标会被运行器直接拒绝（见下一步）。',
    failureEn: 'A material with multiple BOMs reporting "ambiguous" is not a bug — narrow the filter or use a resolver rule that can uniquely tell the candidates apart. The neighbouring "Execute material / Execute BOM" buttons are the live-run buttons, and against a K3 target the runner refuses them outright (see the next step).',
    anchors: [
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: 'Dry-run 物料' },
      { file: 'apps/web/src/services/integration/k3WiseSetup.ts', token: "const endpoint = dryRun ? 'dry-run' : 'run'" },
      { file: 'plugins/plugin-integration-core/lib/pipeline-runner.cjs', token: 'targetAdapter.previewUpsert(' },
      { file: 'plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs', token: 'async function previewUpsert' },
    ],
  },
  {
    id: 'open-multitable-is-navigation-only',
    titleZh: '「打开多维表」只是导航；要落数据走推送或导出',
    titleEn: '"Open the multi-dimensional table" is navigation only; landing data means a push or an export',
    whereZh: '「清洗链路」面板下方的打开链接 / 数据工厂 · 运行与推送。',
    whereEn: 'The open links under the "cleansing chain" panel, and Data Factory · Run & Push.',
    actionZh: '「打开多维表（新建记录入口）」是一个路由链接，跳到 /multitable/<表>/<视图>，点它不会保存任何东西，也不会把刚才的预览写进去；它由安装结果生成，和 Dry-run 无关。要真正落数据，在数据工厂把目标设为 MetaSheet 多维表后做一次显式推送，或用导出功能落 CSV / Excel。',
    actionEn: 'The "open the multi-dimensional table (new-record entry)" control is a router link to /multitable/<sheet>/<view>. Clicking it persists nothing and does not copy the preview anywhere; it is generated from the install result and has no relationship to the dry-run. To land data for real, set the target to a MetaSheet multi-dimensional table in the Data Factory and run one explicit push, or export CSV / Excel.',
    successZh: '浏览器跳到那张 staging 多维表；表里此刻有什么，取决于此前真实的推送或人工录入，而不是这次 Dry-run。',
    successEn: 'The browser navigates to that staging table; whatever rows it contains come from an earlier real push or manual entry, not from this dry-run.',
    failureZh: '打开后是空表，通常说明你只做了 Dry-run 还没做过推送。链接报表不存在时，回「安装 Staging 多维表」重装，或确认那张表没有被单独删掉。',
    failureEn: 'An empty table usually means you have only dry-run and never pushed. If the link reports that the table does not exist, reinstall from "Install staging table" or confirm the sheet was not deleted separately.',
    anchors: [
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: 'function buildStagingOpenTargets' },
      { file: 'apps/web/src/views/IntegrationK3WiseSetupView.vue', token: 'function buildMultitableOpenLink' },
      { file: 'plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs', token: 'function refuseK3ExternalWritePermanently' },
    ],
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
//   2. Two end-to-end walkthroughs (G12/G41, REWRITTEN 2026-09-10 after review): "SQL read-only
//      source -> multi-dimensional table" and "K3 WISE preset". Both live in the plain <script>
//      block above as INTEGRATION_HELP_SQL_SOURCE_CASE_STEPS / INTEGRATION_HELP_K3_WISE_CASE_STEPS,
//      each step carrying `anchors` (file + literal token) that the spec verifies against the real
//      source files. The review finding they answer: the first draft told the reader to type
//      placeholders into the real data-source form while promising a working connection, and said
//      the K3 dry-run "only reads K3" and that "open the multi-dimensional table" saves the preview.
//      None of that is what the code does — see the two producer-chain comments above each array.
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
/* Token-only (UF-6 grammar): no hex/rgb literals, only var(--ms-*) / var(--el-*). */
.integration-help__callout {
  margin: var(--ms-space-2) 0 var(--ms-space-3);
  padding: var(--ms-space-3);
  border-left: 3px solid var(--ms-border);
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  line-height: 1.6;
}
.integration-help__anchor {
  display: inline-block;
  margin: 0 var(--ms-space-2) var(--ms-space-1) 0;
  padding: 0 var(--ms-space-1);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
  color: var(--ms-text-3);
  word-break: break-all;
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

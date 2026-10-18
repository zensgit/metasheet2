<template>
  <section class="automation-read" data-testid="automation-read-panel">
    <h3>{{ bi('Automation 受控只读预览', 'Automation controlled read-only preview') }}</h3>
    <p>{{ bi('仅连接当前 owner 且同时具备集成管理员权限的人可授权，服务器在每次读取前重新核验。此入口不代表已获准读取真实客户数据。', 'Only the current connection owner who is also an integration administrator may authorize. The server checks again before each read. This entry does not itself authorize real customer access.') }}</p>
    <p>{{ bi('只生成差异预览：不写业务表、不发送宜搭、不产生应用令牌。普通 Automation 测试/执行不能替代这里的授权。', 'Preview only: no business-table writes, Yida sending, or apply token. Ordinary Automation Test/Run does not replace this authorization.') }}</p>
    <p v-if="!signedIn">{{ bi('请先登录。', 'Sign in first.') }}</p>
    <p v-else-if="!usableContext">{{ bi('打开项目并选择有效的备料目标表后，才能查看可授权规则。', 'Open a project with a valid stock-preparation target sheet to discover eligible rules.') }}</p>
    <button type="button" data-testid="automation-read-load" :disabled="busy || !signedIn || !usableContext || unresolved" @click="load">
      {{ bi('查看可授权规则与我的记录', 'Load eligible rules and my history') }}
    </button>
    <button type="button" data-testid="automation-read-history-only" :disabled="busy || !signedIn || !usableProject || unresolved" @click="loadHistoryOnly">
      {{ bi('只查看我的授权/运行记录', 'View only my authorizations and runs') }}
    </button>
    <p>{{ bi('读取服务暂停或当前没有目标表时，仍可单独查看历史、撤销授权与请求取消；这些操作不启动来源读取。', 'While the read runtime is stopped or no target sheet is selected, history, revocation, and cancellation remain independently available. They do not start source reads.') }}</p>
    <p>{{ bi('打开页面不会读取来源；下方加载、刷新和查看详情只读取授权/运行元数据。启动预览须另点按钮。', 'Opening this panel does not read the source. Loading, refreshing, and viewing details read authorization/run metadata only. Starting a preview is a separate action.') }}</p>
    <p v-if="error" role="alert" data-testid="automation-read-error">{{ error }}</p>
    <p v-if="notice" role="status" data-testid="automation-read-notice">{{ notice }}</p>

    <div v-if="recovery" data-testid="automation-read-recovery">
      <p>{{ bi('提交响应未确认，后台可能已接收。不要另建执行；下面只用原请求键核对同一次提交，不会主动创建第二次执行。离开页面或切换账号会清除本机恢复信息，请在我的运行记录中核对。', 'The submit response is unconfirmed; the server may have accepted it. Do not start another execution. Recovery below uses the same request key for the same submission. Leaving or switching accounts clears this in-memory recovery; check My runs afterward.') }}</p>
      <button type="button" data-testid="automation-read-recover" :disabled="busy" @click="recover">{{ bi('用原请求键恢复确认', 'Recover with the original request key') }}</button>
    </div>

    <div v-if="activationRecovery" data-testid="automation-read-activation-recovery">
      <p v-if="activationRecovery.family === 'record'" data-testid="automation-read-recovery-record-trigger">{{ bi('本次确认的事件类型：', 'Event type confirmed for this command: ') }}{{ recordTriggerLabel(activationRecovery.recordTriggerType) }}</p>
      <p v-if="activationRecovery.family === 'record'" data-testid="automation-read-recovery-record-condition">{{ conditionLabel(activationRecovery.input.expectedRecordCondition) }}</p>
      <p v-if="activationRecovery.family === 'schedule'" data-testid="automation-read-recovery-schedule-definition">{{ scheduleLabel(activationRecovery.scheduleDefinition) }}</p>
      <p v-if="activationRecovery.family === 'schedule'" data-testid="automation-read-recovery-schedule-revision">{{ bi('原确认规则版本：', 'Original rule revision: ') }}{{ activationRecovery.input.expectedRuleRevision }}</p>
      <p>{{ activationRecovery.family === 'schedule' ? bi('定时授权尚未核对完成。', 'Schedule activation is unconfirmed.') : bi('记录触发授权尚未核对完成。', 'Record activation is unconfirmed.') }} {{ bi('服务器可能已经登记。只能手动用原类型、原授权键及完整原参数核对，不会另建预算或自动重试。核对前不能更改输入或建立其它授权。离开页面或切换账号会清除本机恢复信息，请随后核对我的授权。', 'The server may have registered it. Recover manually with the original family, activation key, and complete original parameters, without a new budget or automatic retry. Other inputs and authorizations stay locked until reconciled. Leaving or switching accounts clears this in-memory recovery; check My authorizations afterward.') }}</p>
      <button type="button" data-testid="automation-read-recover-activation" :disabled="busy" @click="recoverActivation">{{ bi('用原类型与参数核对自动授权', 'Reconcile the original activation family and parameters') }}</button>
    </div>
    <div v-if="retryRecovery" data-testid="automation-read-retry-recovery" :data-parent-request-id="retryRecovery.parentRequestId">
      <p>{{ bi('新预算重试的回执未核对，服务器可能已登记子尝试。只能显式用原父请求、原键、原预算及原到期时间核对，不能另建预算。离开页面或切换账号将清除本机恢复信息，请随后核对原请求的子尝试。', 'The new-budget retry receipt is unconfirmed; a child attempt may already exist. Reconcile only the original parent, key, budget and expiry, without creating another budget. Leaving or switching accounts clears this in-memory recovery; check the original request’s child attempt afterward.') }}</p>
      <p data-testid="automation-read-retry-recovery-expiry">{{ retryRecovery.input.expiresAt }}</p>
      <button type="button" data-testid="automation-read-recover-retry" :disabled="busy" @click="recoverRetry">{{ bi('用原命令核对重试回执', 'Reconcile the original retry command') }}</button>
    </div>
    <div v-if="retryReceipt" data-testid="automation-read-retry-receipt" :data-parent-request-id="retryReceipt.parentRequestId" :data-request-id="retryReceipt.requestId" :data-grant-id="retryReceipt.grantId">
      <p>{{ bi('关联子尝试已登记，不代表预览已完成；原请求和原授权未被重置。', 'Linked child attempt registered, not necessarily completed. The original request and authorization were not reset.') }}</p>
      <button type="button" data-testid="automation-read-open-retry-receipt" :disabled="busy || unresolved" @click="selectRequest(retryReceipt.requestId)">{{ bi('查看此子尝试', 'View this child attempt') }}</button>
    </div>
    <div v-if="activationReceipt" data-testid="automation-read-activation-receipt" :data-activation-id="activationReceipt.activationId" :data-grant-id="activationReceipt.grantId" :data-activation-family="activationReceipt.family">
      <p v-if="activationReceipt.family === 'record'" data-testid="automation-read-receipt-record-trigger">{{ bi('批准时的事件类型：', 'Event type at consent: ') }}{{ recordTriggerLabel(activationReceipt.recordTriggerType) }}</p>
      <p v-if="activationReceipt.family === 'schedule'" data-testid="automation-read-receipt-schedule-definition">{{ scheduleLabel(activationReceipt.scheduleDefinition) }}</p>
      <p v-if="activationReceipt.family === 'schedule'" data-testid="automation-read-receipt-schedule-revision">{{ bi('批准时规则版本：', 'Rule revision at consent: ') }}{{ activationReceipt.scheduleRuleRevision }}</p>
      <p v-if="activationReceipt.family === 'record'" data-testid="automation-read-receipt-record-condition">{{ conditionLabel(activationReceipt.recordCondition) }}</p>
      <p>{{ activationReceipt.family === 'schedule' ? bi('定时授权已登记；后续计划时点是否可读仍由服务器逐次核验。', 'Schedule activation registered. The server checks each later planned occurrence.') : bi('记录触发授权已登记；后续事件是否可读仍由服务器逐次核验。', 'Record activation registered. The server checks each later event.') }} {{ bi('登记回执不证明授权当前有效，也不证明来源已读取。', 'A receipt does not prove the authorization is currently effective or that a source read occurred.') }}</p>
      <p v-if="currentGrant?.grantId === activationReceipt.grantId">{{ bi('授权状态：', 'Authorization status: ') }}{{ currentGrant.status }} · {{ bi('有效至：', 'Expires: ') }}{{ currentGrant.expiresAt }}</p>
    </div>
    <button v-if="activationConsentSpent && !activationRecovery" type="button" data-testid="automation-read-new-activation" :disabled="busy || unresolved" @click="newActivationConsent">{{ bi('开始另一份自动授权确认（新增独立预算）', 'Begin another automatic consent (new independent budget)') }}</button>

    <div v-if="loaded">
      <p v-if="historyOnly">{{ bi('当前仅加载历史记录，未查询可授权规则，不能从历史记录直接启动新读取。', 'History only: eligible rules were not requested. History cannot directly start a new read.') }}</p>
      <template v-if="!historyOnly">
      <label>{{ bi('授权方式', 'Authorization mode') }}
        <select v-model="authorizationMode" data-testid="automation-read-mode" :disabled="busy || unresolved">
          <option value="manual">{{ bi('手动只读预览（默认）', 'Manual read-only preview (default)') }}</option>
          <option value="record">{{ bi('明确启用记录新建/更新自动预览', 'Explicitly enable record-created/updated previews') }}</option>
          <option value="schedule">{{ bi('明确启用定时只读预览', 'Explicitly enable scheduled read-only previews') }}</option>
        </select>
      </label>
      <p v-if="options.length === 0">{{ bi('本页没有可授权规则。规则须已启用、配置为单一受控只读动作，并由服务端确认当前连接、版本与目标权限。', 'No eligible rule on this page. A rule must be enabled, use the single controlled read action, and pass current connection, version, and target checks.') }}</p>
      <label>
        {{ bi('当前目标表的规则', 'Rules for the current target sheet') }}
        <select v-model="selectedRuleId" data-testid="automation-read-option" :disabled="busy || unresolved">
          <option value="">{{ bi('请选择', 'Choose a rule') }}</option>
          <option v-for="option in options" :key="option.selector.ruleId" :value="option.selector.ruleId" :disabled="!eligibleOption(option)">{{ option.ruleName || bi('未命名规则', 'Unnamed rule') }}{{ eligibleOption(option) ? '' : bi('（不适用于当前授权方式）', ' (not eligible for this mode)') }}</option>
        </select>
      </label>
      <button v-if="optionCursor" type="button" data-testid="automation-read-next-options" :disabled="busy || unresolved" @click="nextOptions">{{ bi('下一页规则', 'Next rules page') }}</button>

      <fieldset v-if="selectedOption" :disabled="busy || unresolved || (authorizationMode !== 'manual' && activationConsentSpent)">
        <legend>{{ authorizationMode === 'schedule' ? bi('明确批准有限定时授权', 'Explicitly approve bounded schedule activation') : authorizationMode === 'record' ? bi('明确批准有限记录触发授权', 'Explicitly approve bounded record activation') : bi('新建有限授权（仅手动）', 'Create a bounded authorization (manual only)') }}</legend>
        <p>{{ bi('限定项目：', 'Project: ') }}<strong data-testid="automation-read-project">{{ projectNo }}</strong></p>
        <p>{{ bi('服务器绑定此刻已批准、已激活的配置版本；连接、版本、规则或权限变化后授权将失效，必须重新核验。', 'The server binds the currently approved and active configuration version. Connection, version, rule, or permission changes invalidate authorization and require new checks.') }}</p>
        <p v-if="authorizationMode === 'record'" data-testid="automation-read-record-trigger" :data-record-trigger-type="selectedRecordTriggerType">{{ bi('本次批准的事件类型：', 'Event type for this consent: ') }}<strong>{{ recordTriggerLabel(selectedRecordTriggerType) }}</strong></p>
        <p v-if="authorizationMode === 'record'" data-testid="automation-read-record-condition" :data-record-condition-mode="selectedRecordCondition?.mode">{{ conditionLabel(selectedRecordCondition) }}</p>
        <p v-if="authorizationMode === 'record'">{{ bi('确认绑定本次加载的规则版本；规则被编辑后，服务器将拒绝旧版本确认，请重新加载并明确确认。响应未确认时只能核对原版本、原请求键，不会自动换成新规则。', 'Consent binds the rule revision loaded here. If the rule is edited, the server refuses stale consent; reload and confirm explicitly. An unconfirmed response can only be reconciled with its original revision and key, never silently replaced by a newer rule.') }}</p>
        <p v-if="authorizationMode === 'record'" data-testid="automation-read-record-scope">{{ bi('支持 record.created / record.updated，绑定上方确认的条件模式及当前规则版本。保存条件在事件发生时的私有保存后快照上求值；缺少依赖、快照不可读或字段无权限均不触发来源读取，不回读当前行。请在规则编辑页核对条件；字段定义、条件解释时区或规则变化后须重新加载并确认。record.updated 指已提交更新事件，包括零字段或无实际值变化，不是仅字段值变化。项目号固定为上面的单项目，不从事件行推导。启用本身不读取来源；后续合格事件只生成预览，不写业务表、不外发，也不授予手动执行权限。', 'Supports record.created / record.updated, bound to the confirmed condition mode and rule revision. Saved conditions use the event-time private after-image; missing dependencies, unreadable snapshots, or denied fields do not trigger source reads. The current row is never re-read. Review conditions in the rule editor; field definitions, condition timezone, or rule changes require reloading and explicit consent. record.updated means committed updates, including zero-field or unchanged-value updates, not only actual field-value changes. The single project above is fixed, not derived from the event row. Activation itself does not read the source; eligible later events create previews only, without business-table writes, external sends, or manual permission.') }}</p>
        <p v-if="authorizationMode === 'schedule'" data-testid="automation-read-schedule-definition" :data-schedule-trigger-type="selectedScheduleDefinition?.triggerType">{{ scheduleLabel(selectedScheduleDefinition) }}</p>
        <p v-if="authorizationMode === 'schedule' && selectedScheduleDefinition" data-testid="automation-read-schedule-revision">{{ bi('本次确认规则版本：', 'Rule revision for this consent: ') }}{{ selectedOption.scheduleRuleRevision }}</p>
        <p v-if="authorizationMode === 'schedule' && selectedScheduleDefinition?.triggerType === 'schedule.date_field'" data-testid="automation-read-schedule-scope">{{ bi('仅支持无条件的 schedule.date_field，确认绑定本次加载的规则版本、日期字段类型、schema 版本及上方精确配置；任何变化后须重新加载确认。日期配置仍在原规则编辑器，此处不编辑规则或开放条件。每条合格记录的每个到期时点各消耗一次固定项目的读取预算；同日多条到期记录可能多次预览同一个项目，项目绝不从记录内容推导。只接纳严格晚于本次授权的到期时点；扫描与补漏有界，不保证无限补跑。你批准的是固定单项目、期限、次数和读取预算；默认 15 分钟可能不覆盖每日计划。启用本身不读取记录日期或来源，只读结果不写业务表、不外发、不授予手动执行权限。', 'Only unconditional schedule.date_field is supported. Consent binds the loaded rule revision, date field type, schema revision, and exact definition above; changes require reloading and explicit consent. Configure dates in the original rule editor; this panel does not edit rules or enable conditions. Each eligible record occurrence consumes one read allowance for the fixed project. Multiple records due on the same day may preview that same project multiple times; the project is never derived from record content. Only occurrences strictly after this activation qualify; scanning and catch-up are bounded, not unlimited. You approve the fixed project, duration, count, and read budget; the default 15 minutes may not cover a daily schedule. Activation itself reads neither record dates nor the source. Read-only results do not write business tables, send externally, or authorize manual execution.') }}</p>
        <p v-else-if="authorizationMode === 'schedule'" data-testid="automation-read-schedule-scope">{{ bi('仅支持无条件的 schedule.cron / schedule.interval，确认绑定本次加载的规则版本与上方精确配置；规则变化后须重新加载确认。interval 的固定相位 A 是规则创建时间向下取整到毫秒，计划时点为 A+nI（n≥1，I 为上方毫秒间隔）；仅取授权后严格后续时点，首次等待可能小于一个完整间隔，不从点击时间重新计时、不补跑。请在规则编辑页核对 cron/时区或间隔，此处不编辑规则或开放条件。你批准的是固定单项目、期限、次数和读取预算。授权到期前若没有匹配计划时点，将不会读取；不保证期间一定执行，默认 15 分钟可能不覆盖每日或每月计划。启用本身不读取来源；后续合格时点只生成预览，不写业务表、不外发，也不授予手动执行权限。', 'Only unconditional schedule.cron / schedule.interval is supported. Consent binds the loaded rule revision and exact definition above; rule changes require reloading and explicit consent. The fixed interval phase A is the rule creation time floored to milliseconds: planned times are A+nI (n>=1, I is the interval in milliseconds). Only strictly later occurrences after activation qualify; the first wait may be shorter than a full interval. It does not restart from the click time, and there is no catch-up. Check cron/timezone or interval in the rule editor; this panel does not edit rules or enable conditions. You approve the fixed project, duration, count, and read budget. No matching planned occurrence before expiry means no read; authorization does not guarantee a run, and the default 15 minutes may not cover a daily or monthly schedule. Activation itself does not read the source; later eligible occurrences create previews only, without business-table writes, external sends, or manual execution permission.') }}</p>
        <label>{{ bi('有效分钟数（最多 1440）', 'Valid minutes (maximum 1440)') }} <input v-model="ttlMinutes" data-testid="automation-read-ttl" type="number" min="1" max="1440" step="1"></label>
        <label>{{ bi('最多执行次数（最多 100）', 'Maximum executions (up to 100)') }} <input v-model="maxExecutions" data-testid="automation-read-executions" type="number" min="1" max="100" step="1"></label>
        <label v-for="field in budgetFields" :key="field.key">
          {{ bi(field.zh, field.en) }} (≤ {{ selectedOption.budget[field.key] }})
          <input v-model="budgetValues[field.key]" :data-testid="`automation-read-budget-${field.key}`" type="number" min="1" :max="selectedOption.budget[field.key]" step="1">
        </label>
        <p v-if="!validInputs">{{ bi('请选择适用规则并输入正整数，且不能超过上述期限、次数和服务端读取上限。', 'Choose an eligible rule and use positive whole numbers within the stated duration, execution count, and server read limits.') }}</p>
        <template v-if="authorizationMode === 'manual'">
          <label><input v-model="grantConfirmed" data-testid="automation-read-grant-confirm" type="checkbox">{{ bi('我确认仅为上面的项目、期限、次数及读取上限建立授权；建立授权本身不启动读取。', 'I confirm authorization only for this project, duration, count, and read limits. Creating authorization does not start a read.') }}</label>
          <button type="button" data-testid="automation-read-create-grant" :disabled="!grantConfirmed || !validGrantInputs" @click="createGrant">{{ bi('创建有限授权', 'Create bounded authorization') }}</button>
        </template>
        <template v-else-if="authorizationMode === 'record'">
          <label><input v-model="recordConfirmed" data-testid="automation-read-record-confirm" type="checkbox">{{ bi('我已核对上方事件类型与条件模式，明确同意此规则的后续合格事件在上述固定项目、期限、次数和读取上限内自动生成只读预览。', 'I checked the event type and condition mode shown above and explicitly authorize this rule’s later eligible events to generate read-only previews within this fixed project, duration, count, and read limits.') }}</label>
          <button type="button" data-testid="automation-read-activate-record" :disabled="!recordConfirmed || !validRecordInputs || activationConsentSpent" @click="activateRecord">{{ bi('启用有限记录触发授权', 'Enable bounded record activation') }}</button>
        </template>
        <template v-else-if="authorizationMode === 'schedule'">
          <label><input v-model="scheduleConfirmed" data-testid="automation-read-schedule-confirm" type="checkbox">{{ selectedScheduleDefinition?.triggerType === 'schedule.date_field' ? bi('我已核对日期字段、类型、schema 版本、偏移、时间及时区，明确同意每条合格到期记录分别消耗上述固定项目预算，仅生成只读预览。', 'I checked the date field, type, schema revision, offset, time and timezone, and explicitly authorize each eligible due record to consume the fixed-project allowance separately for read-only previews.') : bi('我已核对上方计划类型、精确配置与相位说明，明确同意此规则版本在固定项目、期限、次数和预算内自动生成只读预览。', 'I checked the schedule type, exact definition and phase explanation above and explicitly authorize this rule revision within the fixed project, duration, count, and budget.') }}</label>
          <button type="button" data-testid="automation-read-activate-schedule" :disabled="!scheduleConfirmed || !validScheduleInputs || activationConsentSpent" @click="activateSchedule">{{ bi('启用有限定时授权', 'Enable bounded schedule activation') }}</button>
        </template>
      </fieldset>
      </template>

      <div v-if="currentGrant" data-testid="automation-read-current-grant" :data-grant-id="currentGrant.grantId">
        <h4>{{ bi('当前授权', 'Current authorization') }}</h4>
        <p data-testid="automation-read-current-grant-purpose">{{ purposeText(currentGrant) }}</p>
        <p data-testid="automation-read-current-grant-rule">{{ bi('授权规则：', 'Authorized rule: ') }}{{ currentGrantOption?.ruleName || currentGrant.selector.ruleId }}</p>
        <p>{{ bi('有效至：', 'Expires: ') }}{{ currentGrant.expiresAt }} · {{ bi('已使用/上限：', 'Used/limit: ') }}{{ currentGrant.usedExecutions }}/{{ currentGrant.maxExecutions }} · {{ currentGrant.status }}</p>
        <p>{{ bi('范围：', 'Scope: ') }}{{ currentGrant.projects.join('、') }}</p>
        <p v-if="!grantUsable">{{ bi('此授权目前不能在本页启动。须仍有效、含本项目且允许手动，并与当前规则页返回的完整来源/目标选择器一致；历史记录本身不是启动许可。', 'This authorization cannot currently start here. It must be active, include this project and manual trigger, and exactly match an eligible source/target selector on the current rules page. History alone is not permission to start.') }}</p>
        <button type="button" data-testid="automation-read-submit" :disabled="busy || unresolved || !grantUsable || !!currentRequest" @click="submit">{{ bi('启动一次只读预览', 'Start one read-only preview') }}</button>
        <button type="button" data-testid="automation-read-revoke" :disabled="busy || unresolved || currentGrant.status === 'revoked'" @click="revoke">{{ bi('撤销授权', 'Revoke authorization') }}</button>
        <p>{{ bi('每次启动单独计入授权次数。需要另一次执行时，请从我的授权重新查看并确认；不会自动重试。', 'Each start consumes a separate execution allowance. To start another, explicitly reopen authorization from My authorizations. No automatic retry.') }}</p>
      </div>
    </div>

    <div v-if="currentRequest" data-testid="automation-read-current-request" :data-request-id="currentRequest.requestId">
      <p data-testid="automation-read-status">{{ requestStatusText(currentRequest.status) }} <code>{{ currentRequest.status }}</code></p>
      <button type="button" data-testid="automation-read-refresh-request" :disabled="busy || unresolved" @click="refreshRequest">{{ bi('刷新运行状态（不读取来源）', 'Refresh run status (no source read)') }}</button>
      <button v-if="currentRequest.status === 'queued' || currentRequest.status === 'running'" type="button" data-testid="automation-read-cancel" :disabled="busy || unresolved" @click="cancel">{{ bi('请求取消', 'Request cancellation') }}</button>
      <p>{{ bi('取消不证明已发出的读取立即停止；以最终状态为准。结果未知时不会自动重做。', 'Cancellation does not prove an in-flight read immediately stopped. Check final status. Unknown outcomes are never automatically rerun.') }}</p>
      <button type="button" data-testid="automation-read-load-retry" :disabled="busy || unresolved" @click="loadRetryContext">{{ bi('查看新预算重试上下文（不读取来源）', 'View new-budget retry context (no source read)') }}</button>
      <div v-if="retryContext" data-testid="automation-read-retry-context" :data-parent-request-id="retryContext.request.requestId">
        <p data-testid="automation-read-retry-source-admission">{{ bi('新预算不补发来源侧的一次性读取授权；来源授权已耗尽时，子尝试仍会被拒绝，不会绕过读取围栏。', 'A new budget does not issue another one-time source authorization. If source admission is exhausted, the child attempt is still refused; read fences are not bypassed.') }}</p>
        <p>{{ bi('仅允许原创建人且仍为连接 owner/集成管理员明确批准手动请求或原日期自动请求的一次子尝试。以下是历史范围，不保证现在可执行；服务器会重新核验相同版本和权限，不升级自动授权。', 'Only the original creator who remains the connection owner and an integration administrator may explicitly approve a manual request’s child attempt or one child of an original automatic date request. This is historical scope, not current execution eligibility. The server rechecks the same versions and permissions; automatic authorizations are not upgraded.') }}</p>
        <p data-testid="automation-read-retry-project">{{ bi('原项目：', 'Original project: ') }}{{ retryContext.request.projectNo }}</p>
        <p data-testid="automation-read-retry-selector">{{ bi('原配置范围（规则 / 动作 / 系统 / 目标）：', 'Original configuration scope (rule / action / system / target): ') }}{{ retryContext.grant.selector.ruleId }} / {{ retryContext.grant.selector.actionId }} / {{ retryContext.grant.selector.systemId }} / {{ retryContext.grant.selector.targetId }}</p>
        <p>{{ purposeText(retryContext.grant) }} · {{ retryContext.grant.status }} · {{ retryContext.grant.expiresAt }}</p>
        <template v-if="retryContext.dateScheduleOrigin">
          <p data-testid="automation-read-retry-date-definition">{{ bi('原日期定义：', 'Original date definition: ') }}{{ scheduleLabel(retryContext.dateScheduleOrigin.definition) }}</p>
          <p data-testid="automation-read-retry-date-config">{{ bi('原配置：', 'Original configuration: ') }}<code>{{ JSON.stringify(retryContext.dateScheduleOrigin.definition.config) }}</code></p>
          <p data-testid="automation-read-retry-date-revision">{{ bi('原规则版本：', 'Original rule revision: ') }}{{ retryContext.dateScheduleOrigin.ruleRevision }}</p>
          <p data-testid="automation-read-retry-date-warning">{{ bi('仅按原固定项目重新读取一次；不重新扫描或判断记录日期，不恢复原计划、期限或次数。原读取可能已经发生或仍在进行；新预算不补发或重置来源的一次性读取许可，实际再次读取仍需另一份独立有效许可。日期子尝试不能继续延链重试。', 'Read the original fixed project once again. Dates are not rescanned or reevaluated; the original schedule, expiry and quota are not restored. The earlier read may have occurred or may still be in flight. A new budget does not issue or reset one-time source admission; another actual read still needs a separate valid source authorization. Date retry children cannot be retried again.') }}</p>
        </template>
        <template v-if="retryContext.nextAttempt">
          <p>{{ bi('此父请求已有唯一子尝试，不能再创建另一份预算。', 'This parent already has its single child attempt; another budget cannot be created here.') }} {{ retryContext.dateScheduleOrigin ? bi('日期子尝试仅可查看，不能继续重试。', 'The date child can only be viewed, not retried again.') : bi('若该子尝试仍需重试，请先查看它再单独确认。', 'If that child needs a retry, view it and confirm separately.') }}</p>
          <button type="button" data-testid="automation-read-open-next-attempt" :data-request-id="retryContext.nextAttempt.requestId" :disabled="busy || unresolved" @click="selectRequest(retryContext.nextAttempt.requestId)">{{ bi('查看已有子尝试', 'View the existing child attempt') }}</button>
        </template>
        <fieldset v-else-if="retryParentEligible" :disabled="busy || unresolved">
          <legend>{{ bi('明确批准一次新预算读取', 'Explicitly approve one new-budget read') }}</legend>
          <p>{{ bi('固定最多1次，不增加或重置原授权次数；项目与配置范围由原请求继承，不能在此更换。', 'Exactly one new allowance; the original quota is not increased or reset. Project and configuration scope are inherited from the parent and cannot be changed here.') }}</p>
          <label>{{ bi('新授权有效分钟数（最多1440）', 'New authorization minutes (maximum 1440)') }} <input v-model="retryTtlMinutes" data-testid="automation-read-retry-ttl" type="number" min="1" max="1440" step="1"></label>
          <p>{{ bi('下列默认值只是上次申请参考，不是当前审批上限。可明确申请新的正整数预算；服务器仍逐项核对当前审批上限，超限拒绝且不读取。', 'These defaults are the previous request, not current approved limits. You may explicitly request a new positive-integer budget; the server rechecks current approved limits and refuses excess without reading.') }}</p>
          <label v-for="field in budgetFields" :key="field.key">{{ bi(field.zh, field.en) }} ({{ bi('上次申请参考', 'previous request') }}: {{ retryContext.grant.budget[field.key] }}) <input v-model="retryBudgetValues[field.key]" :data-testid="`automation-read-retry-budget-${field.key}`" type="number" min="1" max="2147483647" step="1"></label>
          <p data-testid="automation-read-retry-warning">{{ bi('先前读取可能已经发生或仍在进行；取消不保证在途读取停止。此次会再次读取并消耗一份新预算，结果未知绝不等于未读取。仅生成只读预览，不写业务表、不外发。', 'The earlier read may have occurred or may still be in flight; cancellation does not guarantee it stopped. This reads again and consumes a new budget. An unknown outcome does not mean no read occurred. Preview only, without business writes or external sends.') }}</p>
          <label><input v-model="retryConfirmed" data-testid="automation-read-retry-confirm" type="checkbox">{{ bi('我已理解上述风险，明确同意按原项目/配置范围和本次期限、预算重新读取一次。', 'I understand the warning and explicitly approve one new read for the original project/configuration scope with these new limits and expiry.') }}</label>
          <button type="button" data-testid="automation-read-retry" :disabled="!retryConfirmed || !validRetryInputs" @click="retryRequest">{{ bi('批准新预算并登记一次子尝试', 'Approve new budget and register one child attempt') }}</button>
        </fieldset>
        <p v-else data-testid="automation-read-retry-ineligible">{{ bi('此上下文不满足手动请求或原日期自动请求的单次重试条件，不会创建授权或读取。', 'This context is not eligible for a manual retry or one retry of an original automatic date request. No authorization or read will be started.') }}</p>
      </div>
      <div v-if="currentRequest.result" data-testid="automation-read-result">
        <p>{{ previewStatusText(currentRequest.result.status) }} <code>{{ currentRequest.result.status }}</code></p>
        <p>{{ bi('新增 / 更新 / 跳过 / 失效 / 待确认：', 'Add / update / skip / inactive / confirm: ') }}{{ currentRequest.result.counts.add }} / {{ currentRequest.result.counts.update }} / {{ currentRequest.result.counts.skip }} / {{ currentRequest.result.counts.inactive }} / {{ currentRequest.result.counts.manual_confirm }}</p>
        <p>{{ bi('仅预览，不可应用（canApply: false）。', 'Preview only; cannot apply (canApply: false).') }}</p>
      </div>
    </div>

    <div v-if="loaded">
      <h4>{{ bi('我的授权与运行记录', 'My authorizations and runs') }}</h4>
      <button type="button" data-testid="automation-read-refresh-history" :disabled="busy || unresolved" @click="refreshHistory">{{ bi('刷新记录（不读取来源）', 'Refresh history (no source read)') }}</button>
      <p>{{ bi('每页最多 20 条；这里只显示包含当前项目的记录。空页可能仍有下一页。', 'At most 20 entries per page; only entries for the current project are displayed. An empty page may still have a next page.') }}</p>
      <ul>
        <li v-for="grant in visibleGrants" :key="grant.grantId" data-testid="automation-read-grant-row" :data-grant-id="grant.grantId">
          {{ purposeText(grant) }} · {{ grant.status }} · {{ grant.usedExecutions }}/{{ grant.maxExecutions }} · {{ grant.expiresAt }}
          <button type="button" data-testid="automation-read-open-grant" :data-grant-id="grant.grantId" :disabled="busy || unresolved" @click="selectGrant(grant.grantId)">{{ bi('查看此授权', 'View authorization') }}</button>
        </li>
      </ul>
      <button v-if="grantCursor" type="button" data-testid="automation-read-next-grants" :disabled="busy || unresolved" @click="nextGrants">{{ bi('下一页授权', 'Next authorizations page') }}</button>
      <ul>
        <li v-for="request in visibleRequests" :key="request.requestId" data-testid="automation-read-request-row" :data-request-id="request.requestId">
          {{ requestStatusText(request.status) }} · {{ request.createdAt }}
          <button type="button" data-testid="automation-read-open-request" :data-request-id="request.requestId" :disabled="busy || unresolved" @click="selectRequest(request.requestId)">{{ bi('查看此运行', 'View run') }}</button>
        </li>
      </ul>
      <button v-if="requestCursor" type="button" data-testid="automation-read-next-requests" :disabled="busy || unresolved" @click="nextRequests">{{ bi('下一页运行', 'Next runs page') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { randomUuid } from '../../../utils/uuid'
import { onAuthPrincipalChange, onAuthSessionSwitch, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../../utils/explicitSessionOrg'
import { useLocale } from '../../../composables/useLocale'
import {
  AutomationReadClientError, createAutomationReadClient, checkedAutomationReadRecordCondition, checkedAutomationReadScheduleDefinition,
  checkedAutomationReadRetryContext, checkedAutomationReadRetryInput, checkedAutomationReadRetryRef,
  type AutomationReadBudget, type AutomationReadGrant, type AutomationReadGrantInput,
  type AutomationReadOption, type AutomationReadPreview, type AutomationReadRequestDetail,
  type AutomationReadRequestRef, type AutomationReadRequestSummary, type AutomationReadSubmitInput,
  type AutomationReadRecordActivationInput, type AutomationReadRecordActivationRef, type AutomationReadRecordTriggerType,
  type AutomationReadRecordCondition,
  type AutomationReadScheduleActivationInput, type AutomationReadScheduleActivationRef, type AutomationReadScheduleDefinition,
  type AutomationReadRetryInput, type AutomationReadRetryContext, type AutomationReadRetryRef,
} from '../../../services/integration/automationRead'

const props = defineProps<{ projectNo: string; sheetId?: string | null; scopeKey?: string }>()
const { locale } = useLocale()
function bi(zh: string, en: string) { return locale.value === 'zh-CN' ? zh : en }
const budgetFields = [
  { key: 'maxRows', zh: '最大行数', en: 'Maximum rows' },
  { key: 'maxPages', zh: '最大页数', en: 'Maximum pages' },
  { key: 'maxReadCount', zh: '最大读取次数', en: 'Maximum reads' },
  { key: 'timeoutMs', zh: '超时毫秒', en: 'Timeout milliseconds' },
] as const
const budgetValues = reactive<Record<keyof AutomationReadBudget, string | number>>({ maxRows: '', maxPages: '', maxReadCount: '', timeoutMs: '' })
const ttlMinutes = ref<string | number>('15')
const maxExecutions = ref<string | number>('1')
const grantConfirmed = ref(false)
const recordConfirmed = ref(false)
const scheduleConfirmed = ref(false)
type ActivationFamily = 'record' | 'schedule'
type ActivationCommand = Readonly<{ family: 'record'; recordTriggerType: AutomationReadRecordTriggerType; input: AutomationReadRecordActivationInput }>
  | Readonly<{ family: 'schedule'; recordTriggerType: null; scheduleDefinition: AutomationReadScheduleDefinition; input: AutomationReadScheduleActivationInput }>
type ActivationReceipt = (AutomationReadRecordActivationRef | AutomationReadScheduleActivationRef) & { family: ActivationFamily; recordTriggerType: AutomationReadRecordTriggerType | null; recordCondition: AutomationReadRecordCondition | null; scheduleDefinition: AutomationReadScheduleDefinition | null; scheduleRuleRevision: string | null }
const authorizationMode = ref<'manual' | ActivationFamily>('manual')
const activationConsentSpent = ref(false)
const busy = ref(false)
const loaded = ref(false)
const historyOnly = ref(false)
const error = ref('')
const notice = ref('')
const selectedRuleId = ref('')
const options = ref<AutomationReadOption[]>([])
const grants = ref<AutomationReadGrant[]>([])
const requests = ref<AutomationReadRequestSummary[]>([])
const optionCursor = ref<string | null>(null)
const grantCursor = ref<string | null>(null)
const requestCursor = ref<string | null>(null)
const currentGrant = ref<AutomationReadGrant | null>(null)
const currentRequest = ref<AutomationReadRequestDetail | null>(null)
// This is an in-memory command identity, never persisted or regenerated on recovery.
const recovery = ref<AutomationReadSubmitInput | null>(null)
// A lost activation receipt must not mint another budget. Keep the exact frozen
// command, including its original expiry, only in this session/context's memory.
const activationRecovery = shallowRef<ActivationCommand | null>(null)
const activationReceipt = ref<ActivationReceipt | null>(null)
type RetryCommand = Readonly<{ parentRequestId: string; input: AutomationReadRetryInput }>
const retryRecovery = shallowRef<RetryCommand | null>(null)
const retryReceipt = ref<AutomationReadRetryRef | null>(null)
const retryContext = shallowRef<AutomationReadRetryContext | null>(null)
const retryConfirmed = ref(false)
const retryTtlMinutes = ref<string | number>('15')
const retryBudgetValues = reactive<Record<keyof AutomationReadBudget, string | number>>({ maxRows: '', maxPages: '', maxReadCount: '', timeoutMs: '' })
const unresolved = computed(() => recovery.value !== null || activationRecovery.value !== null || retryRecovery.value !== null)
let client: ReturnType<typeof createAutomationReadClient> | null = null
let epoch = 0
let disposed = false
let sessionSignature = readAuthSessionSignature()
const signedIn = ref(sessionSignature !== 'invalid' && readStoredToken() !== null)
const usableProject = computed(() => canonicalId(props.projectNo))
const usableContext = computed(() => usableProject.value && canonicalId(props.sheetId))
const selectedOption = computed(() => options.value.find(option => option.selector.ruleId === selectedRuleId.value) ?? null)
const selectedRecordTriggerType = computed(() => eligibleRecordTriggerType(selectedOption.value))
const selectedRecordCondition = computed(() => optionRecordCondition(selectedOption.value))
const selectedScheduleDefinition = computed(() => optionScheduleDefinition(selectedOption.value))
const visibleGrants = computed(() => grants.value.filter(grant => grant.projects.includes(props.projectNo)))
const visibleRequests = computed(() => requests.value.filter(request => request.projectNo === props.projectNo))
function positive(value: string | number, cap: number): number | null {
  if (!/^[0-9]+$/.test(String(value))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 && number <= cap ? number : null
}
function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value === value.trim()
    // eslint-disable-next-line no-control-regex -- Match the closed server identity contract without normalization.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function eligibleRecordTriggerType(option: AutomationReadOption | null): AutomationReadRecordTriggerType | null {
  if (option?.recordActivationEligible !== true || typeof option.recordRuleRevision !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(option.recordRuleRevision)
    || optionRecordCondition(option) === null) return null
  return option.recordTriggerType === 'record.created' || option.recordTriggerType === 'record.updated'
    ? option.recordTriggerType : null
}
function optionRecordCondition(option: AutomationReadOption | null): AutomationReadRecordCondition | null {
  if (option?.recordActivationEligible !== true) return null
  try {
    const value = option.recordCondition
    const checked = checkedAutomationReadRecordCondition(value)
    // The closed parser verifies own data descriptors before this Vue tracking
    // bridge. Never execute accessors merely to track nested metadata changes.
    for (const key of Object.keys(checked)) Reflect.get(value as object, key)
    return checked
  } catch { return null }
}
function conditionLabel(condition: AutomationReadRecordCondition | null): string {
  if (condition?.mode === 'unconditional') return bi('条件模式：无条件', 'Condition mode: unconditional')
  if (condition?.mode === 'saved_conditions') return bi('条件模式：当前保存条件；业务时区：', 'Condition mode: saved conditions; business timezone: ') + condition.businessTimeZone
  return bi('条件模式未确认，不能启用', 'Condition mode unconfirmed; activation unavailable')
}
function optionScheduleDefinition(option: AutomationReadOption | null): AutomationReadScheduleDefinition | null {
  if (option?.scheduleActivationEligible !== true || typeof option.scheduleRuleRevision !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(option.scheduleRuleRevision)) return null
  try {
    const value = option.scheduleDefinition
    const checked = checkedAutomationReadScheduleDefinition(value)
    // Register nested Vue dependencies only after closed own-data validation.
    for (const key of Object.keys(checked)) Reflect.get(value as object, key)
    if (checked.triggerType === 'schedule.cron' || checked.triggerType === 'schedule.date_field') {
      const config = Reflect.get(value as object, 'config') as object
      for (const key of Object.keys(checked.config)) Reflect.get(config, key)
    }
    if (checked.triggerType === 'schedule.date_field') {
      const config = Reflect.get(value as object, 'config') as object
      // Descriptor validation deliberately avoids ordinary property reads.
      // Track absent optional keys explicitly: otherwise adding and removing a
      // previously absent floor/cadence can escape synchronous consent reset.
      // `has` registers Vue dependencies without evaluating any property getter.
      for (const key of ['timeOfDay', 'timezone', 'effectiveAt', 'scanIntervalMs']) Reflect.has(config, key)
      const dateField = Reflect.get(value as object, 'dateField') as object
      for (const key of Object.keys(checked.dateField)) Reflect.get(dateField, key)
    }
    return checked
  } catch { return null }
}
function scheduleLabel(definition: AutomationReadScheduleDefinition | null): string {
  if (definition?.triggerType === 'schedule.date_field') {
    const { config, dateField } = definition
    const direction = config.direction === 'before' ? bi('提前', 'before') : bi('延后', 'after')
    return `schedule.date_field · ${dateField.fieldId} (${dateField.fieldType}) · ${direction} ${config.offsetDays} ${bi('天', 'days')} · ${config.timeOfDay ?? '09:00'} ${config.timezone ?? 'UTC'} · schema=${dateField.schemaRevision}`
      + (config.effectiveAt === undefined ? '' : ` · effectiveAt=${config.effectiveAt}`)
      + (config.scanIntervalMs === undefined ? '' : ` · scanIntervalMs=${config.scanIntervalMs} (${bi('旧参数，不改变每日调度', 'legacy parameter, does not change daily scheduling')})`)
  }
  if (definition?.triggerType === 'schedule.interval') return `schedule.interval · I=${definition.intervalMs} ms · A=${definition.anchorMs} ms (${new Date(definition.anchorMs).toISOString()})`
  if (definition?.triggerType === 'schedule.cron') {
    const key = Object.prototype.hasOwnProperty.call(definition.config, 'expression') ? 'expression' : 'cron'
    return `schedule.cron · ${key}=${definition.config[key]} · ${definition.config.timezone ?? 'UTC'}`
  }
  return bi('计划配置未获确认，不能启用', 'Schedule definition unconfirmed; activation unavailable')
}
function recordTriggerLabel(type: AutomationReadRecordTriggerType | null): string {
  if (type === 'record.created') return bi('记录新建（record.created）', 'Record created (record.created)')
  if (type === 'record.updated') return bi('已提交记录更新（record.updated）', 'Committed record update (record.updated)')
  return bi('未获服务端确认，不能启用', 'Not confirmed by the server; activation is unavailable')
}
function eligibleOption(option: AutomationReadOption): boolean {
  return authorizationMode.value === 'manual' ? option.allowedTriggers.includes('manual')
    : authorizationMode.value === 'record' ? eligibleRecordTriggerType(option) !== null && option.scheduleActivationEligible === false && option.scheduleRuleRevision === null && option.scheduleDefinition === null && option.allowedTriggers.includes('record')
      : authorizationMode.value === 'schedule' && optionScheduleDefinition(option) !== null && option.recordActivationEligible === false && option.recordTriggerType === null && option.recordRuleRevision === null && option.recordCondition === null && option.allowedTriggers.includes('schedule')
}
const validInputs = computed(() => !!selectedOption.value && eligibleOption(selectedOption.value)
  && positive(ttlMinutes.value, 1440) !== null && positive(maxExecutions.value, 100) !== null
  && budgetFields.every(({ key }) => positive(budgetValues[key], selectedOption.value!.budget[key]) !== null))
const validGrantInputs = computed(() => authorizationMode.value === 'manual' && validInputs.value)
const validRecordInputs = computed(() => authorizationMode.value === 'record' && validInputs.value)
const validScheduleInputs = computed(() => authorizationMode.value === 'schedule' && validInputs.value)
function matchingOption(grant: AutomationReadGrant) {
  if (grant.purpose !== 'standalone') return null
  return options.value.find(option => option.allowedTriggers.includes('manual')
    && (['ruleId', 'actionId', 'systemId', 'targetId'] as const).every(key => option.selector[key] === grant.selector[key])) ?? null
}
const currentGrantOption = computed(() => currentGrant.value ? matchingOption(currentGrant.value) : null)
const grantUsable = computed(() => !!currentGrant.value && currentGrant.value.status === 'active'
  && currentGrant.value.purpose === 'standalone' && authorizationMode.value === 'manual'
  && currentGrant.value.projects.includes(props.projectNo) && currentGrant.value.triggers.includes('manual')
  && currentGrant.value.usedExecutions < currentGrant.value.maxExecutions
  && currentGrant.value.selector.ruleId === selectedRuleId.value && currentGrantOption.value !== null
  && Date.parse(currentGrant.value.expiresAt) > Date.now())

function retryTerminal(status: AutomationReadRequestRef['status']): boolean {
  return ['blocked', 'failed', 'cancelled', 'outcome_unknown'].includes(status)
}
const retryParentEligible = computed(() => {
  const context = retryContext.value
  if (!context || !currentRequest.value || context.request.requestId !== currentRequest.value.requestId
    || context.request.projectNo !== props.projectNo || !retryTerminal(context.request.status)) return false
  if (context.request.trigger === 'manual') return (context.grant.purpose === 'standalone' || context.grant.purpose === 'retry')
    && context.grant.triggers.includes('manual') && !context.dateScheduleOrigin
  return context.request.trigger === 'schedule' && context.grant.purpose === 'automatic'
    && context.grant.triggers.length === 1 && context.grant.triggers[0] === 'schedule'
    && context.dateScheduleOrigin?.definition.triggerType === 'schedule.date_field'
})
const validRetryInputs = computed(() => retryParentEligible.value && usableContext.value
  && retryContext.value?.nextAttempt === null && positive(retryTtlMinutes.value, 1440) !== null
  && budgetFields.every(({ key }) => positive(retryBudgetValues[key], 2147483647) !== null))
function clearRetryContext() {
  retryContext.value = null; retryConfirmed.value = false; retryTtlMinutes.value = '15'
  for (const { key } of budgetFields) retryBudgetValues[key] = ''
}
watch(currentRequest, clearRetryContext, { flush: 'sync' })
watch([retryTtlMinutes, () => ({ ...retryBudgetValues })], () => { retryConfirmed.value = false }, { deep: true, flush: 'sync' })

function clearConfirmation() { grantConfirmed.value = false; recordConfirmed.value = false; scheduleConfirmed.value = false }
watch(authorizationMode, () => { clearConfirmation(); selectedRuleId.value = '' }, { flush: 'sync' })
watch(selectedRecordTriggerType, clearConfirmation, { flush: 'sync' })
watch(() => selectedOption.value?.recordRuleRevision, clearConfirmation, { flush: 'sync' })
watch(() => JSON.stringify(selectedRecordCondition.value), clearConfirmation, { flush: 'sync' })
watch(() => selectedOption.value?.scheduleRuleRevision, clearConfirmation, { flush: 'sync' })
watch(() => JSON.stringify(selectedScheduleDefinition.value), clearConfirmation, { flush: 'sync' })
watch(selectedRuleId, () => {
  clearConfirmation()
  for (const { key } of budgetFields) budgetValues[key] = selectedOption.value?.budget[key] ?? ''
}, { flush: 'sync' })
watch([ttlMinutes, maxExecutions, () => ({ ...budgetValues })], clearConfirmation, { deep: true, flush: 'sync' })

function reset() {
  epoch += 1
  client?.dispose()
  client = null
  busy.value = false
  loaded.value = false
  historyOnly.value = false
  options.value = []; grants.value = []; requests.value = []
  optionCursor.value = null; grantCursor.value = null; requestCursor.value = null
  selectedRuleId.value = ''
  currentGrant.value = null; currentRequest.value = null; recovery.value = null
  activationRecovery.value = null; activationReceipt.value = null; activationConsentSpent.value = false
  retryRecovery.value = null; retryReceipt.value = null; clearRetryContext()
  authorizationMode.value = 'manual'; clearConfirmation()
  ttlMinutes.value = '15'; maxExecutions.value = '1'
  for (const { key } of budgetFields) budgetValues[key] = ''
  error.value = ''; notice.value = ''
  sessionSignature = readAuthSessionSignature()
  signedIn.value = sessionSignature !== 'invalid' && readStoredToken() !== null
}
function checkSession() {
  if (sessionSignature === readAuthSessionSignature()) return false
  reset()
  return true
}
function onStorage(event: StorageEvent) {
  // A relevant event is itself an epoch change: A→B→A may already have returned
  // to the same storage value by delivery time. Unrelated preferences are not.
  if (event.key == null || event.key === EXPLICIT_SESSION_ORG_KEY || TOKEN_KEYS.some(key => key === event.key)) reset()
  else checkSession()
}
// Invalidate the epoch immediately, including A→B→A in one task; after storage
// changes the coalesced session notification updates sign-in visibility as well.
const offPrincipal = onAuthPrincipalChange(reset)
const offSession = onAuthSessionSwitch(reset)
watch(() => [props.projectNo, props.sheetId, props.scopeKey], reset, { flush: 'sync' })
if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', checkSession)
}
onBeforeUnmount(() => {
  disposed = true
  offPrincipal(); offSession()
  if (typeof window !== 'undefined') {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', checkSession)
  }
  reset()
})
type Operation = { epoch: number; signature: string; client: ReturnType<typeof createAutomationReadClient> }
function current(operation: Operation): boolean {
  checkSession()
  return !disposed && operation.epoch === epoch && operation.signature === sessionSignature
}
function fail(reason: unknown, pendingSubmit?: AutomationReadSubmitInput, pendingActivation?: ActivationCommand, pendingRetry?: RetryCommand) {
  const code = reason instanceof AutomationReadClientError ? reason.code : 'AUTOMATION_READ_UNAVAILABLE'
  const status = reason instanceof AutomationReadClientError ? reason.status : 503
  const uncertain = !!pendingSubmit && status >= 500
  const priorConsentSpent = activationConsentSpent.value
  const retryUnconfirmed = !!pendingRetry && (status >= 500 || retryRecovery.value === pendingRetry)
  reset()
  if (code === 'AUTOMATION_READ_SESSION_CHANGED') return
  activationConsentSpent.value = priorConsentSpent
  // Never echo server text, raw errors, headers, URLs, or source material.
  if (status === 401 || status === 403) error.value = bi('无法访问：请确认当前登录账号、连接 owner 与集成管理员权限，再重新加载。', 'Access refused. Check the signed-in account, current connection ownership, and integration administrator permission, then reload.')
  else if (status === 409) error.value = bi('授权范围、版本、次数或请求状态已变化，请重新查看授权和运行记录。未自动重试。', 'Authorization scope, version, allowance, or request state changed. Reload authorizations and runs. No automatic retry.')
  else if (status === 400) error.value = bi('输入无效，请重新加载并检查有限授权参数。', 'Invalid input. Reload and check the bounded authorization parameters.')
  else error.value = bi('受控读取暂不可用或响应无法确认。未自动重试；请核对运行记录。', 'Controlled reading is unavailable or its response is unconfirmed. No automatic retry; check run history.')
  if (uncertain && pendingSubmit) recovery.value = { ...pendingSubmit }
  // Even a detail 403/409 can follow a committed activation POST. Do not infer
  // rollback from a later failure or reconstruct the body using edited inputs.
  if (pendingActivation) { activationRecovery.value = pendingActivation; activationConsentSpent.value = true }
  if (retryUnconfirmed && pendingRetry && status !== 401 && status !== 403) retryRecovery.value = pendingRetry
}
async function run(work: (operation: Operation) => Promise<void>, pendingSubmit?: AutomationReadSubmitInput, mode: 'runtime' | 'management' = 'runtime', pendingActivation?: ActivationCommand, pendingRetry?: RetryCommand) {
  // A click prepared from the outgoing account's DOM must not issue a command
  // in the incoming account, even if it bypassed the normal switch notification.
  if (checkSession()) return
  if (disposed || busy.value || !signedIn.value || !usableProject.value || (mode === 'runtime' && !usableContext.value)) return
  if (activationRecovery.value && activationRecovery.value !== pendingActivation) return
  if (recovery.value && !pendingSubmit) return
  if (retryRecovery.value && retryRecovery.value !== pendingRetry) return
  let operation: Operation | undefined
  try {
    client ??= createAutomationReadClient()
    operation = { epoch, signature: sessionSignature, client }
    busy.value = true; error.value = ''; notice.value = ''
    await work(operation)
  } catch (reason) {
    if (!operation || current(operation)) fail(reason, pendingSubmit, pendingActivation, pendingRetry)
  } finally {
    if (operation && current(operation)) busy.value = false
  }
}
async function readHistory(operation: Operation) {
  // Both management lists may lock the same grant NOWAIT. One owner page must
  // not race its own reads; serialization is not a retry of a refused read.
  const grantPage = await operation.client.listGrants({ limit: 20 })
  if (!current(operation)) return null
  const requestPage = await operation.client.listRequests({ limit: 20 })
  if (!current(operation)) return null
  return { grantPage, requestPage }
}
async function load() {
  if (unresolved.value) return
  await run(async operation => {
    const page = await operation.client.options({ sheetId: props.sheetId!, limit: 20 })
    if (!current(operation)) return
    const history = await readHistory(operation)
    if (!history || !current(operation)) return
    const { grantPage, requestPage } = history
    options.value = page.items; optionCursor.value = page.nextCursor
    grants.value = grantPage.items; grantCursor.value = grantPage.nextCursor
    requests.value = requestPage.items; requestCursor.value = requestPage.nextCursor
    selectedRuleId.value = ''; currentGrant.value = null; currentRequest.value = null
    historyOnly.value = false
    loaded.value = true
  })
}
async function loadHistoryOnly() {
  if (unresolved.value) return
  await run(async operation => {
    const history = await readHistory(operation)
    if (!history || !current(operation)) return
    const { grantPage, requestPage } = history
    options.value = []; optionCursor.value = null; selectedRuleId.value = ''
    currentGrant.value = null; currentRequest.value = null
    grants.value = grantPage.items; grantCursor.value = grantPage.nextCursor
    requests.value = requestPage.items; requestCursor.value = requestPage.nextCursor
    historyOnly.value = true; loaded.value = true
  }, undefined, 'management')
}
async function nextOptions() {
  if (!optionCursor.value || unresolved.value) return
  const after = optionCursor.value
  await run(async operation => {
    const page = await operation.client.options({ sheetId: props.sheetId!, limit: 20, after })
    if (!current(operation)) return
    options.value = page.items; optionCursor.value = page.nextCursor; selectedRuleId.value = ''
  })
}
async function createGrant() {
  if (!grantConfirmed.value || !validGrantInputs.value || !selectedOption.value || unresolved.value) return
  const input: AutomationReadGrantInput = {
    selector: { ...selectedOption.value.selector }, projects: [props.projectNo], triggers: ['manual'],
    expiresAt: new Date(Date.now() + Number(ttlMinutes.value) * 60_000).toISOString(),
    maxExecutions: Number(maxExecutions.value),
    budget: Object.fromEntries(budgetFields.map(({ key }) => [key, Number(budgetValues[key])])) as AutomationReadBudget,
  }
  await run(async operation => {
    grantConfirmed.value = false
    const created = await operation.client.createGrant(input)
    if (!current(operation)) return
    const detail = await operation.client.grantDetail(created.grantId)
    if (!current(operation)) return
    currentGrant.value = detail; currentRequest.value = null
    notice.value = bi('授权已创建；尚未启动任何来源读取。', 'Authorization created; no source read started.')
  })
}
function sameSelector(left: AutomationReadGrant['selector'], right: AutomationReadGrant['selector']): boolean {
  return (['ruleId', 'actionId', 'systemId', 'targetId'] as const).every(key => left[key] === right[key])
}
function validActivationDetail(detail: AutomationReadGrant, receipt: AutomationReadRecordActivationRef | AutomationReadScheduleActivationRef, command: ActivationCommand): boolean {
  // The transport validates closed response shapes. Match the returned grant to
  // this particular consent as well, before presenting it as reconciled.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const { family, input } = command
  return uuid.test(receipt.activationId) && uuid.test(receipt.grantId) && detail.grantId === receipt.grantId
    && detail.purpose === 'automatic' && (detail.status === 'active' || detail.status === 'revoked')
    && detail.projects.length === 1 && detail.projects[0] === input.projectNo
    && detail.triggers.length === 1 && detail.triggers[0] === family
    && sameSelector(detail.selector, input.selector) && detail.expiresAt === input.expiresAt
    && detail.maxExecutions === input.maxExecutions
    && budgetFields.every(({ key }) => detail.budget[key] === input.budget[key])
}
async function activateInput(command: ActivationCommand) {
  await run(async operation => {
    activationRecovery.value = command
    activationConsentSpent.value = true
    clearConfirmation()
    // Recover using the frozen family, never the visible/current mode (which
    // resets after failures). The family is local state, not an HTTP body claim.
    const receipt = command.family === 'schedule'
      ? await operation.client.activateSchedule(command.input)
      : await operation.client.activateRecord(command.input)
    if (!current(operation)) return
    const detail = await operation.client.grantDetail(receipt.grantId)
    if (!current(operation)) return
    if (!validActivationDetail(detail, receipt, command)) throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID')
    currentGrant.value = detail; currentRequest.value = null
    activationReceipt.value = { ...receipt, family: command.family, recordTriggerType: command.recordTriggerType,
      recordCondition: command.family === 'record' ? command.input.expectedRecordCondition : null,
      scheduleDefinition: command.family === 'schedule' ? command.scheduleDefinition : null,
      scheduleRuleRevision: command.family === 'schedule' ? command.input.expectedRuleRevision : null }; activationRecovery.value = null
    if (!loaded.value) { historyOnly.value = true; loaded.value = true }
    notice.value = command.family === 'schedule'
      ? command.scheduleDefinition.triggerType === 'schedule.date_field'
        ? bi('日期授权回执已核对；每条合格记录的到期时点分别消耗固定项目预算，服务器仍逐次核验。只处理授权后时点，扫描有界；未启动手动读取。', 'Date activation receipt reconciled. Each eligible record occurrence consumes the fixed-project allowance separately and is checked by the server. Only post-activation occurrences qualify, scanning is bounded, and no manual read started.')
        : bi('定时授权回执已核对；后续合格计划时点可能触发只读预览，仍受授权状态、期限、次数及服务器逐次核验约束。不补跑、未启动手动读取。', 'Schedule activation receipt reconciled. Later eligible planned occurrences may trigger read-only previews, subject to status, expiry, allowance, and server checks each time. No catch-up or manual read started.')
      : bi('自动授权回执已核对；后续合格事件可能触发只读预览，仍受授权状态、期限、次数及服务器逐次核验约束。未启动手动读取。', 'Record activation receipt reconciled. Later eligible events may trigger read-only previews, subject to status, expiry, allowance, and server checks each time. No manual read started.')
  }, undefined, 'runtime', command)
}
async function activateRecord() {
  if (!recordConfirmed.value || !validRecordInputs.value) return
  await activateFamily('record')
}
async function activateSchedule() {
  if (!scheduleConfirmed.value || !validScheduleInputs.value) return
  await activateFamily('schedule')
}
async function activateFamily(family: ActivationFamily) {
  if (!selectedOption.value || unresolved.value || activationConsentSpent.value || busy.value) return
  const recordTriggerType = family === 'record' ? selectedRecordTriggerType.value : null
  if (family === 'record' && recordTriggerType === null) return
  let activationKey: string
  try { activationKey = randomUuid() } catch { fail(undefined); return }
  const input: Omit<AutomationReadScheduleActivationInput, 'expectedRuleRevision' | 'expectedDateField'> = Object.freeze({
    activationKey, selector: Object.freeze({ ...selectedOption.value.selector }), projectNo: props.projectNo,
    budget: Object.freeze(Object.fromEntries(budgetFields.map(({ key }) => [key, Number(budgetValues[key])])) as AutomationReadBudget),
    expiresAt: new Date(Date.now() + Number(ttlMinutes.value) * 60_000).toISOString(),
    maxExecutions: Number(maxExecutions.value),
  })
  // Display-only consent metadata stays in memory beside the frozen body. The
  // server independently binds the saved rule; no event type is self-reported.
  if (family === 'record') {
    const expectedRuleRevision = selectedOption.value.recordRuleRevision
    const expectedRecordCondition = selectedRecordCondition.value
    if (recordTriggerType === null || typeof expectedRuleRevision !== 'string' || expectedRecordCondition === null) return
    await activateInput(Object.freeze({ family, recordTriggerType,
      input: Object.freeze({ ...input, expectedRuleRevision, expectedRecordCondition }) }))
  } else {
    const expectedRuleRevision = selectedOption.value.scheduleRuleRevision, scheduleDefinition = selectedScheduleDefinition.value
    if (typeof expectedRuleRevision !== 'string' || scheduleDefinition === null) return
    await activateInput(Object.freeze({ family, recordTriggerType: null, scheduleDefinition,
      input: Object.freeze({ ...input, expectedRuleRevision,
        ...(scheduleDefinition.triggerType === 'schedule.date_field' ? { expectedDateField: scheduleDefinition.dateField } : {}) }) }))
  }
}
async function recoverActivation() {
  if (activationRecovery.value) await activateInput(activationRecovery.value)
}
function newActivationConsent() {
  if (checkSession() || busy.value || unresolved.value || !activationConsentSpent.value) return
  activationConsentSpent.value = false; activationReceipt.value = null
  clearConfirmation()
  notice.value = bi('另一份授权会新增独立预算。请重新核对范围与参数，并明确勾选确认；旧授权不会自动撤销。', 'Another authorization adds an independent budget. Recheck scope and limits and explicitly confirm again. The earlier authorization is not automatically revoked.')
}
function requestDetail(reference: AutomationReadRequestRef): AutomationReadRequestDetail {
  return { ...reference, result: null }
}
async function submitInput(input: AutomationReadSubmitInput) {
  await run(async operation => {
    const reference = await operation.client.submit(input)
    if (!current(operation)) return
    currentRequest.value = requestDetail(reference)
    recovery.value = null
    notice.value = bi('请求已登记，请手动刷新状态；这里不会轮询或重复提交。', 'Request registered. Refresh status manually; this panel does not poll or repeat submissions.')
  }, input)
}
async function submit() {
  if (!grantUsable.value || !currentGrant.value || currentRequest.value || unresolved.value) return
  if (Date.parse(currentGrant.value.expiresAt) <= Date.now()) {
    notice.value = bi('授权已过期，请重新创建有限授权。', 'Authorization expired; create a new bounded authorization.')
    return
  }
  let invocationId: string
  try { invocationId = randomUuid() } catch { fail(undefined); return }
  await submitInput({ grantId: currentGrant.value.grantId, invocationId, projectNo: props.projectNo })
}
async function recover() {
  if (recovery.value) await submitInput({ ...recovery.value })
}
async function loadRetryContext() {
  if (!currentRequest.value || unresolved.value) return
  const parentRequestId = currentRequest.value.requestId
  await run(async operation => {
    clearRetryContext()
    const supplied = await operation.client.retryContext(parentRequestId)
    if (!current(operation) || currentRequest.value?.requestId !== parentRequestId) return
    let context: AutomationReadRetryContext
    try { context = checkedAutomationReadRetryContext(supplied, parentRequestId) }
    catch { throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID') }
    if (context.request.projectNo !== props.projectNo) throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID')
    currentRequest.value = { requestId: parentRequestId, status: context.request.status, result: null }
    retryContext.value = context
    for (const { key } of budgetFields) retryBudgetValues[key] = context.grant.budget[key]
  }, undefined, 'management')
}
async function retryInput(command: RetryCommand) {
  await run(async operation => {
    retryConfirmed.value = false
    const supplied = await operation.client.retry(command.parentRequestId, command.input)
    if (!current(operation)) return
    let receipt: AutomationReadRetryRef
    try { receipt = checkedAutomationReadRetryRef(supplied, command.parentRequestId) }
    catch { throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID') }
    retryReceipt.value = receipt; retryRecovery.value = null
    currentRequest.value = { requestId: receipt.requestId, status: receipt.status, result: null }
    notice.value = bi('一次新预算子尝试已登记，请手动刷新结果；不会重新提交原请求或自动创建下一份预算。', 'One new-budget child attempt registered. Refresh results manually; the parent is not resubmitted and no further budget is created automatically.')
  }, undefined, 'runtime', undefined, command)
}
async function retryRequest() {
  if (checkSession() || busy.value || unresolved.value || !retryConfirmed.value || !validRetryInputs.value || !retryContext.value) return
  let command: RetryCommand
  try {
    command = Object.freeze({ parentRequestId: retryContext.value.request.requestId,
      input: checkedAutomationReadRetryInput({ retryKey: randomUuid(), acknowledgeNewRead: true,
        budget: Object.fromEntries(budgetFields.map(({ key }) => [key, Number(retryBudgetValues[key])])),
        expiresAt: new Date(Date.now() + Number(retryTtlMinutes.value) * 60_000).toISOString() }) })
  } catch { fail(undefined); return }
  await retryInput(command)
}
async function recoverRetry() {
  if (retryRecovery.value) await retryInput(retryRecovery.value)
}
async function refreshRequest() {
  if (!currentRequest.value) return
  await selectRequest(currentRequest.value.requestId)
}
async function selectRequest(id: string) {
  if (unresolved.value) return
  await run(async operation => {
    const detail = await operation.client.observe(id)
    if (current(operation)) currentRequest.value = detail
  }, undefined, 'management')
}
async function selectGrant(id: string) {
  if (unresolved.value) return
  await run(async operation => {
    const detail = await operation.client.grantDetail(id)
    if (!current(operation)) return
    currentGrant.value = detail; currentRequest.value = null
    selectedRuleId.value = matchingOption(detail)?.selector.ruleId ?? ''
  }, undefined, 'management')
}
async function revoke() {
  if (!currentGrant.value || unresolved.value) return
  const id = currentGrant.value.grantId
  await run(async operation => {
    await operation.client.revoke(id)
    if (!current(operation)) return
    if (currentGrant.value?.grantId === id) currentGrant.value = { ...currentGrant.value, status: 'revoked' }
    grants.value = grants.value.map(grant => grant.grantId === id ? { ...grant, status: 'revoked' } : grant)
    notice.value = bi('授权已撤销；这不证明已发出的读取立即停止，请核对最终运行状态。', 'Authorization revoked; this does not prove an in-flight read immediately stopped. Check final run status.')
  }, undefined, 'management')
}
async function cancel() {
  if (!currentRequest.value || unresolved.value) return
  const id = currentRequest.value.requestId
  await run(async operation => {
    const reference = await operation.client.cancel(id)
    if (!current(operation)) return
    currentRequest.value = requestDetail(reference)
    notice.value = bi('取消请求已处理，但不能据此确认已发出的读取停止；请继续手动核对最终状态。', 'Cancellation request handled, but this cannot confirm an in-flight read stopped. Manually check final status.')
  }, undefined, 'management')
}
async function refreshHistory() {
  if (unresolved.value) return
  await run(async operation => {
    const history = await readHistory(operation)
    if (!history || !current(operation)) return
    const { grantPage, requestPage } = history
    grants.value = grantPage.items; grantCursor.value = grantPage.nextCursor
    requests.value = requestPage.items; requestCursor.value = requestPage.nextCursor
  }, undefined, 'management')
}
async function nextGrants() {
  if (!grantCursor.value || unresolved.value) return
  const after = grantCursor.value
  await run(async operation => {
    const page = await operation.client.listGrants({ limit: 20, after })
    if (current(operation)) { grants.value = page.items; grantCursor.value = page.nextCursor }
  }, undefined, 'management')
}
async function nextRequests() {
  if (!requestCursor.value || unresolved.value) return
  const after = requestCursor.value
  await run(async operation => {
    const page = await operation.client.listRequests({ limit: 20, after })
    if (current(operation)) { requests.value = page.items; requestCursor.value = page.nextCursor }
  }, undefined, 'management')
}
function purposeText(grant: AutomationReadGrant): string {
  const { purpose } = grant
  if (purpose === 'retry') return bi('单次关联重试授权（不可另行手动启动）', 'Single linked-retry authorization (no separate manual start)')
  if (purpose === 'automatic' && grant.triggers.length === 1 && grant.triggers[0] === 'schedule') {
    return bi('定时自动授权（状态与期限仍须逐次核验）', 'Automatic schedule authorization (status and expiry rechecked each time)')
  }
  return purpose === 'automatic'
    ? bi('记录自动授权（状态与期限仍须逐次核验）', 'Automatic record authorization (status and expiry rechecked each time)')
    : purpose === 'standalone' ? bi('独立授权（不是自动触发授权）', 'Standalone authorization (not automatic activation)')
      : bi('未知授权用途，不能执行', 'Unknown authorization purpose; cannot execute')
}
function requestStatusText(status: AutomationReadRequestRef['status']): string {
  const labels = {
    queued: ['已排队，未完成', 'Queued, not complete'], running: ['正在运行', 'Running'],
    succeeded: ['只读预览完成', 'Read-only preview complete'], blocked: ['已阻止执行', 'Execution blocked'],
    failed: ['执行失败', 'Execution failed'], cancelled: ['已取消', 'Cancelled'],
    outcome_unknown: ['结果未知，不会自动重做', 'Outcome unknown; no automatic rerun'],
  } as const
  return bi(labels[status][0], labels[status][1])
}
function previewStatusText(status: AutomationReadPreview['status']): string {
  const labels = {
    not_found: ['没有找到项目 BOM', 'Project BOM not found'], large_bom_bounded: ['BOM 达到读取上限，并非完整预览', 'BOM read limit reached; preview is incomplete'],
    ready: ['差异预览已生成', 'Diff preview generated'], manual_confirm_required: ['差异需要人工确认', 'Diff requires manual confirmation'],
  } as const
  return bi(labels[status][0], labels[status][1])
}
</script>

<style scoped>
.automation-read { border: 1px solid #d8dee8; border-radius: 8px; padding: 16px; margin-top: 16px; }
.automation-read h3, .automation-read h4 { margin: 0 0 8px; }
.automation-read p { line-height: 1.55; }
.automation-read fieldset { margin: 12px 0; border: 1px solid #d8dee8; }
.automation-read label { display: block; margin: 8px 0; }
.automation-read button { margin: 4px 8px 4px 0; }
.automation-read input[type='number'] { width: 120px; }
.automation-read [role='alert'] { color: #a12222; }
.automation-read li { margin-bottom: 8px; }
</style>

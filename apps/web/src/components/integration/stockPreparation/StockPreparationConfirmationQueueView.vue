<template>
  <div class="stock-prep-confirm" data-testid="stock-prep-confirmation-queue">
    <!-- P1-2 (§6.2 P1-2): EMBEDDED MODE hides this scope paragraph — the closest thing this view has
         to a title — because the host composing it in place (StockPreparationProjectBoardView's Panel
         2) already carries its own heading for the same section. `v-if="!embedded"` means an
         undeclared prop (every non-embedded caller, unchanged) renders this exactly as before. -->
    <p v-if="!embedded" class="stock-prep-confirm__scope" data-testid="stock-prep-confirmation-scope">
      {{ bi(
        '这里列出系统拿不准、需要您拿主意的事。每一条说明是什么情况,您选一个处理办法,系统按您的决定继续。列表本身不显示具体内容,只有点开某一条时才会读出您填过的值。',
        'This is where the system lists what it cannot decide on its own. Each row says what the situation is; you pick how to handle it and the system carries on from there. The list itself shows no content — what you typed is read back only when you open a single row.',
      ) }}
    </p>

    <!-- CONTROL GATING (O2 / R-11). Every control below renders only when its capability is granted
         by `canStockPrepCapability`, which mirrors the server gate exactly. A control that would 403
         is never in the DOM — no disabled-but-present decoy, because a disabled control still tells
         the operator the capability exists here, and the matrix suite asserts on presence. -->
    <div class="stock-prep-confirm__bar">
      <!-- 项目号 with a NATIVE datalist. The list carries every project in the caller's own tenant,
           each option's VALUE being the number and its LABEL the name, so the browser's own
           type-ahead filters on either — which is the whole point: an operator who only remembers
           「注射水缓冲罐」 can now find 230920006 without being told it. The input stays a plain text
           field, so the hand-typed path a trained operator already uses is unchanged. -->
      <!-- P1-2: EMBEDDED MODE hides this input — the host already knows the project (it passed
           `:project-no`, and this view's own P0-1 watcher keeps `projectNo` in step with it), so a
           second, editable box for the SAME number would invite it to drift from the page around it.
           Non-embedded (every caller today) renders this exactly as before. -->
      <label v-if="!embedded" class="stock-prep-confirm__field">
        <span>{{ bi('项目号(可按号码或名称搜)', 'Project no. (search by number or name)') }}</span>
        <input
          v-model="projectNo"
          type="text"
          list="stock-prep-project-directory-options"
          data-testid="stock-prep-confirmation-project-input"
          :placeholder="bi('项目号或名称', 'Project number or name')"
        >
        <datalist id="stock-prep-project-directory-options" data-testid="stock-prep-operator-project-datalist">
          <option
            v-for="project in directoryProjects"
            :key="project.projectId ?? project.projectNo ?? ''"
            :value="project.projectNo ?? ''"
          >{{ project.projectName ?? '' }}</option>
        </datalist>
      </label>

      <!-- P1-2: EMBEDDED MODE hides the status filter, and this one is a HONESTY fix, not a tidiness
           one (G4「不得假绿」). The server's `byStatus` is counted over the rows this request actually
           returned (stock-preparation-confirmation-decisions.cjs's `listConfirmationDecisions`:
           `queryAll(scoped, filters)` THEN the tally), so a filtered LIST answers with a filtered
           tally. The host's 进度条 reads exactly that field: leaving this control next to the bar
           would let 「只看这种进展 = 已确认」 render a full green 「已处理 N / 共 N」 with every pending
           row still open. Hidden here, `statusFilter` can only ever be '' in embedded mode, which is
           the one case where `byStatus` is the whole project. The confirmation-queue TAB — where no
           progress bar exists to mislead — keeps the filter exactly as it was. -->
      <label v-if="!embedded" class="stock-prep-confirm__field">
        <span>{{ bi('只看这种进展', 'Show only') }}</span>
        <select v-model="statusFilter" data-testid="stock-prep-confirmation-status-filter">
          <option value="">{{ bi('全部', 'All') }}</option>
          <option v-for="status in STOCK_PREPARATION_DECISION_STATUSES" :key="status" :value="status">
            {{ decisionStatusLabel(status) }}
          </option>
        </select>
      </label>

      <button
        v-if="can('confirmationQueue.list')"
        type="button"
        data-testid="stock-prep-confirmation-queue-refresh"
        :disabled="busy"
        @click="loadQueue"
      >
        {{ bi('刷新列表', 'Refresh the list') }}
      </button>

      <!-- 一线看得见自己工厂的项目 — THE capability's control. It renders whenever the capability is
           granted, unconditionally on data: R-11's "what is permitted must be visible" is a statement
           about the PERMISSION, and a control that appeared only once the worklist happened to be
           non-empty would make the alignment assertion depend on fixtures. The worklist itself is
           data-conditional and sits below. -->
      <!-- KEPT IN EMBEDDED MODE, unlike the two surfaces it feeds. The datalist and the worklist are
           both hidden there, but the directory read has a THIRD consumer that stays: `emptyState`
           below is decided from `directoryAvailable` / `directoryReady` / `ledgerReady` /
           `projectKnown`, so without a directory 面板 2 cannot tell 「表还没建好」 from 「号码不认识」
           from 「真的清完了」 — it would fall back to the most conservative diagnosis and say the wrong
           one. This button is the retry for that read, and it does exactly what it says in both modes. -->
      <button
        v-if="can('confirmationQueue.projectDirectory')"
        type="button"
        data-testid="stock-prep-operator-project-directory"
        :disabled="directoryBusy"
        @click="loadDirectory"
      >
        {{ bi('刷新我的项目', 'Refresh my projects') }}
      </button>

      <button
        v-if="can('confirmationQueue.readiness')"
        type="button"
        data-testid="stock-prep-confirmation-readiness"
        :disabled="busy"
        @click="loadReadiness"
      >
        {{ bi('检查是否准备好', 'Check it is ready') }}
      </button>

      <!-- 按项目导出物料 Excel — 仓库/采购 take this after the approval chain completes. Gated one
           notch tighter than the queue (same code as "看我填过什么"), because the workbook carries
           material names and quantities, not just handles/enums. -->
      <!-- P1-2: EMBEDDED MODE hides this — G1「每屏一个主操作位」. The host renders 导出物料清单(Excel)
           in its OWN 面板 3 for the SAME project, with its own disabled rule; two identically-worded
           buttons a screen apart, each greyed out under different conditions, is the 「按钮堆」 this
           redesign exists to delete. The capability is unchanged and its control is still on the
           confirmation-queue tab, where nothing else offers it. -->
      <button
        v-if="!embedded && can('confirmationQueue.export')"
        type="button"
        data-testid="stock-prep-confirmation-export"
        :disabled="busy || !projectNo"
        :title="!projectNo ? bi('先填项目号', 'Enter a project number first') : ''"
        @click="exportMaterials"
      >
        {{ bi('导出物料清单(Excel)', 'Export materials (Excel)') }}
      </button>

      <!-- 通知下一步 — A TURN SIGNAL, NOT A GUARD.
           Several people fill their own fields on this project's rows in order; this button moves
           whose-turn-it-is on one notch and tells the group chat who is up next (the last step also
           tells 仓库/采购). It decides NOTHING about who may write which column — per-column write
           enforcement is a separate, deferred decision.
           The `isCurrentHandler` half of the condition is COURTESY, not enforcement: the server
           re-checks it on the advance and answers 403 NOT_CURRENT_HANDLER regardless of what this
           template rendered. Hiding the button simply keeps five people from all seeing a button
           that only one of them can use.
           This pair is why `handoff.read`/`handoff.advance` carry `control: null` in the manifest:
           they are additionally gated on RUNTIME state, so presence ≠ grant and the F-04 matrix
           cannot measure them. StockPreparationHandoff.spec.ts covers their visibility instead. -->
      <!-- J1: the SECOND condition is the resend. The owed-notice invitation above is only honest if
           the button it names is on screen, and in that state `isCurrentHandler` is false — the turn
           has already moved on; what is outstanding is the message for the hop this caller completed.
           The server decides both (it holds the monotonic claim column and the step rosters); the
           page only renders what it is told. `completed` is deliberately NOT a bar on this branch: a
           terminal hop whose claim was interrupted leaves the chain finished and the 仓库/采购 notice
           still owed, which is the single most important message this feature sends. -->
      <!-- P1-2: EMBEDDED MODE hides this for the same G1 reason as 导出 above, plus a sharper one —
           the host renders its OWN 通知下一步 fed by its OWN `readStockPreparationHandoff` call. Two
           independently-fetched copies of "whose turn is it" on one screen do not refresh each other,
           so advancing from one leaves the other showing the previous holder until something else
           reloads it. One turn signal per screen; the tab keeps its own. -->
      <button
        v-if="!embedded && can('handoff.advance') && handoff.configured
          && ((handoff.isCurrentHandler && !handoff.completed) || handoffResendableStepKey)"
        type="button"
        data-testid="stock-prep-handoff-advance"
        :disabled="busy || !projectNo"
        :title="!projectNo ? bi('先填项目号', 'Enter a project number first') : ''"
        @click="advanceHandoff"
      >
        {{ handoffResendableStepKey
          ? bi('通知下一步(补发上一步的群消息)', 'Notify the next person (resend the previous step\'s message)')
          : (handoff.terminal
            ? bi('通知仓库和采购', 'Notify warehouse & purchasing')
            : bi('通知下一步', 'Notify the next person')) }}
      </button>

      <!-- Platform-admin capabilities. Reconcile performs a SOURCE READ (and consumes a B2a
           operation claim when armed); ensure PROVISIONS the ledger table. Both stay owner-level, so
           an operator never sees either. -->
      <!-- P1-2: EMBEDDED MODE hides BOTH admin controls and the note under them — R-11「可见即可用」,
           applied to the one thing that breaks it hardest: a control whose click goes nowhere.
           These two are the only things this view EMITS to a caller (`admin-action`), and the caller
           that owns the calls is the SHELL. 项目备料页 composes this view directly; it has no
           `admin-action` of its own to re-emit and giving it one would mean editing
           StockPreparationWorkspace.vue, which this wave does not touch. Rendering them here would
           therefore put two buttons a platform admin can press and nothing would happen — worse than
           absent, and exactly what the seven lines above the 去装 button exist to prevent. They are
           unchanged and fully live on the confirmation-queue tab, which is where the shell listens.
           (Neither belongs in 「等您拿主意」 anyway: ensure PROVISIONS the ledger, and reconcile runs
           per FACTORY, not per project — see the note's own words.) -->
      <button
        v-if="!embedded && can('confirmationQueue.ensure')"
        type="button"
        data-testid="stock-prep-confirmation-ensure"
        :disabled="busy"
        @click="emit('admin-action', 'ensure', projectNo)"
      >
        {{ bi('创建确认账本(管理员)', 'Create the confirmation ledger (admin)') }}
      </button>

      <button
        v-if="!embedded && can('confirmationQueue.reconcile')"
        type="button"
        data-testid="stock-prep-confirmation-reconcile"
        :disabled="busy"
        @click="emit('admin-action', 'reconcile', projectNo)"
      >
        {{ bi('重新扫描待确认的事(管理员)', 'Re-scan for things to confirm (admin)') }}
      </button>
      <!-- I-13 (P0-7): today's ONLY reconcile note — it runs per FACTORY, not per project, and can
           supersede a colleague's already-queued row. New, never shown before. -->
      <small v-if="!embedded && can('confirmationQueue.reconcile')" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-reconcile-note">
        {{ bi(reconcileButtonNote.zh, reconcileButtonNote.en) }}
      </small>
    </div>

    <!-- TWO LINES (P0-5): 发生了什么 / 该做什么, plus a copy button carrying only the code and a
         fixed, values-free sentence — never the dynamic prose above it. -->
    <p v-if="errorCode" class="stock-prep-confirm__error" data-testid="stock-prep-confirmation-error">
      {{ bi(errorPlain(errorCode).zh, errorPlain(errorCode).en) }}
      <code class="stock-prep-confirm__token">{{ errorCode }}</code>
      <span v-if="errorPlain(errorCode).zhNext" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-error-next">
        {{ bi(errorPlain(errorCode).zhNext || '', errorPlain(errorCode).enNext || '') }}
      </span>
      <button type="button" data-testid="stock-prep-confirmation-error-copy" @click="copyError(errorCode)">
        {{ errorCopyLabel === 'copy' ? bi('复制这条报错', 'Copy this error') : bi('已复制', 'Copied') }}
      </button>
    </p>

    <!-- The download still happened — a valid, headers-only workbook — this is purely the notice. -->
    <p v-if="exportEmptyNotice" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-export-empty">
      {{ bi(
        '这个项目号下没有有效的物料行,已下载一份仅含表头的空白模板。',
        'This project number has no active material rows — an empty, headers-only template was downloaded.',
      ) }}
    </p>

    <!-- 一线看得见自己工厂的项目 — THE WORKLIST. Rendered on mount, before anything is typed, so the
         page opens on "here is your work" instead of on an empty box demanding a number the operator
         was supposed to have memorised. Only projects with pending work appear here; the full
         directory is still behind the input's datalist above, which is what lets the empty states
         below tell "unknown number" from "nothing pending". -->
    <!-- P1-2: EMBEDDED MODE hides the worklist, for the SAME reason the project-no input is hidden
         and with more force. `pickProject` writes this view's own `projectNo` ref — NOT the host's
         prop — so one click in here would point 面板 2 at a different project while the title, the
         status card, the sync panel, 导出 and 通知下一步 above it all stayed on the one the operator
         opened: a cross-project mis-operation, not a display glitch. The host's own page IS the way
         to change projects (its search box and 今天要处理 cards both funnel through `openProject`),
         and this list is unchanged on the confirmation-queue tab, where it is the whole point of the
         page. -->
    <section
      v-if="!embedded && can('confirmationQueue.projectDirectory') && worklist.length > 0"
      class="stock-prep-confirm__worklist"
      data-testid="stock-prep-operator-project-worklist"
    >
      <h3>{{ bi('您这边等着处理的项目', 'Projects waiting on you') }}</h3>
      <ul>
        <li v-for="project in worklist" :key="project.projectId ?? project.projectNo ?? ''">
          <button
            type="button"
            class="stock-prep-confirm__worklist-item"
            data-testid="stock-prep-operator-project-pick"
            :disabled="busy || !project.projectNo"
            @click="pickProject(project)"
          >
            <span class="stock-prep-confirm__worklist-no">{{ project.projectNo }}</span>
            <span class="stock-prep-confirm__worklist-name">{{ project.projectName }}</span>
            <span class="stock-prep-confirm__worklist-count">
              {{ bi('等您处理', 'waiting') }}: {{ project.pendingDecisionCount }}
            </span>
          </button>
        </li>
      </ul>
    </section>
    <!-- Whose turn it is. Renders for ANYONE who could read the status — the point of a turn signal
         is that the other four people can see it too, not only the one person holding the turn. A
         deployment with no chain configured renders nothing at all here. -->
    <!-- P1-2: EMBEDDED MODE hides the turn signal's status line and the resend invitation below it.
         The host's status card already says 轮到谁 for this project from its own read, and the button
         this invitation names is hidden in embedded (see 通知下一步 above) — an invitation to press a
         control that is not on screen is worse than silence. -->
    <p v-if="!embedded && handoff.configured" class="stock-prep-confirm__hint" data-testid="stock-prep-handoff-status">
      <template v-if="handoff.completed">
        {{ bi('这个项目的备料接力已经走完。', 'The handoff chain for this project has run to the end.') }}
      </template>
      <template v-else>
        {{ bi('当前在:', 'Currently with: ') }}{{ handoffStepLabel(handoff.currentStepKey) }}
        <code v-if="handoff.currentStepKey" class="stock-prep-confirm__token">{{ handoff.currentStepKey }}</code>
      </template>
    </p>

    <!-- STILL OWED, STILL SENDABLE. The first version of this banner fired on exactly this state and
         told the operator it could NOT be resent — copy that discourages the one click that fixes it.
         It is an invitation now, and it renders only for the handler who can actually act on it. -->
    <p
      v-if="!embedded && handoffResendableStepKey"
      class="stock-prep-confirm__hint"
      data-testid="stock-prep-handoff-notification-resendable"
    >
      {{ bi(
        '上一跳的群通知还没发出去,再点一次「通知下一步」就会补发。',
        'The group notice for the previous step has not gone out yet — press 通知下一步 again and it will be sent.',
      ) }}
      <code class="stock-prep-confirm__token">{{ handoffResendableStepKey }}</code>
    </p>

    <!-- GONE FOR GOOD. A later hop's claim moved the monotonic max past this one, so nothing the
         system can do will send it. Named from the append-only trail, because an interior gap has no
         other representation. -->
    <p
      v-if="handoffLostStepKeys.length > 0"
      class="stock-prep-confirm__hint"
      data-testid="stock-prep-handoff-notification-gap"
    >
      {{ bi(
        `「${handoffLostStepLabels}」这一步的群通知没发出去,系统已经不能补发了 —— 请您口头跟相关的人确认一下。`,
        `The group notice for "${handoffLostStepLabels}" never went out and can no longer be resent — please confirm with the people involved in person.`,
      ) }}
    </p>

    <!-- What just happened to the turn AND to the message — two separate facts, said as two facts.
         The enum stays on screen subordinate to the sentence, like every other token on this page. -->
    <p v-if="handoffNoticeText" class="stock-prep-confirm__hint" data-testid="stock-prep-handoff-notice">
      {{ handoffNoticeText }}
      <code v-if="handoffNoticeToken" class="stock-prep-confirm__token">{{ handoffNoticeToken }}</code>
    </p>

    <p v-if="readiness !== null" class="stock-prep-confirm__readiness" data-testid="stock-prep-confirmation-readiness-result">
      {{ readiness.ready === true
        ? bi('可以开始:记录确认结果的表已经建好了。', 'Ready to go: the table that records your decisions is in place.')
        : bi('还不能开始:记录确认结果的表还没建好,需要管理员先创建。', 'Not ready yet: the table that records your decisions has not been created — an admin has to create it first.') }}
    </p>

    <div v-if="queue" class="stock-prep-confirm__counts" data-testid="stock-prep-confirmation-counts">
      <span :title="bi(pendingConfirmTooltip.zh, pendingConfirmTooltip.en)">
        {{ bi('等您处理', 'Waiting for you') }}: {{ queue.rowCount }}
      </span>
      <span>{{ bi('先挂起的', 'Parked for later') }}: {{ queue.parkedCount }}</span>
    </div>

    <!-- 顶部一句话 (2026-09-10 field report): when every row still waiting on a human is a kind this
         page cannot decide, the per-row hints below are each individually true but the page as a
         whole never SAID that — an operator had to open every row to learn the same fact six times.
         values-free on purpose: names counts and points at the per-row 「什么情况」 column, never a
         cell's content. -->
    <p
      v-if="queue && allPendingRowsUnconfirmable"
      class="stock-prep-confirm__hint"
      data-testid="stock-prep-confirmation-all-unconfirmable-banner"
    >
      {{ bi(
        `这 ${pendingUnconfirmableCount} 条目前都不能在这里确认——它们的问题出在源数据(见每行「什么情况」)。请到源系统修正后重新同步,修正后这些行会自动关闭;确实需要人工处理请联系管理员。`,
        `None of these ${pendingUnconfirmableCount} rows can be confirmed here right now — the problem is in the source data (see "What happened" on each row). Fix it in the source system and sync again; these rows close on their own once fixed. Contact an administrator if one genuinely needs manual handling.`,
      ) }}
    </p>

    <table v-if="queue && queue.rows.length > 0" class="stock-prep-confirm__table" data-testid="stock-prep-confirmation-rows">
      <thead>
        <tr>
          <th>{{ bi('编号', 'Reference') }}</th>
          <th>{{ bi('什么情况', 'What happened') }}</th>
          <th>{{ bi('进展', 'Where it stands') }}</th>
          <th>{{ bi('已选的处理办法', 'How it was handled') }}</th>
          <th>{{ bi('填过值了吗', 'Value filled in') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queue.rows" :key="row.decisionId || ''" data-testid="stock-prep-confirmation-row">
          <td><code class="stock-prep-confirm__token">{{ row.decisionId }}</code></td>
          <td :title="row.conflictType || undefined" data-testid="stock-prep-confirmation-conflict-type">{{ conflictTypeLabel(row.conflictType) }}</td>
          <td>
            <span>{{ decisionStatusLabel(row.status) }}</span>
            <code v-if="row.status" class="stock-prep-confirm__token">{{ row.status }}</code>
          </td>
          <td>
            <span>{{ decisionActionLabel(row.resolutionAction) }}</span>
            <code v-if="row.resolutionAction" class="stock-prep-confirm__token">{{ row.resolutionAction }}</code>
          </td>
          <!-- PRESENCE only — the queue never carries the value itself. -->
          <td>{{ row.resolvedValuePresent ? bi('是', 'yes') : bi('否', 'no') }}</td>
          <td>
            <button
              v-if="can('confirmationQueue.valueEntry')"
              type="button"
              data-testid="stock-prep-confirmation-value-entry"
              :disabled="busy || !row.decisionId"
              @click="loadValueEntry(row.decisionId)"
            >
              {{ bi('看我填过什么', 'See what I entered') }}
            </button>
            <button
              v-if="can('confirmationQueue.confirm')"
              type="button"
              data-testid="stock-prep-confirmation-select"
              :disabled="busy || !row.decisionId || !isConfirmableConflictType(row.conflictType)"
              :title="rowUnconfirmableReason(row) || undefined"
              @click="selectRow(row)"
            >
              {{ bi('我来定…', 'I\'ll decide…') }}
            </button>
            <!-- SAY WHY, AND SAY WHAT WOULD WORK. A disabled button with no reason sends the
                 operator to support; this row's whole problem is that the answer is not in this
                 page at all. -->
            <p
              v-if="rowUnconfirmableReason(row)"
              class="stock-prep-confirm__row-hint"
              data-testid="stock-prep-confirmation-unconfirmable-hint"
            >
              {{ rowUnconfirmableReason(row) }}
            </p>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- EMPTY-STATE HONESTY. This used to be one sentence — 「都清了」 — shown for three unrelated
         situations: nothing was ever synced here, the number was mistyped, and the project really is
         clear. Only the last is good news. `stockPrepDirectoryEmptyState` decides which of the four
         it actually is from facts the server now returns, and each carries the next step (or says
         plainly that the next step is not the operator's to take). -->
    <p
      v-else-if="queue && emptyState"
      class="stock-prep-confirm__empty"
      data-testid="stock-prep-confirmation-empty"
      :data-empty-state="emptyState"
    >
      {{ bi(emptyStateText.zh, emptyStateText.en) }}
      <span v-if="emptyStateText.zhNext" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-empty-next">
        {{ bi(emptyStateText.zhNext, emptyStateText.enNext ?? '') }}
      </span>
      <!-- P0-7 / D2: the ONE dead-end this wave closes. A platform admin landing here on a fresh
           deployment previously had no button anywhere on this page saying "go install it" — this is
           that button, and it changes nothing else about this empty state (same text, same testid).

           GATED ON WHO CAN ACTUALLY ARRIVE (R-11「可见即可用」). `ledger_missing` is reachable by any
           caller who can read the directory — an operator on a half-installed deployment sees this
           empty state too — but 开始使用 is filtered out of `visibleViews` for anyone without
           `stock-prep:admin`, so for them `activeKey='getting-started'` silently falls back to their landing
           tab. A button that teleports an operator to the project board is a NEW dead end, not a
           closed one. Ungated, they keep the empty state's own zhNext:「得先请管理员建这张表」. -->
      <!-- P1-2: STAYS in embedded mode, and it works there — unlike the two `admin-action` buttons
           above, this one rides `navigate-stage`, which the host (项目备料页) already emits to the
           shell for its own reasons and now re-emits verbatim for this view. So the click still lands
           on 开始使用. It is gated on `canOpenInstallView`, so only a caller whose shell actually
           renders that tab ever sees it — in either mode. -->
      <!-- P1-1: THE DESTINATION IS 开始使用, and now it is named that. It always meant the wizard —
           设计稿 §2.3's minimal fix for A1 is 「把落在空队列上的管理员送到向导」 — and while the wizard
           was a passenger on the install page's first screen, `'install'` was how you got there. P1-1
           gave it its own rail item and made the install page render `mode="review"` (no wizard), so
           a button labelled 「去装:开始使用」 would have arrived on a page with no 开始使用 on it. The
           gate is unchanged: `getting-started` rides the same `canOpenStockPrepInstallView` the
           install tab does, so a caller whose shell does not render it still never sees this. -->
      <button
        v-if="emptyState === 'ledger_missing' && canOpenInstallView"
        type="button"
        data-testid="stock-prep-confirmation-empty-go-install"
        @click="emit('navigate-stage', 'getting-started')"
      >{{ bi(ledgerMissingActionLabel.zh, ledgerMissingActionLabel.en) }}</button>
      <!-- P0-9 (线框 D ④): "把『确认完要回来再同步一次』从词表句子变成控件" — the closed-loop button
           for the ONE step every day loses the most. Goes back to the project board FOR THE SAME
           PROJECT (§2.3's `?projectNo=` state bit), reusing the same event `admin-action`'s sibling
           already uses — no new route, no new controlled control.

           GATED THE SAME WAY ITS SIBLING IS, and for the same reason (R-11「可见即可用」). 设计稿
           §2.4 P-3 makes this page the `stock-prep:read` tier's ONLY entry point, and that tier does
           NOT get 项目备料 (`canOpenStockPrepProjectBoard` = operate ∧ read) — so a read-only queue
           watcher can genuinely reach `nothing_pending`, and an ungated button would set
           `activeKey='project-board'`, fall straight back to their landing tab, and change nothing on
           screen except a `?projectNo=` they cannot see. That is a NEW dead end, which is precisely
           what the seven lines above this exist to prevent. Ungated it also promises an action
           (再同步一次) that needs operate. Without the grant they keep the empty state's own second
           sentence, which names the same step in words. -->
      <button
        v-if="emptyState === 'nothing_pending' && canOpenProjectBoard"
        type="button"
        data-testid="stock-prep-confirmation-empty-resync"
        @click="handleResync"
      >{{ bi(resyncActionLabel.zh, resyncActionLabel.en) }}</button>
      <!-- P1-2: the LABEL changes with the mode because the journey does. See
           STOCK_PREP_QUEUE_RESYNC_ACTION_EMBEDDED's own comment: 线框 D ④ writes it 「回到上面再同步一
           次」, and in the host the button really does go back up the page and run the sync panel
           sitting there (the host's `embedded-resync` handler scrolls to it and calls its `run`). -->
    </p>

    <!-- The value-entry pane: the ONE content-bearing surface, gated on the same code as confirm. -->
    <section
      v-if="valueEntry && can('confirmationQueue.valueEntry')"
      class="stock-prep-confirm__pane"
      data-testid="stock-prep-confirmation-value-entry-pane"
    >
      <h3>{{ bi('您在这一条上填过的内容', 'What you entered on this one') }}</h3>
      <!-- 2026-09-10 field report: the raw request-body field name (`resolvedValue` etc.) used to sit
           right next to the plain label here, and a reader who is not the person who built this page
           read it as "the grey word is what I'm looking at" — it is not, it is the wire name. The
           same three names are still on screen, verbatim, in 技术详情 below (「请求体字段名」), which
           is where an implementer actually needs them; this readback keeps only the plain label. -->
      <dl>
        <dt>{{ bi('填的值', 'The value you entered') }}</dt>
        <dd data-testid="stock-prep-confirmation-value-entry-value">{{ valueEntry.valueEntry.resolvedValue }}</dd>
        <dt>{{ bi('附带的值', 'The extra value') }}</dt>
        <dd data-testid="stock-prep-confirmation-value-entry-aux">{{ valueEntry.valueEntry.resolvedAuxValue }}</dd>
        <dt>{{ bi('备注', 'Your note') }}</dt>
        <dd data-testid="stock-prep-confirmation-value-entry-notes">{{ valueEntry.valueEntry.notes }}</dd>
      </dl>
    </section>

    <!-- The confirm form: the frozen action vocabulary + the Q2-A value fields, one gate. -->
    <form
      v-if="selected && can('confirmationQueue.confirm')"
      class="stock-prep-confirm__form"
      data-testid="stock-prep-confirmation-form"
      @submit.prevent="submitConfirm"
    >
      <h3>{{ bi('这一条您打算怎么处理', 'How do you want to handle this one') }}</h3>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('处理办法', 'What to do') }}</span>
        <select v-model="resolutionAction" data-testid="stock-prep-confirmation-action-select">
          <option v-for="action in STOCK_PREPARATION_RESOLUTION_ACTIONS" :key="action" :value="action">
            {{ decisionActionLabel(action) }}
          </option>
        </select>
      </label>
      <p v-if="selectedActionHint" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-action-hint">
        {{ selectedActionHint }}
      </p>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('填一个值(按上面的办法需要时)', 'A value, if the choice above needs one') }}</span>
        <input v-model="resolvedValue" type="text" data-testid="stock-prep-confirmation-value-input">
      </label>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('附带的值(可不填)', 'An extra value (optional)') }}</span>
        <input v-model="resolvedAuxValue" type="text" data-testid="stock-prep-confirmation-aux-input">
      </label>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('备注:为什么这么定(可不填)', 'Note: why you decided this (optional)') }}</span>
        <input v-model="notes" type="text" data-testid="stock-prep-confirmation-notes-input">
      </label>
      <button type="submit" data-testid="stock-prep-confirmation-confirm" :disabled="busy">
        {{ bi('就这么定', 'Save this decision') }}
      </button>
    </form>

    <!-- Everything this pane used to lead with, kept and one click away: the frozen server
         vocabularies (which is what an implementer matches a support thread against) and the exact
         field names a request body carries. -->
    <StockPrepTechnicalDetails testid="stock-prep-confirmation-tech">
      <dl>
        <dt>{{ bi('进展枚举', 'Decision status vocabulary') }}</dt>
        <dd>
          <span v-for="status in STOCK_PREPARATION_DECISION_STATUSES" :key="status">
            <code>{{ status }}</code> = {{ decisionStatusLabel(status) }};
          </span>
        </dd>
        <dt>{{ bi('处理办法枚举(服务端冻结)', 'Resolution-action vocabulary (frozen server-side)') }}</dt>
        <dd>
          <span v-for="action in STOCK_PREPARATION_RESOLUTION_ACTIONS" :key="action">
            <code>{{ action }}</code> = {{ decisionActionLabel(action) }};
          </span>
        </dd>
        <dt>{{ bi('请求体字段名', 'Request-body field names') }}</dt>
        <dd><code>resolvedValue</code> · <code>resolvedAuxValue</code> · <code>notes</code> · <code>inputFingerprint</code></dd>
        <dt>{{ bi('队列投影是 values-free 的', 'The queue projection is values-free') }}</dt>
        <dd>
          {{ bi(
            '队列只携带计数、指纹、状态与动作枚举;值内容仅在单条「值录入」读取中出现。',
            'The queue carries counts, fingerprints and the status/action enums only; entered content appears solely in the per-decision value-entry read.',
          ) }}
        </dd>
      </dl>
    </StockPrepTechnicalDetails>
  </div>
</template>

<script setup lang="ts">
// O1' / O2 — the confirmation-queue operator pane of `/stock-prep`.
//
// Two disciplines govern this file:
//
//  1. R-11 ALIGNMENT. Control visibility is decided ONLY by `canStockPrepCapability` over the shared
//     capability manifest (workbenchAccess.ts, mirrored from the plugin module the server gates
//     with). No control hand-rolls a `hasPermission('stock-prep:…')` probe, because the operate tier
//     is a conjunction and a hand-rolled probe would drift. A control the caller cannot exercise is
//     ABSENT, not disabled.
//  2. VALUES-FREE except one pane. The queue projection carries presence booleans; only the
//     value-entry pane renders content, and it renders under the same gate the server puts on that
//     read. Errors surface as the CLAMPED enum-shaped code from confirmApi.ts — never a server
//     message, which could carry a value.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  STOCK_PREPARATION_DECISION_STATUSES,
  STOCK_PREPARATION_RESOLUTION_ACTIONS,
  advanceStockPreparationHandoff,
  confirmStockPreparationDecision,
  exportStockPreparationPrepLines,
  listStockPreparationDecisions,
  readStockPreparationDecisionReadiness,
  readStockPreparationHandoff,
  readStockPreparationOperatorDirectory,
  readStockPreparationValueEntry,
  type StockPreparationDecisionQueue,
  type StockPreparationDecisionReadiness,
  type StockPreparationDecisionRow,
  type StockPreparationDecisionStatus,
  type StockPreparationDecisionValueEntry,
  type StockPreparationHandoffAdvanceResult,
  type StockPreparationHandoffStatus,
  type StockPreparationOperatorDirectory,
  type StockPreparationOperatorProject,
  type StockPreparationResolutionAction,
  isConfirmableConflictType,
} from '../../../services/integration/stockPreparation/confirmationQueue'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  canOpenStockPrepInstallView,
  canOpenStockPrepProjectBoard,
  canStockPrepCapability,
} from '../../../services/integration/stockPreparation/workbenchAccess'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'
import {
  STOCK_PREP_DECISION_ACTION_PLAIN,
  STOCK_PREP_DECISION_STATUS_PLAIN,
  STOCK_PREP_LEDGER_MISSING_ACTION,
  STOCK_PREP_QUEUE_RESYNC_ACTION,
  STOCK_PREP_QUEUE_RESYNC_ACTION_EMBEDDED,
  STOCK_PREP_RECONCILE_BUTTON_NOTE,
  STOCK_PREP_TOOLTIP_PENDING_CONFIRM,
  stockPrepConflictTypePlain,
  stockPrepDirectoryEmptyPlain,
  stockPrepDirectoryEmptyState,
  stockPrepEnumPlain,
  stockPrepErrorCopyText,
  stockPrepErrorPlain,
  stockPrepHandoffOutcomePlain,
  stockPrepHandoffStepPlain,
  type StockPrepPlainEntry,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = defineProps<{
  scope: IntegrationScope
  projectNo?: string
  /**
   * P1-2 (§6.2 P1-2) — composed IN PLACE by StockPreparationProjectBoardView's own Panel 2 (线框
   * C/D). `false`/unset is the ONLY value every caller before this pass ever passed, so this prop's
   * whole contract is additive: the non-embedded render path below is byte-for-byte what it was.
   * WHAT EMBEDDED HIDES, and the ONE test each hide had to pass — "would this control, HERE, either
   * lie or act on something other than the project the page is about?":
   *   · 项目号输入框 + 顶部说明段 — the host carries both; a second editable copy of the SAME number
   *     invites drift from the page around it.
   *   · 跨项目工作清单 (`pickProject`) — the same drift, but worse: it rewrites this view's own
   *     `projectNo` while the whole page above stays on the opened project.
   *   · 状态筛选 — the server tallies `byStatus` over the FILTERED rows, and the host's 进度条 reads
   *     that field; a filter next to the bar is a way to render 100% green with pending rows open (G4).
   *   · 导出 / 通知下一步 / 轮到谁 / 补发提醒 — the host renders its own, from its own reads (G1).
   *   · 建账本 / 重新扫描 + 那条说明 — their `admin-action` emit is answered by the SHELL, and the
   *     host is not the shell; rendered here they would be buttons that do nothing (R-11).
   * WHAT IT DOES NOT HIDE: 刷新列表, 检查是否准备好, 刷新我的项目 (all act on this view alone), the
   * rows and the confirm form (the point of the panel), the empty states, and 去装:开始使用 — that
   * one rides `navigate-stage`, which the host re-emits to the shell.
   * It also reroutes the closed-loop 「回到上面再同步一次」 button to an emit instead of a tab switch,
   * because the host already IS "上面", and gives it the wireframe's own longer label to say so.
   */
  embedded?: boolean
}>()
/**
 * The two platform-admin controls below are the ONLY things this component emits. The shell owns the
 * calls (it owns every other service call on this page's siblings too), so the payload carries the
 * one thing the shell cannot know: WHICH project the admin is looking at. reconcile is scoped to a
 * single project number server-side, and the number lives in this component's own input.
 *
 * ONE SIGNATURE FOR BOTH ACTIONS, deliberately. `ensure` does NOT take a project — its request body
 * is strictly empty and the staging project is auth-derived — so the shell ignores the number for it.
 * A second event shape for the sake of one unused argument would buy nothing and give the shell two
 * listeners to keep in step.
 */
const emit = defineEmits<{
  (event: 'admin-action', action: 'ensure' | 'reconcile', projectNo: string): void
  // P0-7 / D2: the `ledger_missing` empty state's [去装:开始使用] button, and now (P0-9) the
  // `nothing_pending` empty state's [再同步一次] button too. Reuses the SAME event/handler
  // `StockPreparationWorkspace.vue` already wires for the dashboard tab's own stepper
  // (`handleNavigateStage`) — this view stays a pure emitter, exactly like `admin-action` above; the
  // shell is still the only thing that owns tab navigation. `projectNo` is OPTIONAL and additive: the
  // ledger_missing button still calls this with one argument, unaffected; the nothing_pending button
  // carries the queue's OWN current number so the shell can bring the board back to the SAME project
  // (§2.3's `?projectNo=` state bit) rather than whatever it last had open — no new route, no new
  // controlled control (workbenchAccess.ts is untouched: this is a plain event payload, not a capability).
  (event: 'navigate-stage', viewKey: string, projectNo?: string): void
  /**
   * P1-2 — EMBEDDED MODE's own escape hatch for the SAME "回到上面再同步一次" button `navigate-stage`
   * above already carries. When this view is composed in place (StockPreparationProjectBoardView's
   * Panel 2) the host already IS "上面": a `navigate-stage('project-board', …)` there would ask the
   * shell to switch to a tab the operator is already looking at — a no-op dressed as an action, and
   * on a `stock-prep:read`-only queue-tab session it would even be wrong (see the button's own R-11
   * comment). The host listens for this instead and scrolls/focuses its own sync panel; no route, no
   * new controlled control (this is a plain event payload, exactly like `navigate-stage` itself).
   */
  (event: 'embedded-resync'): void
  /**
   * P1-2 — the queue's OWN response, forwarded so a host composing this view in place (Panel 2's
   * progress bar) can read `byStatus`/`parkedCount` without a second fetch or a new interface. Fires
   * on every `queue` change, embedded or not — a non-embedded caller that does not listen loses
   * nothing, and this adds no DOM, so it cannot be the "one byte" P1-2's non-embedded guarantee
   * covers.
   */
  (event: 'queue-changed', queue: StockPreparationDecisionQueue | null): void
}>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const capabilityById = computed(() => {
  const byId = new Map<string, (typeof STOCK_PREP_WORKBENCH_CAPABILITIES)[number]>()
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) byId.set(capability.capability, capability)
  return byId
})

/** THE single visibility predicate. Unknown capability ids fail closed. */
function can(capabilityId: string): boolean {
  const capability = capabilityById.value.get(capabilityId)
  if (!capability) return false
  return canStockPrepCapability(capability, auth.getAccessSnapshot())
}

/**
 * The server vocabularies, in words. Both fall back to the raw token for anything the table does not
 * know, so a status or action added server-side reads exactly as it does today rather than blanking.
 */
function decisionStatusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_DECISION_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

function decisionActionLabel(action: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_DECISION_ACTION_PLAIN, action)
  return plain ? bi(plain.zh, plain.en) : (action ?? '—')
}

const errorPlain = stockPrepErrorPlain
const reconcileButtonNote = STOCK_PREP_RECONCILE_BUTTON_NOTE
const ledgerMissingActionLabel = STOCK_PREP_LEDGER_MISSING_ACTION
/**
 * P1-2: 线框 D ④'s label, per mode. In the TAB the button leaves this page for 项目备料页, and
 * 「再同步一次」 is the whole of what it promises. Composed in place it does not leave anything — it
 * takes the operator back UP the same page and runs the sync panel already sitting there — so it uses
 * the wireframe's own longer wording, which says the journey out loud.
 */
const resyncActionLabel = computed<StockPrepPlainText>(() => (props.embedded
  ? STOCK_PREP_QUEUE_RESYNC_ACTION_EMBEDDED
  : STOCK_PREP_QUEUE_RESYNC_ACTION))
const pendingConfirmTooltip = STOCK_PREP_TOOLTIP_PENDING_CONFIRM

/**
 * THE SAME predicate the shell filters the install tab with (`workbenchAccess.ts`), not a second
 * opinion: whoever this answers `false` for cannot reach that tab, so they must not be offered a
 * button that navigates to it. Deliberately NOT `can('confirmationQueue.ensure')` — that is the
 * platform-admin write gate, and a `stock-prep:admin` holder who may READ the install page but not
 * run it should still be able to go look at it.
 */
const canOpenInstallView = computed(() => canOpenStockPrepInstallView(auth.getAccessSnapshot()))

/**
 * The SAME predicate the shell filters 项目备料 with — the sibling of the one above, for the sibling
 * button (`nothing_pending`'s 再同步一次). A `stock-prep:read`-only queue watcher answers `false`
 * here: 设计稿 §2.4 P-3 makes this page that tier's only entry point, so they really do reach the
 * empty state this button hangs off, and for them `activeKey='project-board'` silently folds back to
 * their landing tab — a button that moves nothing. It is one predicate, read from workbenchAccess.ts,
 * so a change to who may open that tab can never leave this button behind.
 */
const canOpenProjectBoard = computed(() => canOpenStockPrepProjectBoard(auth.getAccessSnapshot()))

/** 「复制这条报错」(P0-5, I-21). idle → copy → copied → idle again 3s later; never a permanent state. */
const errorCopyLabel = ref<'copy' | 'copied'>('copy')
let errorCopyResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyError(code: string): Promise<void> {
  // Guarded: `copyTextToClipboard`'s own fallback calls `document.execCommand`, which an environment
  // without any copy mechanism (this project's jsdom test host included) may not implement at all.
  let ok = false
  try {
    ok = await copyTextToClipboard(stockPrepErrorCopyText(code, locale.value === 'zh-CN'))
  } catch {
    ok = false
  }
  if (!ok) return
  errorCopyLabel.value = 'copied'
  if (errorCopyResetTimer) clearTimeout(errorCopyResetTimer)
  errorCopyResetTimer = setTimeout(() => { errorCopyLabel.value = 'copy' }, 3000)
}

// #3365「卸载即作废」 — a scheduled callback dies with the view that scheduled it.
onBeforeUnmount(() => {
  if (errorCopyResetTimer) clearTimeout(errorCopyResetTimer)
  errorCopyResetTimer = null
})

/** The step vocabulary in words, degrading to the raw key exactly like the two labels above. */
function handoffStepLabel(key: string | null): string {
  const plain = stockPrepHandoffStepPlain(key ?? '')
  return plain ? bi(plain.zh, plain.en) : (key ?? '—')
}

const projectNo = ref<string>(props.projectNo ?? '')

/**
 * P0-1 (F5) — the shell keeps `props.projectNo` in step with the project open elsewhere on this page.
 * NON-IMMEDIATE on purpose: the initial value is already captured by the `ref()` seed above, and this
 * view's own contract (see StockPreparationHandoff.spec.ts's `render()` helper) is "no onMounted, no
 * watcher firing on mount — it loads when the operator asks". So this fires ONLY on a genuine
 * post-mount CHANGE — the shell's `?projectNo=` moving under an already-mounted instance (P1's
 * `embedded` panel; today's tab-switch remounts fresh so the seed alone already covers it) or a test
 * driving the prop directly. A change RESETS the input to the new number and, when it is non-empty,
 * RELOADS that project's queue; an emptied value only resets the box — there is no project to load a
 * queue for.
 */
watch(() => props.projectNo, (next) => {
  const value = typeof next === 'string' ? next : ''
  if (value === projectNo.value) return
  projectNo.value = value
  if (value) void loadQueue()
})

const statusFilter = ref<StockPreparationDecisionStatus | ''>('')
const busy = ref(false)
const errorCode = ref<string | null>(null)
const queue = ref<StockPreparationDecisionQueue | null>(null)
/** P1-2: forward every change to `queue` up to whoever composed this view — see the emit's own
 *  comment for why (Panel 2's progress bar reads `byStatus` off this, no second fetch). */
watch(queue, (value) => {
  emit('queue-changed', value)
})
const readiness = ref<StockPreparationDecisionReadiness | null>(null)
const valueEntry = ref<StockPreparationDecisionValueEntry | null>(null)
const selected = ref<StockPreparationDecisionRow | null>(null)
const resolutionAction = ref<StockPreparationResolutionAction>('keep_multiple_rows')
const resolvedValue = ref('')
const resolvedAuxValue = ref('')
const notes = ref('')
/** Set after a successful export whose project had zero ACTIVE material rows — the download still
 *  happened (a valid, headers-only workbook), this is purely the plain-language notice for it. */
const exportEmptyNotice = ref(false)

// --- 一线看得见自己工厂的项目 ------------------------------------------------------------------
//
// The caller's OWN-TENANT project directory. Loaded on mount so the page opens on the operator's work
// rather than on an empty input; the server refuses this read to any principal without a tenant of
// its own, so nothing here can show one tenant another tenant's names.
const directory = ref<StockPreparationOperatorDirectory | null>(null)

const directoryProjects = computed<StockPreparationOperatorProject[]>(() => {
  // `Array.isArray` rather than a truthiness check on `directory.value`: this page renders whatever
  // the envelope parser hands back, and a degraded or partial payload (an older server, a truncated
  // response) must leave the operator with an empty list, never a blank page from a thrown computed.
  const projects = directory.value && Array.isArray(directory.value.projects) ? directory.value.projects : []
  // Only rows that actually carry a number can be picked or typed — a nameless/numberless row would
  // be an unselectable datalist entry, which is worse than absent.
  return projects.filter((project) => typeof project.projectNo === 'string' && project.projectNo.length > 0)
})

/** The worklist proper: the projects with something waiting, busiest first, then by number. */
const worklist = computed<StockPreparationOperatorProject[]>(() =>
  directoryProjects.value
    .filter((project) => project.pendingDecisionCount > 0)
    .slice()
    .sort((left, right) => (right.pendingDecisionCount - left.pendingDecisionCount)
      || String(left.projectNo).localeCompare(String(right.projectNo))))

/** Does the number currently in the box name a project in the caller's own directory? */
const projectKnown = computed<boolean>(() =>
  directoryProjects.value.some((project) => project.projectNo === projectNo.value))

/**
 * WHICH empty state, if any. Decided by the pure helper in plainLanguage.ts rather than inline, so
 * the copy and the condition it belongs to cannot drift apart.
 *
 * NO DIRECTORY IS ITSELF A STATE, not silence. Returning null here — which the first version did
 * whenever `directory.value` was null — rendered NOTHING for the three principals who never get a
 * directory: a `stock-prep:read`-only queue watcher (no request is issued for them at all), an
 * operate-holder whose load failed, and the tenantless platform admin the server refuses by design.
 * All three previously saw 「都清了」; a blank page is a worse answer than a wrong one, because the
 * operator cannot even tell the page finished loading.
 */
const emptyState = computed<string | null>(() => {
  const loaded = directory.value
  return stockPrepDirectoryEmptyState({
    directoryAvailable: loaded !== null,
    // Coerced defensively for the same reason as above: a partial payload must degrade to the most
    // conservative diagnosis ("nothing synced"), never crash and never claim "all clear".
    directoryReady: loaded !== null && loaded.directoryReady === true,
    ledgerReady: loaded !== null && loaded.ledgerReady === true,
    projectCount: loaded !== null && typeof loaded.projectCount === 'number'
      ? loaded.projectCount
      : directoryProjects.value.length,
    projectNo: projectNo.value,
    projectKnown: projectKnown.value,
    pendingRowCount: queue.value && Array.isArray(queue.value.rows) ? queue.value.rows.length : 0,
  })
})

const emptyStateText = computed<StockPrepPlainEntry>(() =>
  stockPrepDirectoryEmptyPlain(emptyState.value) ?? { zh: '', en: '' })

/**
 * The directory load has its OWN busy flag rather than sharing `busy` with the queue.
 *
 * That is not tidiness. `busy` disables the queue's own controls, and this load starts on mount — so
 * sharing it would leave 「刷新列表」 and every other control dead for the duration of a request the
 * operator did not ask for, and would make "can I click refresh yet" depend on a race with a
 * background fetch. The two concerns are independent and their spinners must be too.
 */
const directoryBusy = ref(false)

/**
 * THE TWO SERVER REFUSALS THAT ARE NOT FAULTS.
 *
 * The directory read is scoped to the caller's OWN tenant and requires the host to vouch for the
 * pairing, so it refuses two whole classes of principal BY DESIGN:
 *
 *   OPERATOR_SCOPE_TENANT_REQUIRED     — a tenantless platform admin (us: the consultant, support).
 *                                        They pass the permission gate and are then refused because
 *                                        they have no tenant of their own, which is the guard doing
 *                                        its job, not an outage.
 *   OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE — the deployment injects no host membership seam, so the
 *                                        read fails closed. Nothing the person at the screen can do.
 *
 * Both arrive on MOUNT, unprompted, which put a red write-flavoured error line on the page for every
 * platform admin on every single page open. Neither is actionable and neither is news, so neither
 * becomes an error banner. They are not silent, either: `directory_unavailable` renders in the empty
 * state and says exactly what is and is not known. The list is a CLOSED set of two codes — any other
 * failure, a 500 included, still surfaces, because a directory that genuinely broke IS news.
 */
const DIRECTORY_NOT_FOR_THIS_PRINCIPAL = Object.freeze([
  'OPERATOR_SCOPE_TENANT_REQUIRED',
  'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE',
])

async function loadDirectory(): Promise<void> {
  if (!can('confirmationQueue.projectDirectory')) return
  directoryBusy.value = true
  try {
    directory.value = await readStockPreparationOperatorDirectory(props.scope)
  } catch (error) {
    if (error instanceof StockPreparationConfirmApiError
      && DIRECTORY_NOT_FOR_THIS_PRINCIPAL.includes(error.code)) {
      // Not an error to report — see above. `directory.value` stays null, which is what the empty
      // state reads to say "no worklist for you, and we cannot judge this number".
      return
    }
    // Every other failure surfaces on the page's one error line like any other — an operator whose
    // worklist silently failed to load would read the empty page as "no work", which is the exact
    // dishonesty this change exists to remove.
    recordError(error)
  } finally {
    directoryBusy.value = false
  }
}

/**
 * P1-2: the "回到上面再同步一次" button's ONE handler, for both modes. Embedded routes through the
 * new `embedded-resync` emit (the host already IS "上面"); every existing, non-embedded caller keeps
 * emitting exactly the `navigate-stage` call it always has — same event name, same two arguments.
 */
function handleResync(): void {
  if (props.embedded) {
    emit('embedded-resync')
    return
  }
  emit('navigate-stage', 'project-board', projectNo.value)
}

/** Pick a project from the worklist: fill the number the typed path already uses, then load it. */
async function pickProject(project: StockPreparationOperatorProject): Promise<void> {
  if (!project.projectNo) return
  projectNo.value = project.projectNo
  await loadQueue()
}

// The page opens on the operator's own work. A caller without the capability loads nothing and sees
// exactly the surface they saw before this change.
onMounted(() => {
  void loadDirectory()
})

/**
 * 通知下一步 state. INERT is the fail-soft resting position, and it is what the view holds whenever
 * the status is unknown for ANY reason — no project number typed yet, no `handoff.read` grant, a
 * deployment whose backend predates this route, or a rejected fetch. `configured: false` renders no
 * control and no status line, which is exactly the behaviour of a deployment that has not set a
 * chain up, so an outage degrades to "feature absent" rather than to a broken queue.
 */
const HANDOFF_INERT: StockPreparationHandoffStatus = Object.freeze({
  configured: false,
  projectNo: '',
  steps: [],
  stepCount: 0,
  stepIndex: null,
  currentStepKey: null,
  terminal: false,
  completed: false,
  isCurrentHandler: false,
  notifiedStepIndex: null,
  notificationsConfigured: false,
  resendableStepKey: null,
  lostStepKeys: [],
})

const handoff = ref<StockPreparationHandoffStatus>(HANDOFF_INERT)
/** The last advance's result — the source of the plain-language notice, cleared on each new press. */
const handoffAdvance = ref<StockPreparationHandoffAdvanceResult | null>(null)

/**
 * What to tell the operator after an advance.
 *
 * THE DISCRIMINATOR IS `notifyOutcome`, NOT `changed`, and that correction is the whole of this
 * comment. `changed` says whether the TURN moved; it says nothing about whether a message went out.
 * Those two used to be the same question, and the first version of this notice short-circuited on
 * `changed === false` and printed 「没有重复通知」.
 *
 * They came apart when the notification claim became a compare-and-set of its own: a request that is
 * BOTH a replay and the one that finally sends the owed notice is now ordinary, and so is the same
 * request FAILING to send it. On the old wording an operator whose resend had just failed — or
 * half-failed across 仓库 and 采购 — was told in words that nothing needed sending. The claim is spent
 * by then, so no later click can ever resend it: being told the wrong thing here is terminal, and the
 * group that missed the notice is never chased.
 *
 * So: if something was actually attempted (sent / partial / failed), say what happened to it. Only
 * `skipped` and `not_configured` on an unchanged turn are genuinely "nothing needed sending".
 */
const handoffNoticeText = computed<string>(() => {
  const result = handoffAdvance.value
  if (!result) return ''
  const attempted = result.notifyOutcome === 'sent'
    || result.notifyOutcome === 'partial'
    || result.notifyOutcome === 'failed'
  // J2: `resumed` is the COMMITTED verdict that this click took the claim, so a request carrying it
  // may never render the replay sentence — whatever the outcome. The first cut checked only
  // `attempted`, which left one outcome ('not_configured', now 'no_destination') reaching the
  // 「没什么要发」 wording on a click that had just spent the hop's one chance to be announced.
  if (result.changed === false && !attempted && result.resumed !== true) {
    return bi(
      '这一步之前已经交接过了,没有重复通知。',
      'This step had already been handed on, so nobody was notified a second time.',
    )
  }
  const plain = stockPrepHandoffOutcomePlain(result.notifyOutcome)
  if (!plain) return bi('已经交给下一步了。', 'It has been handed on to the next step.')
  const lead = bi(plain.zh, plain.en)
  const next = bi(plain.zhNext ?? '', plain.enNext ?? '')
  const body = next ? `${lead} ${next}` : lead
  // A RESUME is not the same event as a first advance and must not be described as one: the turn
  // moved earlier, and what this click did was send the notice that hop had been owed since.
  if (result.resumed === true) {
    return `${bi('这一跳之前没发出去的通知,这次补发了。', 'The notice this step had been owed was sent now.')} ${body}`
  }
  return body
})

/** The enum, kept on screen but subordinate — what a person quotes when they ask us about it. */
const handoffNoticeToken = computed<string | null>(() => handoffAdvance.value?.notifyOutcome ?? null)

/**
 * IS THERE A HOP WHOSE NOTICE NEVER WENT OUT? The claim is monotonic, so once a later hop is claimed
 * an earlier owed one can never be sent by anyone — pressing the button again does not help, and
 * until this line existed nothing on the screen said so.
 *
 * Two guards, both load-bearing. `notificationsConfigured` keeps a deliberate turn-state-only
 * deployment — whose `notifiedStepIndex` is null forever and correctly so — from being told it has
 * lost every notice it never meant to send. And the comparison is against `stepIndex - 1` because the
 * CURRENT hop has not been handed off yet: its notice is not late, it is not due.
 */
const handoffLostStepKeys = computed<string[]>(() => {
  const state = handoff.value
  if (!state.configured) return []
  return Array.isArray(state.lostStepKeys) ? state.lostStepKeys : []
})

/** The step whose notice is still owed AND still sendable by this caller. Server-computed. */
const handoffResendableStepKey = computed<string | null>(() => {
  const state = handoff.value
  if (!state.configured) return null
  return typeof state.resendableStepKey === 'string' && state.resendableStepKey ? state.resendableStepKey : null
})

/** The committed labels for the lost hops, so the sentence names them rather than counting them. */
const handoffLostStepLabels = computed<string>(() =>
  handoffLostStepKeys.value.map((key) => handoffStepLabel(key)).join('、'))

/** What the currently chosen handling actually does, in one line, before the operator commits. */
const selectedActionHint = computed<string>(() => {
  const plain = stockPrepEnumPlain(STOCK_PREP_DECISION_ACTION_PLAIN, resolutionAction.value)
  if (!plain) return ''
  const entry = STOCK_PREP_DECISION_ACTION_PLAIN[resolutionAction.value]
  return bi(entry?.zhNext ?? '', entry?.enNext ?? '')
})

/** Only the clamped enum code reaches state — a server message could carry a value. */
function recordError(error: unknown): void {
  errorCode.value = error instanceof StockPreparationConfirmApiError
    ? error.code
    : 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'
}

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  errorCode.value = null
  try {
    await task()
  } catch (error) {
    recordError(error)
  } finally {
    busy.value = false
  }
}

/**
 * Whose turn it is, read FAIL-SOFT and deliberately OUTSIDE `run()`.
 *
 * Outside, because the turn signal is an addition to this page, not a precondition of it: a
 * deployment whose backend predates the handoff route, or one having a bad minute, must leave the
 * confirmation queue — the only page a floor operator has — working exactly as before. So this
 * swallows its own failure into INERT (feature absent) and never touches `errorCode` or `busy`.
 */
async function loadHandoff(): Promise<void> {
  if (!projectNo.value || !can('handoff.read')) {
    handoff.value = HANDOFF_INERT
    return
  }
  try {
    const status = await readStockPreparationHandoff({ ...props.scope, projectNo: projectNo.value })
    handoff.value = status && typeof status === 'object' ? status : HANDOFF_INERT
  } catch {
    handoff.value = HANDOFF_INERT
  }
}

/**
 * The queue reload point — the operator's own 刷新列表 press, the P0-1 prop watcher (a project
 * change elsewhere on the page), the P0-8 auto-reload after a successful admin reconcile (the shell
 * calls this SAME function via `defineExpose`), and a successful confirm submit. One implementation,
 * so none of those four callers can end up re-fetching a slightly different shape.
 *
 * THE RESPONSE IS CHECKED, not trusted verbatim — and "unreadable" is NOT normalised into "empty".
 *
 * Two different failures used to share one outcome here. A payload that IS a queue but is missing a
 * field (an older backend that answers no `parkedCount`, a truncated `byStatus`) has to be filled in
 * defensively, or `queue.rows` stays `undefined` and the very next render white-screens the only page
 * a floor operator has. But a payload that is not a queue AT ALL — `{}`, `undefined` from an
 * unparseable 200, the HTML an SPA-fallback proxy answers with (this repo shipped exactly that in
 * r12–r16) — carries no evidence about anything, and filling THAT in produced a fabricated
 * `{rowCount: 0, rows: []}`. With a ready ledger and a known project that renders as
 * `nothing_pending`「没有要您拿主意的事」 plus an action button: the page confidently telling an
 * operator their project is clear because it could not read it. G4 (「看不到」不能渲染成「没有」).
 *
 * So the shape is the branch. Queue-shaped (a numeric `rowCount` or an array `rows`) → fill in the
 * rest. Anything else → an ordinary error on this page's one error line, `queue.value` untouched, no
 * empty state and no button — the same "say nothing about rows nobody could read" the page did before
 * the auto-reload existed, minus the crash.
 */
const QUEUE_UNREADABLE_CODE = 'STOCK_PREPARATION_DECISION_QUEUE_UNREADABLE'

function isQueueShaped(result: unknown): result is StockPreparationDecisionQueue {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  const candidate = result as Partial<StockPreparationDecisionQueue>
  return typeof candidate.rowCount === 'number' || Array.isArray(candidate.rows)
}

async function loadQueue(): Promise<void> {
  await run(async () => {
    const result = await listStockPreparationDecisions({
      ...props.scope,
      projectNo: projectNo.value,
      status: statusFilter.value === '' ? null : statusFilter.value,
    })
    if (!isQueueShaped(result)) {
      // Thrown, not assigned: `run` turns it into the page's error line, and a THROW is what leaves
      // `queue.value` exactly as it was — a previous good read stays on screen rather than being
      // replaced by a made-up empty one.
      throw new StockPreparationConfirmApiError(200, QUEUE_UNREADABLE_CODE, null)
    }
    queue.value = {
      rowCount: typeof result.rowCount === 'number' ? result.rowCount : 0,
      byStatus: result.byStatus && typeof result.byStatus === 'object' ? result.byStatus : {},
      byResolutionAction: result.byResolutionAction && typeof result.byResolutionAction === 'object' ? result.byResolutionAction : {},
      parkedCount: typeof result.parkedCount === 'number' ? result.parkedCount : 0,
      rows: Array.isArray(result.rows) ? result.rows : [],
    }
  })
  await loadHandoff()
}

async function loadReadiness(): Promise<void> {
  await run(async () => {
    readiness.value = await readStockPreparationDecisionReadiness(props.scope)
  })
}

async function loadValueEntry(decisionId: string | null): Promise<void> {
  if (!decisionId) return
  await run(async () => {
    valueEntry.value = await readStockPreparationValueEntry({ ...props.scope, decisionId })
  })
}

/** Same client-side trigger the generic Multitable export uses (MultitableWorkbench.vue): a Blob
 *  object URL + a synthetic `<a download>` click, never a direct `<a href>` to the API (which would
 *  carry no Authorization header) and never window.open. */
function triggerExportDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function exportMaterials(): Promise<void> {
  if (!projectNo.value) return
  exportEmptyNotice.value = false
  await run(async () => {
    const result = await exportStockPreparationPrepLines({ ...props.scope, projectNo: projectNo.value })
    triggerExportDownload(result.blob, result.filename)
    exportEmptyNotice.value = result.activeRowCount === 0
  })
}

/**
 * 通知下一步. `fromStepKey` is the step this view BELIEVES is current; the server compares it to the
 * one it actually holds and answers 409 STEP_MISMATCH when somebody else moved first — which is why
 * a stale page cannot double-advance the chain. The server also re-checks that the caller is the
 * current handler; the button's `isCurrentHandler` condition is courtesy, not the gate.
 */
async function advanceHandoff(): Promise<void> {
  // FINISH WHAT IS OWED BEFORE MOVING ON. When a hop's notice is still unsent, replaying THAT hop is
  // what sends it; advancing the current one instead would claim the next step and push the monotonic
  // max past the owed hop, losing it for good. So the resend wins when both are possible — which is
  // also what the invitation on screen promises the click will do.
  const fromStepKey = handoffResendableStepKey.value ?? handoff.value.currentStepKey
  if (!projectNo.value || !fromStepKey) return
  handoffAdvance.value = null
  await run(async () => {
    handoffAdvance.value = await advanceStockPreparationHandoff({
      ...props.scope,
      projectNo: projectNo.value,
      fromStepKey,
    })
    await loadHandoff()
  })
}

/**
 * Why this row cannot be decided here, in the operator's own words — or `''` when it can.
 *
 * The confirm endpoint implements exactly one conflict type today; every other row answers 409 with
 * "resolutionAction is not valid for this conflict type", which reads like "pick a different
 * option" when in fact no option on this page will ever work. Observed against the customer's own
 * PLM on 2026-09-04: BOM lines pointing at parts absent from the parts library hold as
 * `missing_component`, land in this queue as pending, and cannot be cleared from here at all — the
 * only way out is repairing the source, after which the next sync closes these entries by itself.
 * So the row says that, instead of offering three buttons that all fail.
 */
function rowUnconfirmableReason(row: StockPreparationDecisionRow): string {
  if (!row.decisionId) return ''
  if (isConfirmableConflictType(row.conflictType)) return ''
  if (row.conflictType === 'missing_component') {
    return bi(
      '这条在这一页处理不了:BOM 里引用的零件在源系统的物料表里找不到。请到源系统补上该零件(或修正它的编号),下次同步会自动关掉这一条。',
      'This one cannot be settled here: the BOM line points at a part that is not in the source system\'s parts library. Add the part there (or correct its id) and the next sync closes this entry by itself.',
    )
  }
  // Any conflict type this vocabulary knows about gets the same "what it means, what would work"
  // shape as the missing_component branch above; anything it does NOT know about (a genuinely future
  // type) degrades to the conservative sentence that follows — still refused, still explained.
  const plain = stockPrepConflictTypePlain(row.conflictType)
  if (plain) {
    return bi(
      `这条在这一页处理不了:${plain.zh}。请到源系统修正数据后重新同步;确实需要人工处理请联系管理员。`,
      `This one cannot be settled here: ${plain.en}. Fix the data in the source system and sync again; contact an administrator if it genuinely needs manual handling.`,
    )
  }
  return bi(
    '这一类目前还不能在这一页确认,系统会拒绝。请联系我们,或先到源系统修正数据后重新同步。',
    'This kind cannot be confirmed here yet — the server refuses it. Contact us, or fix the data in the source system and sync again.',
  )
}

/** 「什么情况」column text — the plain sentence when the vocabulary knows this conflict type, the raw
 *  server token otherwise (EVERY LOOKUP FAILS SOFT — see plainLanguage.ts). The raw code stays on
 *  screen either way via the cell's `title`. */
function conflictTypeLabel(conflictType: string | null): string {
  const plain = stockPrepConflictTypePlain(conflictType)
  if (plain) return bi(plain.zh, plain.en)
  return conflictType || ''
}

/**
 * 顶部一句话 (2026-09-10). True only when there is at least one row still waiting on a human AND
 * every one of them is a conflict type this page cannot act on — never true on an empty queue (there
 * is nothing to say), never true while a single confirmable row remains (that row's own controls are
 * the more useful thing on screen). Scoped to `status === 'pending'`: a `confirmed`/`superseded` row
 * is not "waiting", whatever its conflict type, and `queue.rows` can hold all three statuses at once
 * once the status filter above is set to "all".
 */
const pendingQueueRows = computed<StockPreparationDecisionRow[]>(() =>
  (queue.value?.rows ?? []).filter((row) => row.status === 'pending' && Boolean(row.decisionId)),
)
/** Only meaningful while `allPendingRowsUnconfirmable` is true — every pending row counted here IS
 *  one of the unconfirmable ones, because at that point they are the same set. */
const pendingUnconfirmableCount = computed<number>(() => pendingQueueRows.value.length)
const allPendingRowsUnconfirmable = computed<boolean>(() =>
  pendingQueueRows.value.length > 0
  && pendingQueueRows.value.every((row) => !isConfirmableConflictType(row.conflictType)),
)

function selectRow(row: StockPreparationDecisionRow): void {
  if (!isConfirmableConflictType(row.conflictType)) return
  selected.value = row
  resolvedValue.value = ''
  resolvedAuxValue.value = ''
  notes.value = ''
}

async function submitConfirm(): Promise<void> {
  const row = selected.value
  if (!row || !row.decisionId || !row.inputFingerprint) return
  await run(async () => {
    await confirmStockPreparationDecision({
      decisionId: row.decisionId as string,
      inputFingerprint: row.inputFingerprint as string,
      resolutionAction: resolutionAction.value,
      resolvedValue: resolvedValue.value,
      resolvedAuxValue: resolvedAuxValue.value,
      notes: notes.value,
    })
    selected.value = null
    await loadQueue()
  })
}

// P0-8: the shell's ONE handle onto this view for the "action → result → auto-reload" wiring — after
// a SUCCESSFUL admin-triggered reconcile, the shell calls `loadQueue()` on this same mounted instance
// so the operator sees the rescanned queue without an extra manual refresh. `can` was already exposed;
// `loadQueue` reuses the view's own load path verbatim (same project number, same status filter) —
// no second implementation of "what does refreshing this queue mean".
// `loadDirectory` joins `loadQueue` here for the SECOND half of P0-8's 「任一管理动作完成 → 动作 →
// 结果 → 自动重读」: 建立确认账本 changes exactly one fact this view renders — `ledgerReady` — and that
// fact lives in the DIRECTORY payload, not the queue. Without this the admin who just created the
// ledger kept staring at 「记录确认结果的表还没建好」 and its 去装 button until they refreshed by hand:
// the dead end this wave closed, re-opened one action later. The shell calls it; nothing else does.
defineExpose({ can, loadQueue, loadDirectory })
</script>

<style scoped>
.stock-prep-confirm__scope {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-confirm__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-2);
  margin-bottom: var(--ms-space-3);
}

.stock-prep-confirm__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.stock-prep-confirm__error {
  margin: 0 0 var(--ms-space-3);
  color: var(--el-color-danger, #c45656);
  font-size: 13px;
}

/* A grep-able identifier that is no longer the point of the line: still selectable and copyable,
   visibly subordinate to the sentence beside it. */
.stock-prep-confirm__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.stock-prep-confirm__hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* The per-row reason a decision cannot be settled on this page. Same muted treatment as the
   other hints; it sits under a disabled button, so it must not compete with live controls. */
.stock-prep-confirm__row-hint {
  margin: 0.25rem 0 0;
  font-size: 0.85em;
  opacity: 0.85;
  max-width: 34rem;
}

/* 一线看得见自己工厂的项目 — the worklist. Deliberately the widest, plainest thing on the page after
   the input: it is what an operator opens this page to see. */
.stock-prep-confirm__worklist {
  margin-bottom: var(--ms-space-3);
}

.stock-prep-confirm__worklist h3 {
  margin: 0 0 var(--ms-space-2);
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-confirm__worklist ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stock-prep-confirm__worklist-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  width: 100%;
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: none;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}

.stock-prep-confirm__worklist-item:disabled {
  cursor: default;
  opacity: 0.6;
}

/* The number stays monospace and selectable — it is what a person quotes on the phone — but the NAME
   is the thing that reads first, which is the whole point of this change. */
.stock-prep-confirm__worklist-no {
  font-family: var(--ms-font-mono, monospace);
  color: var(--ms-text-3);
  font-size: 12px;
}

.stock-prep-confirm__worklist-name {
  flex: 1 1 auto;
  font-weight: 600;
}

.stock-prep-confirm__worklist-count {
  color: var(--ms-text-2);
  font-size: 12px;
}

.stock-prep-confirm__empty {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-confirm__counts {
  display: flex;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-2);
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-confirm__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.stock-prep-confirm__table th,
.stock-prep-confirm__table td {
  padding: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
}

.stock-prep-confirm__pane,
.stock-prep-confirm__form {
  margin-top: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
}

.stock-prep-confirm__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-2);
}
</style>

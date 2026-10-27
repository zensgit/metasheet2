<template>
  <section class="sp-sync" data-testid="stock-prep-project-sync">
    <header class="sp-sync__head">
      <h3 class="sp-sync__title">{{ bi('项目接入', 'Bring a project in') }}</h3>
      <p class="sp-sync__lede" data-testid="stock-prep-project-sync-lede">
        {{ bi(
          '填一个项目号,点同步 —— 这个项目的 BOM 就会从 PLM 读过来,写进我们的多维表。碰到拿不准的行,系统会停下来先问您,不会自己猜。',
          'Type a project number and press sync: this project’s BOM is read from PLM and written into our multitable. Where a row is uncertain the system stops and asks you rather than guessing.',
        ) }}
      </p>
    </header>

    <!-- The one input on this panel. The project number is the OPERATOR'S OWN text and the only
         business string on the surface; everything else the panel shows is a count or a status. -->
    <div class="sp-sync__form">
      <label class="sp-sync__field">
        <span class="sp-sync__label">{{ bi('项目号', 'Project number') }}</span>
        <input
          ref="projectNoEl"
          v-model="projectNo"
          type="text"
          class="sp-sync__input"
          data-testid="stock-prep-project-sync-project-no"
          :disabled="busy"
          :placeholder="bi('例如 P2026-001', 'e.g. P2026-001')"
          :aria-label="bi('要同步的项目号', 'The project number to sync')"
          @keyup.enter="onRun"
        />
      </label>
      <!-- G1 每屏一个主操作位: when the workspace's 「下一步」 bar is on screen it owns the one
           filled primary, and this button steps down to a neutral secondary. `data-primary-cta` is
           therefore conditional — it is the attribute a spec counts to prove the rule holds. -->
      <button
        v-if="canRun"
        type="button"
        class="sp-sync__run"
        :class="{ 'sp-sync__run--secondary': runEmphasis === 'secondary' }"
        data-testid="stock-prep-project-sync-run"
        :data-primary-cta="runEmphasis === 'primary' ? 'stock-prep-project-sync-run' : undefined"
        :disabled="!canSubmit"
        @click="onRun"
      >
        {{ busy && !targetPrompt ? bi(...runningLabel) : bi(...runLabel) }}
      </button>
      <!-- R-11: a control the caller cannot exercise is ABSENT, and the reason is said in words.
           R-33 (2026-10-08) moved the pull to the 拉取人员 (`stock-prep:pull`): a floor operator
           sees this line instead of the button. It names the 拉取人员 first and the platform
           administrator second, because sending someone to the wrong person is its own kind of
           dead end — and it does NOT say 「备料操作权限」, which the reader already holds. -->
      <p v-else class="sp-sync__hint" data-testid="stock-prep-project-sync-denied">
        {{ bi(
          '从 PLM 拉数据由拉取人员负责。您可以看这里的结果,需要拉取请联系拉取人员(或平台管理员)。',
          'Pulling data from PLM is done by a pull operator (拉取人员). You can read the results here; to pull, please contact a pull operator — or a platform administrator.',
        ) }}
      </p>
    </div>

    <!-- 备料分批拉取第一期 step 4 PR-7 — 「核对」 (design §9.2): ONE more preview, nothing written. Rendered only for a
         caller who may run the pull, and only while the board says the project is written but not checked; ABSENT
         otherwise (R-11), so every not-governed project's panel is the DOM it was. The result line never claims
         「核对通过」 until the board's own re-read says complete AND settled. -->
    <div v-if="showsCheck || checkLine" class="sp-sync__check" data-testid="stock-prep-project-sync-check-area">
      <button
        v-if="showsCheck"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-check"
        :disabled="busy"
        @click="runSettlementCheck"
      >{{ checkBusy ? bi('正在核对…', 'Checking…') : bi('核对', 'Check') }}</button>
      <p
        v-if="checkLine"
        class="sp-sync__hint"
        data-testid="stock-prep-project-sync-check-result"
        :data-check="checkResult ? checkResult.outcome : ''"
        :data-check-phase="checkPhase"
        role="status"
      >
        {{ checkLine.text }}
        <span v-if="checkLine.next">{{ checkLine.next }}</span>
      </p>
    </div>

    <!-- R67 ④: 试算 runs as a background job — while it reads PLM this line says so, with the time it
         has taken, instead of one long spinner that a 60 s gateway timeout used to cut off. Also shown
         after a reload when this caller's earlier trial of the project is still running (re-attach). -->
    <p
      v-if="dryRunProgressText"
      class="sp-sync__hint"
      role="status"
      data-testid="stock-prep-project-sync-dry-run-progress"
      :data-dry-run-progress="dryRunProgress?.source ?? ''"
    >
      {{ dryRunProgressText }}
    </p>

    <!-- 一个项目一张备料表 (S2, R-36) — THE QUESTION THE PROJECT-SHEET FLOW IS WAITING ON. Rendered only
         while `runStockPreparationProjectPull` (projectTarget.ts) has asked and nobody has answered:
         create the sheet (absent), pull again (active), or write what the preview showed (a sheet this
         run just created). With the server's switch off the flow never asks, so this never renders.
         No 「撤销新建」 anywhere: declining after the create leaves the sheet (「还没拉过」). -->
    <div
      v-if="targetPrompt"
      class="sp-sync__target-prompt"
      role="group"
      data-testid="stock-prep-project-sync-target-prompt"
      :data-prompt="targetPrompt.request.kind"
    >
      <template v-if="targetPrompt.request.kind === 'create'">
        <p class="sp-sync__target-line">
          {{ bi(targetPlain('confirm_create').zh, targetPlain('confirm_create').en) }}
          <strong data-testid="stock-prep-project-sync-target-prompt-project-no">{{ submittedProjectNo }}</strong>
        </p>
        <p class="sp-sync__hint">{{ bi(targetPlain('confirm_create').zhNext ?? '', targetPlain('confirm_create').enNext ?? '') }}</p>
        <div class="sp-sync__target-actions">
          <!-- The projectTarget.create control (manifest, PULL tier): the flow only asks a caller who
               passes `canRunStockPrepProjectSync` AND whose sheet the server says `may.create`. -->
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-target-create"
            @click="answerTargetPrompt(true)"
          >{{ bi(targetPlain('confirm_create_action').zh, targetPlain('confirm_create_action').en) }}</button>
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-target-prompt-cancel"
            @click="answerTargetPrompt(false)"
          >{{ bi(targetPlain('confirm_create_cancel').zh, targetPlain('confirm_create_cancel').en) }}</button>
        </div>
      </template>
      <template v-else-if="targetPrompt.request.kind === 'repull'">
        <p class="sp-sync__target-line" data-testid="stock-prep-project-sync-target-prompt-rows">
          {{ promptRowsText }}{{ bi(targetPlain('confirm_repull').zh, targetPlain('confirm_repull').en) }}
        </p>
        <p class="sp-sync__hint">{{ bi(targetPlain('confirm_repull').zhNext ?? '', targetPlain('confirm_repull').enNext ?? '') }}</p>
        <div class="sp-sync__target-actions">
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-target-prompt-confirm"
            @click="answerTargetPrompt(true)"
          >{{ bi(targetPlain('confirm_repull_action').zh, targetPlain('confirm_repull_action').en) }}</button>
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-target-prompt-cancel"
            @click="answerTargetPrompt(false)"
          >{{ bi(targetPlain('confirm_repull_cancel').zh, targetPlain('confirm_repull_cancel').en) }}</button>
        </div>
      </template>
      <template v-else>
        <p class="sp-sync__target-line" data-testid="stock-prep-project-sync-target-prompt-preview">{{ promptPreviewText }}</p>
        <div class="sp-sync__target-actions">
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-target-prompt-confirm"
            @click="answerTargetPrompt(true)"
          >{{ bi(targetPlain('confirm_write_action').zh, targetPlain('confirm_write_action').en) }}</button>
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-target-prompt-cancel"
            @click="answerTargetPrompt(false)"
          >{{ bi(targetPlain('confirm_write_cancel').zh, targetPlain('confirm_write_cancel').en) }}</button>
        </div>
      </template>
    </div>

    <!-- S2: how a project-sheet run ended when it did NOT reach the four steps — declined, no sheet
         and no pull right, archived, or the create refused. Each says who acts next. -->
    <p
      v-if="targetNotice"
      class="sp-sync__target-notice"
      role="status"
      data-testid="stock-prep-project-sync-target-notice"
      :data-notice="targetNotice.kind"
    >
      {{ bi(targetNoticeText.zh, targetNoticeText.en) }}
      <span v-if="targetNoticeText.zhNext" class="sp-sync__verdict-next">{{ bi(targetNoticeText.zhNext, targetNoticeText.enNext ?? '') }}</span>
      <code
        v-if="(targetNotice.kind === 'create_refused' || targetNotice.kind === 'probe_failed') && targetNotice.code"
        class="sp-sync__token"
      >{{ targetNotice.code }}</code>
      <!-- S2 fix round 1: a state read that failed for any reason but switch-off stops the run; the
           operator reads again from here instead of being pulled on a guess. -->
      <button
        v-if="targetNotice.kind === 'probe_failed'"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-target-retry"
        :disabled="busy"
        @click="onRun"
      >{{ bi(targetPlain('retry_action').zh, targetPlain('retry_action').en) }}</button>
      <!-- S4 (ADR §4 archived row / §6, register R-38): 「恢复并重新拉取」 — only for a caller with the
           pull right on a sheet the server says may be restored. It asks for the project number to be
           TYPED, restores, then runs this same pull again (which now finds the sheet active and asks
           the 「重新拉取」 question). Anyone else reads 「请联系拉取人员恢复」 in the line above. -->
      <button
        v-if="targetNotice.kind === 'archived' && targetNotice.mayRestore && canRun && !restorePrompt"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-restore"
        :disabled="busy"
        @click="openRestorePrompt"
      >{{ bi(targetPlain('restore_and_repull_action').zh, targetPlain('restore_and_repull_action').en) }}</button>
    </p>
    <div
      v-if="restorePrompt"
      class="sp-sync__target-prompt"
      role="group"
      data-testid="stock-prep-project-sync-restore-prompt"
    >
      <p class="sp-sync__target-line">{{ bi(targetPlain('confirm_restore').zh, targetPlain('confirm_restore').en) }}</p>
      <label class="sp-sync__field">
        <span class="sp-sync__label">
          {{ bi(targetPlain('confirm_type_project_no').zh, targetPlain('confirm_type_project_no').en) }}
          <strong data-testid="stock-prep-project-sync-restore-project-no">{{ submittedProjectNo }}</strong>
        </span>
        <input
          v-model="restoreTyped"
          type="text"
          class="sp-sync__input"
          data-testid="stock-prep-project-sync-restore-input"
          :disabled="busy"
          :aria-label="bi(targetPlain('confirm_type_project_no').zh, targetPlain('confirm_type_project_no').en)"
        />
      </label>
      <div class="sp-sync__target-actions">
        <button
          type="button"
          class="sp-sync__link"
          data-testid="stock-prep-project-sync-restore-confirm"
          :disabled="busy || !restoreTypedMatches"
          @click="onRestoreAndRepull"
        >{{ bi(targetPlain('confirm_restore_action').zh, targetPlain('confirm_restore_action').en) }}</button>
        <button
          type="button"
          class="sp-sync__link"
          data-testid="stock-prep-project-sync-restore-cancel"
          :disabled="busy"
          @click="closeRestorePrompt"
        >{{ bi(targetPlain('confirm_lifecycle_cancel').zh, targetPlain('confirm_lifecycle_cancel').en) }}</button>
      </div>
    </div>
    <p
      v-if="restoreRefusal"
      class="sp-sync__target-notice"
      role="status"
      data-testid="stock-prep-project-sync-restore-refused"
      :data-result="restoreRefusal.kind"
    >
      {{ bi(restoreRefusalText.zh, restoreRefusalText.en) }}
      <span v-if="restoreRefusalText.zhNext" class="sp-sync__verdict-next">{{ bi(restoreRefusalText.zhNext, restoreRefusalText.enNext ?? '') }}</span>
      <code v-if="restoreRefusal.kind === 'refused' && restoreRefusal.code" class="sp-sync__token">{{ restoreRefusal.code }}</code>
    </p>

    <!-- The row-refresh explanation. It appears only when a row's 刷新 armed this panel, because
         otherwise it is an answer to a question nobody asked. -->
    <p v-if="armedNote" class="sp-sync__armed" data-testid="stock-prep-project-sync-armed" role="status">
      {{ bi(
        '这一行的项目号系统没有保存 —— 表里只留内部编号,不存项目号这类业务值。请在上面填上项目号再同步;同一个项目号再同步一次不会重复写。',
        'The system does not store this row’s project number — the table keeps an internal handle only, never a business value like a project number. Type the number above and sync; syncing the same number again writes nothing twice.',
      ) }}
    </p>

    <!-- 「导进去了吗?」 — one sentence, before any step is read. -->
    <p v-if="report" class="sp-sync__verdict" data-testid="stock-prep-project-sync-verdict" :data-verdict="report.verdict">
      <strong>{{ verdictText }}</strong>
      <!-- The count that makes a partial write actionable: HOW MANY are still missing. It lives here
           rather than inside the plain-language table because only the component has the number. -->
      <strong v-if="verdictCount" class="sp-sync__verdict-count" data-testid="stock-prep-project-sync-verdict-count">
        {{ verdictCount }}
      </strong>
      <span v-if="verdictNext" class="sp-sync__verdict-next">{{ verdictNext }}</span>
      <span class="sp-sync__token">
        OK {{ report.okCount }} · SKIP {{ report.skipCount }} · FAIL {{ report.failCount }}
      </span>
    </p>

    <!-- P0-6: the SAME `stockPrepPosture` word the home card and the workspace title use, fed from
         this run's own report — the third of the "三处同词一致" call sites. -->
    <p
      v-if="report"
      class="sp-sync__posture"
      :class="`sp-sync__posture--${posture.tone}`"
      data-testid="stock-prep-project-sync-posture"
    >
      {{ bi(posture.zh, posture.en) }}
    </p>

    <!-- What the plan found, as a sentence rather than five chips. -->
    <p v-if="report && report.planned" class="sp-sync__counts" data-testid="stock-prep-project-sync-counts">
      {{ countsSentence }}
    </p>
    <!-- ADR §7 (S2): after a project-sheet run, how many rows the sheet holds NOW — re-read from the
         server, bounded, values-free. Absent on the old (switch-off) path and when it could not count. -->
    <p v-if="report && afterRowsText" class="sp-sync__counts" data-testid="stock-prep-project-sync-target-rows">
      {{ afterRowsText }}
    </p>
    <!-- S2 fix round 1 (refuter #1): the project sheet is missing the customer's extension columns
         (dry run / write refused 422 TARGET_SCHEMA_INCOMPLETE on a project sheet). A puller repairs
         it in place — the create route's replay re-installs the pack — and the pull runs again;
         anyone else is told whom to ask. Never shown off a project sheet. -->
    <p v-if="repairAffordance === 'repair'" class="sp-sync__target-notice" data-testid="stock-prep-project-sync-repair">
      <button
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-repair-action"
        :disabled="busy"
        @click="onRepair"
      >{{ bi(targetPlain('repair_action').zh, targetPlain('repair_action').en) }}</button>
    </p>
    <p v-else-if="repairAffordance === 'contact_puller'" class="sp-sync__target-notice" data-testid="stock-prep-project-sync-repair-contact">
      {{ bi(targetPlain('repair_contact_puller').zh, targetPlain('repair_contact_puller').en) }}
    </p>

    <!-- B1 — the add-on's own OPT-IN was refused for THIS caller specifically (403 OPERATOR_SCOPE_*):
         actionable, so it gets a line. `server_unsupported` (this deployment simply does not know the
         request flag yet) is NOT actionable by an operator and renders nothing. -->
    <p
      v-if="report && report.missingComponentsUnavailableReason === 'scope_denied'"
      class="sp-sync__hint"
      data-testid="stock-prep-project-sync-missing-components-unavailable"
    >
      {{ bi(
        '当前账号看不到缺件清单(需操作员权限且账号属于本工厂)',
        'The signed-in account cannot see the missing-components list (needs the stock-prep operator permission and to belong to this tenant)',
      ) }}
    </p>

    <!-- 缺件清单 (W3a) — THE BLOCKING EXPLANATION. Renders when the dry run hit at least one missing
         component — `items.length > 0` is the primary signal; `distinctCount > 0` alone also counts
         (M5: a garbage/unavailable `distinctCount` must not hide a non-empty list). This is not
         "extra detail" the way the technical disclosure below is — it is the answer to "why did the
         whole project not write", so it stays open by default rather than collapsed. -->
    <details
      v-if="report && report.missingComponents && hasMissingComponents(report.missingComponents)"
      class="sp-sync__missing"
      data-testid="stock-prep-project-sync-missing-components"
      open
    >
      <summary
        class="sp-sync__missing-summary"
        :title="bi(missingComponentsTooltip.zh, missingComponentsTooltip.en)"
      >{{ missingComponentsSummary }}</summary>
      <!-- M5: `distinctCount` says "there are some" but the items array itself is empty (a server
           inconsistency, e.g. `{distinctCount:5, items:[]}`) — show the count line above (the
           `<summary>`) and STOP, rather than rendering a table with no rows in it and a copy/export
           pair with nothing to act on. -->
      <div v-if="report.missingComponents.items.length > 0" class="sp-sync__missing-body">
        <table ref="missingComponentsTableEl" class="sp-sync__missing-table">
          <thead>
            <tr>
              <th v-for="header in missingComponentHeaders" :key="header">{{ header }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, idx) in report.missingComponents.items"
              :key="`${item.componentSourceId}-${item.bomId}-${idx}`"
              data-testid="stock-prep-project-sync-missing-components-row"
            >
              <td>{{ item.componentSourceId }}</td>
              <td>{{ missingComponentParentCell(item) }}</td>
              <td>{{ item.bomId }}</td>
              <td>{{ item.depth }}</td>
              <td>{{ item.occurrenceCount }}</td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="report.missingComponents.truncated"
          class="sp-sync__missing-truncated"
          data-testid="stock-prep-project-sync-missing-components-truncated"
        >
          {{ missingComponentsTruncatedNote }}
        </p>
        <div class="sp-sync__missing-actions">
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-missing-components-copy"
            @click="onCopyMissingComponents"
          >
            {{ missingComponentsCopyLabel }}
          </button>
          <button
            type="button"
            class="sp-sync__link"
            data-testid="stock-prep-project-sync-missing-components-export"
            @click="onExportMissingComponents"
          >
            {{ bi('导出 CSV', 'Export CSV') }}
          </button>
        </div>
      </div>
      <!-- I-4 / 线框 D ③ (P0-9): the closure line — there is no "I fixed it" button on this page,
           and saying so out loud is what stops an operator hunting for one.

           OUTSIDE the `items.length > 0` body on purpose. I-4 asks this card for a consequence
           sentence on top and a closure sentence at the bottom, and the M5 degraded shape
           (`{distinctCount: 5, items: []}`) renders the summary and stops — which left that shape with
           a top half and no bottom half. The closure is true in all four shapes: a later sync is what
           clears these rows, whether or not this response could list them. -->
      <p class="sp-sync__missing-resync-hint" data-testid="stock-prep-project-sync-missing-components-resync-hint">
        {{ bi(missingComponentsResyncHint.zh, missingComponentsResyncHint.en) }}
      </p>
    </details>

    <!-- Where to go next. Both are navigation inside this same workbench; neither is a new route. -->
    <div v-if="report" class="sp-sync__next">
      <!-- SHOWN whenever rows are actually in the sheet — which INCLUDES a partial write. Hiding it
           there told an operator to go and not look at data that was sitting in front of them. -->
      <button
        v-if="showsSheetLink"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-multitable"
        :data-fill-target="fillTarget ? 'bound' : 'none'"
        @click="emit('open-multitable')"
      >
        <!-- THE LABEL NAMES THE DESTINATION IT ACTUALLY HAS. With a handle the parent lands the
             operator in the 备料主表 their run just wrote; without one there is no sheet this
             deployment can prove is theirs, and the parent pushes plain `/multitable` — the multitable
             HOME page (「新建 Base」 + template cards), not a workbench. Saying 「打开备料多维表」 (or
             「工作台」) in that second case is the promise that made this button feel broken. -->
        {{ fillTarget
          ? bi('打开备料多维表', 'Open the stock-preparation table')
          : bi('打开多维表首页', 'Open the multitable home') }}
      </button>
      <!-- 客户反馈 2026-10-21 9a: the home page's template cards read as "pick a template for this
           project". Nothing there is the operator's to choose; this sentence says so, beside the
           button, only when the button is the no-handle one. -->
      <p
        v-if="showsSheetLink && !fillTarget"
        class="sp-sync__no-link-hint"
        data-testid="stock-prep-project-sync-no-sheet-link-hint"
      >
        {{ bi(noSheetLinkHint.zh, noSheetLinkHint.en) }}
      </p>
      <!-- PR-7: a SUSPENDED run's work is the puller's holds — the link goes to 「拉取待确认」, PULL tier only. -->
      <button
        v-if="report.verdict === 'suspended' && canOpenRefreshQueue"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-refresh-queue"
        @click="emit('navigate-stage', 'refresh-queue')"
      >
        {{ bi('去「拉取待确认」处理', 'Go to “Pull holds”') }}<template v-if="suspendedHoldCount !== null && suspendedHoldCount > 0"> ({{ suspendedHoldCount }})</template>
      </button>
      <!-- …and never the ledger queue: on a suspended run `pendingConfirmCount` is the plan's manual_confirm tally,
           not anything queued (the reconcile was deferred). -->
      <button
        v-if="report.pendingConfirmCount > 0 && report.verdict !== 'suspended'"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-queue"
        @click="emit('navigate-stage', 'confirmation-queue')"
      >
        {{ bi('去「确认队列」处理', 'Go to the confirmation queue') }}
        ({{ report.queuedDecisionCount > 0 ? report.queuedDecisionCount : report.pendingConfirmCount }})
      </button>
      <button
        v-if="report.steps.some((step) => step.id === 'archive' && step.status === 'ok')"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-diff"
        @click="emit('navigate-stage', 'bom-snapshot-diff')"
      >
        {{ bi('看这次和上一次的差异', 'See what changed since last time') }}
      </button>
    </div>

    <!-- The four steps (P0-3 皮肤: a connected four-step strip rather than a plain list). A SKIP is
         rendered with the same weight as an OK, and its reason is never dropped — hiding it is how the
         outstanding work goes unnoticed. EVERY testid and `data-status` value below is byte-identical
         to before this pass — only the marker/connector chrome around them is new. -->
    <ol class="sp-sync__steps" data-testid="stock-prep-project-sync-steps">
      <li
        v-for="(row, idx) in stepRows"
        :key="row.descriptor.id"
        class="sp-sync__step"
        data-testid="stock-prep-project-sync-step"
        :data-step="row.descriptor.id"
        :data-status="row.status"
      >
        <span class="sp-sync__step-marker" aria-hidden="true">
          <span class="sp-sync__step-icon" :class="`sp-sync__step-icon--${row.status}`">{{ stepIcon(row.status) }}</span>
          <span class="sp-sync__step-index">{{ idx + 1 }}</span>
        </span>
        <span class="sp-sync__step-body">
          <span class="sp-sync__status" :class="`sp-sync__status--${row.status}`">{{ statusLabel(row.status) }}</span>
          <span class="sp-sync__step-name">{{ bi(row.descriptor.zh, row.descriptor.en) }}</span>
          <!-- §4.4 row 6 / 线框 C ②: 第④步 存档 is not the operator's job on this deployment, and
               a bare SKIP reads as "something did not happen" rather than "this one was never
               yours". Rendered only for a caller who cannot run the archive step themselves, so an
               administrator's own view is unchanged. -->
          <span
            v-if="showsNotYoursBadge(row)"
            class="sp-sync__step-badge"
            data-testid="stock-prep-project-sync-step-not-yours"
          >{{ bi(notYoursPosture.zh, notYoursPosture.en) }}</span>
          <template v-if="row.result">
            <small class="sp-sync__reason" data-testid="stock-prep-project-sync-step-reason">{{ reasonText(row.result) }}</small>
            <small v-if="reasonNext(row.result)" class="sp-sync__next-line" data-testid="stock-prep-project-sync-step-next">
              {{ reasonNext(row.result) }}
            </small>
          </template>
          <small v-else class="sp-sync__hint">{{ bi('还没走到这一步', 'Not reached yet') }}</small>
        </span>
      </li>
    </ol>

    <!-- The large-BOM background channel. `:key="submittedProjectNo"` remounts it per run rather
         than reusing one instance across two different large projects. -->
    <StockPreparationLargeBomPullPanel
      v-if="showsLargeBomPull"
      :key="submittedProjectNo"
      :project-no="submittedProjectNo"
      :scope="scope"
      :api="largeBomApi"
      :wait="largeBomPollWait"
      :fill-target="fillTarget"
      :no-link-hint-context="noLinkHintContext"
      @open-multitable="emit('open-multitable')"
      @synced="emit('synced', null)"
    />

    <StockPrepTechnicalDetails v-if="report" testid="stock-prep-project-sync-tech">
      <dl>
        <dt>{{ bi('每一步走的路由、结果码与计数', 'The route, outcome code and counts of each step') }}</dt>
        <dd>
          <ul>
            <li v-for="row in stepRows" :key="row.descriptor.id">
              <code>{{ row.descriptor.id }}</code>
              <code data-testid="stock-prep-project-sync-step-code">{{ row.status.toUpperCase() }}</code>
              <code v-if="row.result">{{ row.result.reason }}</code>
              <div><code>{{ row.descriptor.route }}</code></div>
              <span
                v-for="(value, key) in (row.result ? row.result.detail : {})"
                :key="key"
                class="sp-sync__detail"
                data-testid="stock-prep-project-sync-step-detail"
              >{{ key }}={{ value }}</span>
            </li>
          </ul>
        </dd>
        <dt>{{ bi('这个面板能做什么、不能做什么', 'What this panel can and cannot do') }}</dt>
        <dd>
          {{ bi(
            '只驱动四条已有路由,没有新增任何写入权限:dry-run(read)、reconcile(管理员或一线操作员)、apply(write)、mvp-persist(admin,受部署开关控制)。不向 ERP/K3 写入,不新建物料,不提供 SQL 入口。',
            'Drives four EXISTING routes and adds no new write authority: dry-run (read), reconcile (admin or floor operator), apply (write), mvp-persist (admin, behind a deployment flag). No ERP/K3 write, no material creation, no SQL entry point.',
          ) }}
        </dd>
        <dd>
          {{ bi(
            '开启「一个项目一张备料表」的部署上,同步前先读这个项目的备料表状态(GET …/projects/:projectNo/target);没有表时经您确认由拉取人员新建(POST 同一路径,拉取人员档)。开关关着时这两步都不发生。',
            'On a deployment with "one stock-preparation sheet per project" switched on, the run first reads this project’s sheet state (GET …/projects/:projectNo/target); with no sheet yet, a pull operator creates it after confirming (POST, same path, pull tier). With the switch off neither step happens.',
          ) }}
        </dd>
      </dl>
    </StockPrepTechnicalDetails>
  </section>
</template>

<script setup lang="ts">
// 项目接入 — the owner's spec, made into a control.
//
//   「PLM系统接通后,在页面哪里可点击项目号,然后该项目号里的bom就自动导入到我们的多维表中」
//
// The answer to 「在页面哪里」 is: here, at the top of 项目工作台 — the tab that already answers
// "which projects are in, and how far along are they". Putting the entry on the same screen as the
// already-synced list is what makes the row-level 刷新 mean anything: the input it points at is two
// inches above the row. A separate first tab would have made the operator switch tabs to see the
// result of what they just did.
//
// NO NEW WRITE AUTHORITY. Every call is an existing route with its existing gate; see projectSync.ts.
// The run control renders only for a platform admin because the widest gate among the four is
// platform admin, and R-11 forbids showing a control that would 403.
//
// VALUES-FREE, with ONE deliberate exception: the project number the operator typed. It is their own
// text, echoed back into their own input, and it never comes from a response — the projects read
// route deliberately never serves it. Everything else on this panel is a count, a closed status
// token, an HTTP status or a reason code.
import { copyText } from '../../../utils/clipboard'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import { onAuthPrincipalChange, readAuthSessionSignature } from '../../../composables/authPrincipal'
import type { IntegrationScope } from '../../../services/integration/workbench'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import StockPreparationLargeBomPullPanel from './StockPreparationLargeBomPullPanel.vue'
import {
  STOCK_PREPARATION_DRY_RUN_JOB_POLL_INTERVAL_MS,
  STOCK_PREPARATION_PROJECT_SYNC_STEPS,
  createStockPreparationProjectSyncApi,
  runStockPreparationProjectSync,
  runStockPreparationSettlementCheck,
  type StockPreparationSettlementCheckResult,
  type StockPreparationMissingComponent,
  type StockPreparationMissingComponentList,
  type StockPreparationDryRunOptions,
  type StockPreparationProjectSyncApi,
  type StockPreparationProjectSyncReport,
  type StockPreparationProjectSyncStepResult,
  type StockPreparationProjectSyncStepStatus,
} from '../../../services/integration/stockPreparation/projectSync'
import type { StockPreparationLargeBomJobApi } from '../../../services/integration/stockPreparation/largeBomPull'
import { canRunStockPrepProjectSync } from '../../../services/integration/stockPreparation/workbenchAccess'
import {
  STOCK_PREP_MISSING_COMPONENTS_RESYNC_HINT,
  STOCK_PREP_TOOLTIP_MISSING_COMPONENTS,
  stockPrepErrorPlain,
  stockPrepNoSheetLinkHint,
  stockPrepProjectTargetPlain,
  stockPrepProjectTargetRowCountText,
  stockPrepProjectTargetWritePreviewText,
  stockPrepStepOutcomeText,
  stockPrepSyncReasonPlain,
  stockPrepSyncVerdictPlain,
  type StockPrepNoSheetLinkHintContext,
  type StockPrepPlainEntry,
} from '../../../services/integration/stockPreparation/plainLanguage'
import {
  changeStockPreparationProjectTargetLifecycle,
  createStockPreparationProjectTargetApi,
  repairStockPreparationProjectSheet,
  runStockPreparationProjectPull,
  stockPrepProjectNumbersMatch,
  stockPrepProjectSheetRepairAffordance,
  type StockPrepProjectLifecycleOutcome,
  type StockPrepProjectPullOutcome,
  type StockPrepProjectTargetConfirmRequest,
  type StockPrepProjectTargetState,
  type StockPreparationProjectTargetApi,
} from '../../../services/integration/stockPreparation/projectTarget'
import { downloadCsvFile, escapeTsvCell } from '../../../services/integration/stockPreparation/stockPrepCsv'
import { stockPrepPosture, type StockPrepPosture } from '../../../services/integration/stockPreparation/projectPosture'
import type { StockPreparationFillTarget } from '../../../services/integration/stockPreparation/projectBoard'
import { STOCK_PREP_REFRESH_STATUS_LABELS_ZH } from '../../../services/integration/stockPreparation/refreshState'

const props = withDefaults(
  defineProps<{
    /**
     * Whether this panel's own run button may wear the filled primary treatment. The workspace hands
     * it `secondary` whenever its 「下一步」 bar is showing a button, so the two never appear as two
     * competing primaries on one screen (G1). Default `primary` keeps every other mount — the legacy
     * project workspace tab included — exactly as it was.
     */
    runEmphasis?: 'primary' | 'secondary'
    scope?: IntegrationScope
    /**
     * Bumped by the parent when a row's 刷新 is pressed. A COUNTER rather than a boolean so pressing
     * refresh twice re-focuses the input both times.
     */
    armedAt?: number
    /**
     * 项目备料页: the project this panel is already scoped to, so an operator who opened a board does
     * not retype a number the page is already about.
     *
     * A SEED, NOT A LOCK. The input stays editable — the panel's own 项目接入 use on the legacy tab
     * has no seed at all, and a locked field would take away the "sync a different project from
     * here" path that surface relies on. The seed follows the prop, and a later prop change
     * (the operator opened a different board) replaces what the seed put there — but never what the
     * operator typed over it while a run was in flight.
     */
    projectNo?: string
    /**
     * Test seam ONLY: an injected API double. Production always builds its own from `scope`, so a
     * component mounted without this prop cannot be pointed at a different endpoint.
     */
    api?: StockPreparationProjectSyncApi | null
    /** Test seam ONLY — forwarded to StockPreparationLargeBomPullPanel. */
    largeBomApi?: StockPreparationLargeBomJobApi | null
    /** Test seam ONLY — forwarded to StockPreparationLargeBomPullPanel so specs never wait on a real timer. */
    largeBomPollWait?: ((ms: number) => Promise<void>) | null
    /** Test seam ONLY (R67 ④) — the background dry run's poll wait, so specs never wait on a real timer. */
    dryRunPollWait?: ((ms: number) => Promise<void>) | null
    /**
     * H14 — WHAT THIS BUTTON IS CALLED ON THE SURFACE THAT HOSTS IT.
     *
     * One button, two vocabularies, because it genuinely sits on two surfaces with two audiences.
     * The admin surfaces (项目接入, 数据来源) have called this 「同步这个项目」 since it shipped, and
     * their own copy references that name in four places. 项目备料页 is the OPERATOR's page and its
     * whole framing is the four steps 从 PLM 拉取 / 通知下一步 / 导出 Excel / 到多维表填写 — its empty
     * state already tells a person to press 「从PLM拉取数据」.
     *
     * Which was a lie until now: the button underneath said 同步这个项目. A page that names a control
     * by a name the control does not have is a dead end pointing at something visible, which is the
     * worst kind — the operator reads the sentence, looks down, sees no such button, and stops. So
     * the label is a prop, the board passes its own, and neither surface has to adopt the other's
     * word. The repeat-safety promise rides along with whichever name is used, because it is true of
     * the button and not of the word.
     */
    runVariant?: 'sync' | 'pull'
    /**
     * The 备料主表 deep-link handle, or null. THE PANEL NEVER FETCHES IT and never composes a route:
     * both mount points (项目备料页's board and the shell's 项目工作台 tab) already hold the read it
     * comes from, and routing belongs to whoever owns the router. All this prop decides is which
     * of the two true sentences the button says about where the click will land.
     */
    fillTarget?: StockPreparationFillTarget | null
    /**
     * Test seam ONLY (S2): an injected project-target client. Production builds its own from
     * `scope` — EXCEPT when a sync-API double is injected without one: a mount that injects the run's
     * client controls the whole pipeline, so it gets no extra request it did not ask for (every
     * pre-S2 suite keeps its exact request set). No production mount injects either.
     */
    targetApi?: StockPreparationProjectTargetApi | null
    /**
     * Where this panel is mounted, for the no-link sentence only (review round 1 of 客户反馈 9a).
     * `board` = 项目备料, whose own fill area further down explains the missing link; `workspace` =
     * 项目工作台, which points the reader at 项目备料. Copy only — nothing routes on it.
     */
    noLinkHintContext?: StockPrepNoSheetLinkHintContext
    /**
     * 备料分批拉取第一期 step 4 PR-7 — the board's refresh stanza, as values-free inputs (项目备料页 passes them; the
     * legacy 项目工作台 mount passes none). `refreshStatus` + `refreshSettled` decide whether 「核对」 is offered
     * (executed_pending_settlement, or complete ∧ NOT settled — never `exportAllowed`); after a check they are
     * also the ONLY authority for 「核对通过」 — this panel never claims it from its own counts.
     */
    refreshStatus?: string | null
    refreshSettled?: boolean
    /** Whether the viewer may open 「拉取待确认」 (PULL tier exactly) — the suspended run's link renders only then. */
    canOpenRefreshQueue?: boolean
  }>(),  {
    runEmphasis: 'primary',
    scope: () => ({}),
    armedAt: 0,
    projectNo: '',
    api: null,
    largeBomApi: null,
    largeBomPollWait: null,
    dryRunPollWait: null,
    runVariant: 'sync',
    fillTarget: null,
    targetApi: null,
    noLinkHintContext: 'workspace',
    refreshStatus: null,
    refreshSettled: false,
    canOpenRefreshQueue: false,
  },
)

const noSheetLinkHint = computed(() => stockPrepNoSheetLinkHint(props.noLinkHintContext))

const emit = defineEmits<{
  /** Reuses the shell's ONE tab-nav surface (the same event the dashboard's stepper emits). */
  (e: 'navigate-stage', viewKey: string): void
  /** "Open the multitable" — the parent owns routing; this panel composes no route. */
  (e: 'open-multitable'): void
  /**
   * Fired after a run settles so the parent can re-read the project overview. P0-3: carries this
   * run's own report so the workspace's "下一步" bar (operatorNextStep.ts) can read
   * `missingComponents`/`verdict` without a second copy of this panel's state living in the parent.
   * `null` from the large-BOM background channel, ALWAYS. That channel finishes long after the run
   * that spawned it, and `report` by then is the trial run that ended in a `large_bom_bounded` SKIP —
   * forwarding it would drive the parent's 「下一步」 bar and badge off a snapshot the apply has since
   * superseded. `null` means "re-read the board, I have no fresher verdict for you", which is exactly
   * true. Existing listeners that take no argument (StockPreparationProjectWorkspaceView.vue's
   * `@synced="load"`) are unaffected: Vue drops an argument a handler declares no parameter for.
   */
  (e: 'synced', report: StockPreparationProjectSyncReport | null): void
  /** P0-3: whether a run is in flight right now — lets the workspace title badge show 🔵正在跑. */
  (e: 'busy-changed', busy: boolean): void
  /**
   * S2: the project's sheet as this run last read it (after a create or a re-pull), so 项目备料页 can
   * refresh its own sheet-state line without a second read. Never fired on the switch-off path.
   */
  (e: 'project-target-changed', state: StockPrepProjectTargetState | null): void
}>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const canRun = computed(() => canRunStockPrepProjectSync(auth.getAccessSnapshot()))

/** See `runVariant`. Tuples so the template can spread them straight into `bi`. */
const runLabel = computed<[string, string]>(() => (props.runVariant === 'pull'
  ? ['从PLM拉取数据(可以重复点,不会重复写)', 'Pull data from PLM (safe to repeat — it never writes twice)']
  : ['同步这个项目(可以重复点,不会重复写)', 'Sync this project (safe to repeat — it never writes twice)']))

const runningLabel = computed<[string, string]>(() => (props.runVariant === 'pull'
  ? ['正在拉取…', 'Pulling…']
  : ['正在同步…', 'Syncing…']))

const projectNo = ref(props.projectNo ?? '')
const busy = ref(false)
const armedNote = ref(false)
const results = ref<StockPreparationProjectSyncStepResult[]>([])
const report = ref<StockPreparationProjectSyncReport | null>(null)
const projectNoEl = ref<HTMLInputElement | null>(null)
/**
 * The project number a run actually submitted — frozen at the moment 试算 fires, decoupled from the
 * live `projectNo` input. The large-BOM sub-panel below can run for a while, and the operator is
 * free to keep editing the field for their NEXT sync while it does; feeding it the live ref would
 * point the background channel at whatever they typed most recently instead of what this run planned.
 */
const submittedProjectNo = ref('')

/** The `<table>` DOM node the 缺件清单 "复制" button selects into when the Clipboard API is unavailable. */
const missingComponentsTableEl = ref<HTMLTableElement | null>(null)

/** Idle → the button's default label. Reset on every new run so a stale "已复制" never survives it. */
const missingComponentsCopyState = ref<'idle' | 'copied' | 'manual'>('idle')

const canSubmit = computed(() => canRun.value && !busy.value && projectNo.value.trim().length > 0)

// 项目备料页: follow the seed when the PARENT changes which project this panel is about. It never
// runs anything on its own — the operator still presses 同步 — and it never fires while a run is in
// flight, so a number the operator typed for their next sync is not overwritten mid-run.
watch(() => props.projectNo, (next) => {
  const seeded = (next ?? '').trim()
  if (!seeded || busy.value) return
  projectNo.value = seeded
  // R67 ④: a different project may have its own trial still running.
  dryRunProgress.value = null
  void watchRunningDryRun()
})

// A row's 刷新 arms this panel: it explains why the number has to be typed and puts the cursor in the
// field. It deliberately does NOT run anything — the panel cannot know which project a values-free
// row is, and guessing would sync the wrong project.
watch(() => props.armedAt, async (next, previous) => {
  if (typeof next !== 'number' || next === previous || next === 0) return
  armedNote.value = true
  await nextTick()
  projectNoEl.value?.focus()
})

// ── 一个项目一张备料表 (S2, R-36) — the project-sheet half of a run ─────────────────────────────────
//
// `runStockPreparationProjectPull` (projectTarget.ts) decides the order; this panel only renders the
// question it asks and the way it ended. With the server's switch off the probe answers DISABLED and
// the run below is the pre-S2 run, unchanged.

interface TargetPrompt {
  request: StockPrepProjectTargetConfirmRequest
  resolve: (answer: boolean) => void
}
const targetPrompt = ref<TargetPrompt | null>(null)
type TargetNotice = Exclude<StockPrepProjectPullOutcome, { kind: 'synced' }>
const targetNotice = ref<TargetNotice | null>(null)
/** The sheet as re-read after a project-sheet run (counts for the result line). */
const afterState = ref<StockPrepProjectTargetState | null>(null)

function targetPlain(id: string): StockPrepPlainEntry {
  return stockPrepProjectTargetPlain(id) ?? { zh: id, en: id }
}

function resolveTargetApi(): StockPreparationProjectTargetApi | null {
  if (props.targetApi) return props.targetApi
  // See the prop's comment: an injected sync double owns the pipeline.
  if (props.api) return null
  return createStockPreparationProjectTargetApi(props.scope)
}

/** Ask, and wait for one of the prompt's two buttons. */
function askOperator(request: StockPrepProjectTargetConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    targetPrompt.value = { request, resolve }
  })
}

function answerTargetPrompt(answer: boolean): void {
  const prompt = targetPrompt.value
  targetPrompt.value = null
  prompt?.resolve(answer)
}

// #3365「卸载即作废」: a question nobody can answer any more is a no, never a hang.
onUnmounted(() => {
  if (targetPrompt.value) answerTargetPrompt(false)
})

const promptRowsText = computed<string>(() => {
  const request = targetPrompt.value?.request
  if (!request || request.kind !== 'repull') return ''
  const text = stockPrepProjectTargetRowCountText(request)
  return text ? `${bi(text.zh, text.en)}${bi('。', '. ')}` : ''
})

const promptPreviewText = computed<string>(() => {
  const request = targetPrompt.value?.request
  if (!request || request.kind !== 'write') return ''
  const text = stockPrepProjectTargetWritePreviewText(request.planned)
  return bi(text.zh, text.en)
})

const targetNoticeText = computed<StockPrepPlainEntry>(() => {
  const notice = targetNotice.value
  if (!notice) return { zh: '', en: '' }
  if (notice.kind === 'cancelled') return targetPlain(notice.stage === 'create' ? 'cancelled_create' : 'cancelled_repull')
  if (notice.kind === 'contact_puller') return targetPlain('contact_puller_create')
  if (notice.kind === 'archived') {
    const status = targetPlain('status_archived')
    const next = targetPlain(notice.mayRestore ? 'restore_pending' : 'contact_puller_restore')
    return { zh: status.zh, en: status.en, zhNext: next.zh, enNext: next.en }
  }
  if (notice.kind === 'probe_failed') return targetPlain('probe_failed')
  return stockPrepErrorPlain(notice.code ?? '')
})

/** Whether the last run went through the project-sheet flow (switch on, the project's own sheet). */
const lastRunOnProjectSheet = ref(false)

/** S2 fix round 1: repair the project sheet (puller) / say whom to ask (anyone else) / nothing. */
const repairAffordance = computed(() => stockPrepProjectSheetRepairAffordance(report.value, {
  projectSheet: lastRunOnProjectSheet.value,
  canPull: canRun.value,
}))

// ── R67 ④ — 试算 in the background ────────────────────────────────────────────────────────────────
//
// The run's dry-run step is an enqueue + poll (projectSync.ts). This panel shows its progress and
// owns the one thing a page can decide about it: when to stop LOOKING. Unmounting aborts the poll —
// the job itself keeps running on the server — and a later mount for the same project (a reload, a
// tab switch) asks whether this caller's trial is still running and shows it again. A press while it
// is still running attaches to it rather than reading PLM a second time.

interface DryRunProgressState {
  elapsedMs: number
  /** `run`: this press's own job; `attached`: this press picked up a running one; `resumed`: seen on mount. */
  source: 'run' | 'attached' | 'resumed'
}
const dryRunProgress = ref<DryRunProgressState | null>(null)
let dryRunAbort: AbortController | null = null
/** Bumped on every run and every unmount, so a re-attach probe that is still in flight lets go. */
let dryRunWatchEpoch = 0

function minutesSeconds(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const dryRunProgressText = computed<string>(() => {
  const progress = dryRunProgress.value
  if (!progress) return ''
  const elapsed = minutesSeconds(progress.elapsedMs)
  if (progress.source === 'resumed') {
    return bi(
      `这个项目上次的试算还在后台读取 PLM(已用 ${elapsed})。再点一次会接着等它的结果,不会重复读取。`,
      `This project's earlier trial is still reading PLM in the background (${elapsed} so far). Pressing again picks up its result instead of reading PLM twice.`,
    )
  }
  return bi(
    `正在后台试算,读取 PLM 中(已用 ${elapsed})。PLM 慢时会多等一会儿;离开本页不会中断,回来后会接着显示。`,
    `Running the trial in the background — reading PLM (${elapsed} so far). A slow PLM just takes longer; leaving this page does not stop it, and the progress shows again when you return.`,
  )
})

function dryRunOptions(): StockPreparationDryRunOptions {
  dryRunAbort?.abort()
  dryRunAbort = new AbortController()
  return {
    signal: dryRunAbort.signal,
    ...(props.dryRunPollWait ? { wait: props.dryRunPollWait } : {}),
    onProgress: (progress) => {
      dryRunProgress.value = { elapsedMs: progress.elapsedMs, source: progress.attached ? 'attached' : 'run' }
    },
  }
}

/** Re-attach: is this caller's trial of the seeded project still running? Shown, never re-run. */
async function watchRunningDryRun(): Promise<void> {
  const target = projectNo.value.trim()
  if (!target || busy.value || !canRun.value) return
  const api = props.api ?? createStockPreparationProjectSyncApi(props.scope)
  if (typeof api.dryRunJobStatus !== 'function') return
  const epoch = ++dryRunWatchEpoch
  for (;;) {
    let job
    try {
      job = await api.dryRunJobStatus(target)
    } catch {
      job = null
    }
    if (epoch !== dryRunWatchEpoch || busy.value) return
    if (!job || job.status !== 'running') {
      if (dryRunProgress.value?.source === 'resumed') dryRunProgress.value = null
      return
    }
    dryRunProgress.value = { elapsedMs: job.elapsedMs, source: 'resumed' }
    await (props.dryRunPollWait
      ? props.dryRunPollWait(STOCK_PREPARATION_DRY_RUN_JOB_POLL_INTERVAL_MS)
      : new Promise<void>((resolve) => { setTimeout(resolve, STOCK_PREPARATION_DRY_RUN_JOB_POLL_INTERVAL_MS) }))
    if (epoch !== dryRunWatchEpoch || busy.value) return
  }
}

onMounted(() => { void watchRunningDryRun() })
onUnmounted(() => {
  dryRunWatchEpoch += 1
  dryRunAbort?.abort()
  dryRunAbort = null
})

function syncRunner(api: StockPreparationProjectSyncApi, target: string) {
  dryRunWatchEpoch += 1
  return (hooks: Parameters<typeof runStockPreparationProjectSync>[3]) => runStockPreparationProjectSync(api, target, (step) => {
    // Render each step AS IT LANDS: a run that stops at the plan must still show the plan's counts.
    if (step.id === 'dry-run') dryRunProgress.value = null
    results.value = [...results.value, step]
  }, { ...hooks, dryRun: dryRunOptions() })
}

/** One way a run ends, whichever entry (run / repair) started it. */
function applyPullOutcome(outcome: StockPrepProjectPullOutcome): void {
  if (outcome.kind !== 'synced') {
    targetNotice.value = outcome
    return
  }
  report.value = outcome.report
  afterState.value = outcome.after
  lastRunOnProjectSheet.value = outcome.mode !== 'legacy'
  armedNote.value = false
  if (outcome.mode !== 'legacy') emit('project-target-changed', outcome.after)
  emit('synced', report.value)
}

function resetRunState(): void {
  results.value = []
  report.value = null
  targetNotice.value = null
  afterState.value = null
  lastRunOnProjectSheet.value = false
  missingComponentsCopyState.value = 'idle'
  restorePrompt.value = false
  restoreTyped.value = ''
  restoreRefusal.value = null
}

// ── S4 (R-38) — 「恢复并重新拉取」 ───────────────────────────────────────────────────────────────────
const restorePrompt = ref(false)
const restoreTyped = ref('')
const restoreRefusal = ref<Exclude<StockPrepProjectLifecycleOutcome, { kind: 'done' }> | null>(null)
const restoreTypedMatches = computed<boolean>(() => stockPrepProjectNumbersMatch(submittedProjectNo.value, restoreTyped.value))

function openRestorePrompt(): void {
  restorePrompt.value = true
  restoreTyped.value = ''
  restoreRefusal.value = null
}

function closeRestorePrompt(): void {
  restorePrompt.value = false
  restoreTyped.value = ''
}

const restoreRefusalText = computed<StockPrepPlainEntry>(() => {
  const refusal = restoreRefusal.value
  if (!refusal) return { zh: '', en: '' }
  if (refusal.kind === 'mismatch') return stockPrepErrorPlain('STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH')
  if (refusal.kind === 'contact_puller') return targetPlain('contact_puller_restore')
  return stockPrepErrorPlain(refusal.code ?? '')
})

/** RESTORE, then this same pull again — the restored sheet is active, so the run asks 「重新拉取」. */
async function onRestoreAndRepull(): Promise<void> {
  const target = submittedProjectNo.value
  if (!target || busy.value || !canRun.value) return
  busy.value = true
  let outcome: StockPrepProjectLifecycleOutcome
  try {
    outcome = await changeStockPreparationProjectTargetLifecycle({ targetApi: resolveTargetApi(), canPull: canRun.value }, 'restore', target, restoreTyped.value)
  } finally {
    busy.value = false
  }
  if (outcome.kind !== 'done') {
    restoreRefusal.value = outcome
    return
  }
  closeRestorePrompt()
  emit('project-target-changed', outcome.state)
  projectNo.value = target
  await onRun()
}

const afterRowsText = computed<string>(() => {
  const state = afterState.value
  if (!state) return ''
  const text = stockPrepProjectTargetRowCountText(state)
  return text ? `${bi(text.zh, text.en)}${bi('。', '.')}` : ''
})

async function onRun(): Promise<void> {
  if (!canSubmit.value) return
  const target = projectNo.value.trim()
  submittedProjectNo.value = target
  resetRunState()
  busy.value = true
  try {
    const api = props.api ?? createStockPreparationProjectSyncApi(props.scope)
    applyPullOutcome(await runStockPreparationProjectPull({
      targetApi: resolveTargetApi(),
      canPull: canRun.value,
      confirm: askOperator,
      runSync: syncRunner(api, target),
    }, target))
  } finally {
    targetPrompt.value = null
    dryRunProgress.value = null
    busy.value = false
  }
}

/** 「修复项目表（重装客户包）」: the create route's replay heals the pack, then the four steps again. */
async function onRepair(): Promise<void> {
  const target = submittedProjectNo.value
  if (!target || busy.value || !canRun.value) return
  resetRunState()
  busy.value = true
  try {
    const api = props.api ?? createStockPreparationProjectSyncApi(props.scope)
    applyPullOutcome(await repairStockPreparationProjectSheet({
      targetApi: resolveTargetApi(),
      canPull: canRun.value,
      runSync: syncRunner(api, target),
    }, target))
  } finally {
    dryRunProgress.value = null
    busy.value = false
  }
}

/** P0-3: the workspace title badge's only window into "a run is happening right now". */
watch(busy, (value) => emit('busy-changed', value))

// ── 备料分批拉取第一期 step 4 PR-7 — 「核对」 (design §9.2; R-62 ⑦) ─────────────────────────────────────
//
// ONE preview, nothing else (projectSync.ts `runStockPreparationSettlementCheck`): a clean computation after the
// newest execution settles the project server-side. NOT a fifth step — the four-step list is untouched. Offered
// only to a caller who may run the pull, and only while the board's stanza says the project is written but not
// checked. THE CLIENT NEVER CLAIMS 「核对通过」 FROM ITS OWN COUNTS: after the check it emits `synced(null)` so the
// board re-reads its stanza, and only that re-read (`refreshStatus` / `refreshSettled` moving) may say so.

const showsCheck = computed<boolean>(() => {
  if (!canRun.value) return false
  const status = props.refreshStatus
  return status === 'executed_pending_settlement' || (status === 'complete' && props.refreshSettled !== true)
})
const checkBusy = ref(false)
const checkResult = ref<StockPreparationSettlementCheckResult | null>(null)
/** `submitted` until the board's stanza moves after the check; then `answered` (its own label is shown). */
const checkPhase = ref<'idle' | 'submitted' | 'answered'>('idle')

watch(() => [props.refreshStatus, props.refreshSettled] as const, () => {
  if (checkPhase.value === 'submitted') checkPhase.value = 'answered'
})
// A CHECK ANSWER BELONGS TO THE PROJECT, SCOPE AND SESSION IT WAS ASKED FOR (#6324 review N1). The check can read
// PLM for minutes; meanwhile the board may open another project, the scope may move, or another principal may take
// the browser session. `clearCheck` bumps a generation on each of those (and on unmount), and a late answer whose
// generation or session no longer matches is DROPPED: no result line (「核对发现还有 N 处要写入…」 on the wrong
// project) and no `synced(null)`. The session is compared by value at landing as well, because another tab
// replacing the token notifies nobody (authPrincipal.ts `onAuthPrincipalChange`).
let checkGeneration = 0
let checkMounted = true
function clearCheck(): void {
  checkGeneration += 1
  checkResult.value = null
  checkPhase.value = 'idle'
}
function readCheckSessionSignature(): string {
  try {
    const session = readAuthSessionSignature()
    if (session === 'invalid') return 'invalid'
    // A focus refresh can replace the access snapshot without rotating the token.
    return JSON.stringify([session, localStorage.getItem('user_permissions'), localStorage.getItem('user_roles')])
  } catch {
    return 'invalid'
  }
}
watch([() => props.projectNo, () => props.scope.tenantId, () => props.scope.workspaceId], clearCheck, { flush: 'sync' })
const unsubscribeCheckSession = onAuthPrincipalChange(clearCheck)
onUnmounted(() => {
  checkMounted = false
  clearCheck()
  unsubscribeCheckSession()
})

async function runSettlementCheck(): Promise<void> {
  if (!showsCheck.value || busy.value || checkBusy.value) return
  const target = (props.projectNo || projectNo.value).trim()
  if (!target) return
  clearCheck()
  const generation = checkGeneration
  const session = readCheckSessionSignature()
  checkBusy.value = true
  busy.value = true
  let result: StockPreparationSettlementCheckResult | null = null
  try {
    const api = props.api ?? createStockPreparationProjectSyncApi(props.scope)
    result = await runStockPreparationSettlementCheck(api, target, { dryRun: dryRunOptions() })
  } finally {
    dryRunProgress.value = null
    busy.value = false
    checkBusy.value = false
  }
  if (!checkMounted || generation !== checkGeneration || session === 'invalid' || session !== readCheckSessionSignature()) return
  checkResult.value = result
  checkPhase.value = 'submitted'
  // The board re-reads its stanza; that re-read is the authority (see above).
  emit('synced', null)
}

const checkLine = computed<{ text: string; next: string } | null>(() => {
  const result = checkResult.value
  if (!result) return null
  if (result.outcome === 'settled') {
    if (checkPhase.value !== 'answered') {
      return { text: bi('核对已提交:这次试算没有要写入的地方。', 'Check submitted: this preview planned nothing to write.'), next: bi('正在等项目备料页重新读取状态。', 'Waiting for the project page to re-read its state.') }
    }
    if (props.refreshStatus === 'complete' && props.refreshSettled === true) {
      return { text: bi('核对通过:本项目分批拉取状态为「已完成」,可以正式导出。', 'Check passed: this project’s batch refresh reads “complete”; the formal export is open.'), next: '' }
    }
    const label = stockPrepRefreshStatusLabel(props.refreshStatus)
    return {
      text: bi(`核对已提交;本项目分批拉取状态:${label.zh}。`, `Check submitted; this project’s batch refresh now reads: ${label.en}.`),
      next: bi('看上面的分批拉取提示。', 'See the batch-refresh note above.'),
    }
  }
  if (result.outcome === 'changes_pending') {
    const planned = result.planned
    const n = planned ? planned.add + planned.update + planned.inactive : 0
    return { text: bi(`核对发现还有 ${n} 处要写入,请再同步一次。`, `The check found ${n} change(s) still to write; sync again.`), next: '' }
  }
  if (result.outcome === 'suspended') {
    const plain = stockPrepSyncVerdictPlain('suspended')
    return { text: plain ? bi(plain.zh, plain.en) : '', next: plain ? bi(plain.zhNext ?? '', plain.enNext ?? '') : '' }
  }
  if (result.outcome === 'awaiting_recovery') {
    const plain = stockPrepSyncVerdictPlain('awaiting_recovery')
    return { text: plain ? bi(plain.zh, plain.en) : '', next: plain ? bi(plain.zhNext ?? '', plain.enNext ?? '') : '' }
  }
  const plain = stockPrepSyncReasonPlain(result.reason)
  return {
    text: plain ? bi(plain.zh, plain.en) : bi('核对没有完成。', 'The check did not complete.'),
    next: plain ? bi(plain.zhNext ?? '', plain.enNext ?? '') : '',
  }
})

function stockPrepRefreshStatusLabel(status: string | null | undefined): { zh: string; en: string } {
  // A complete-but-unsettled project is 「待核对」, never 「已完成」 (the posture's own word — #6566 review N5).
  if (status === 'complete') return { zh: '待核对', en: 'awaiting check' }
  const zh = typeof status === 'string' && Object.prototype.hasOwnProperty.call(STOCK_PREP_REFRESH_STATUS_LABELS_ZH, status)
    ? STOCK_PREP_REFRESH_STATUS_LABELS_ZH[status as keyof typeof STOCK_PREP_REFRESH_STATUS_LABELS_ZH]
    : STOCK_PREP_REFRESH_STATUS_LABELS_ZH.unreadable
  return { zh, en: typeof status === 'string' ? status : 'unreadable' }
}

/** The suspended run's holds, from the report (values-free integer), or null. */
const suspendedHoldCount = computed<number | null>(() => {
  const value = report.value
  if (!value || value.verdict !== 'suspended') return null
  return value.refresh?.holdCount ?? null
})

/**
 * P0-3: lets the workspace's "下一步" bar re-run THIS SAME sync (再同步一次 / go-back-and-resync) —
 * without this the parent would need its own second copy of `onRun`'s logic to drive a resync, and
 * two copies is how the two eventually disagree about what "同步" does. PR-7: and the bar's 「核对」.
 */
defineExpose({ run: onRun, runSettlementCheck })

/** Every planned step, with its result once it has one. Steps not reached are still listed. */
const stepRows = computed(() => STOCK_PREPARATION_PROJECT_SYNC_STEPS.map((descriptor) => {
  const found = results.value.find((entry) => entry.id === descriptor.id) ?? null
  return {
    descriptor,
    result: found,
    status: (found ? found.status : 'pending') as StockPreparationProjectSyncStepStatus,
  }
}))

function statusLabel(status: StockPreparationProjectSyncStepStatus): string {
  const text = stockPrepStepOutcomeText(status)
  return bi(text.zh, text.en)
}

/**
 * §4.4 row 6 (⊘ 不归您做) wired to the one place it applies: the archive step, when the server
 * itself said this caller may not run it.
 *
 * DRIVEN BY THE RUN'S OWN REASON, not by a permission check re-done in the browser.
 * `BATCH_ARCHIVE_NOT_PERMITTED` is emitted by `projectSync.ts` for exactly this case — archiving is
 * `mvp-persist`, a platform-admin surface, so an operator who CAN pull still cannot archive — and it
 * is the difference between "something did not happen" and "this one was never yours". Reading it
 * off the result means an administrator, for whom the step really does run, never sees the badge,
 * and nobody is told a step is not theirs on a deployment where it is. The step's own `data-status`
 * is untouched: this is an explanation beside it, not a new status.
 */
const notYoursPosture = stockPrepPosture({ notYours: true })

function showsNotYoursBadge(row: { descriptor: { id: string }; result: StockPreparationProjectSyncStepResult | null }): boolean {
  return row.descriptor.id === 'archive' && row.result?.reason === 'BATCH_ARCHIVE_NOT_PERMITTED'
}

/** P0-3 皮肤: purely decorative (aria-hidden — `statusLabel` above still carries the accessible text). */
function stepIcon(status: StockPreparationProjectSyncStepStatus): string {
  if (status === 'ok') return '✔'
  if (status === 'skip') return '●'
  if (status === 'fail') return '✖'
  return '○'
}

function reasonText(result: StockPreparationProjectSyncStepResult): string {
  const plain = stockPrepSyncReasonPlain(result.reason)
  // Fails soft, like every other lookup in plainLanguage.ts: a reason added later renders as its own
  // code rather than blanking the line.
  return plain ? bi(plain.zh, plain.en) : result.reason
}

function reasonNext(result: StockPreparationProjectSyncStepResult): string {
  const plain = stockPrepSyncReasonPlain(result.reason)
  if (!plain) return ''
  return bi(plain.zhNext ?? '', plain.enNext ?? '')
}

const verdictText = computed<string>(() => {
  const plain = report.value ? stockPrepSyncVerdictPlain(report.value.verdict) : null
  return plain ? bi(plain.zh, plain.en) : ''
})

const verdictNext = computed<string>(() => {
  const plain = report.value ? stockPrepSyncVerdictPlain(report.value.verdict) : null
  if (!plain) return ''
  return bi(plain.zhNext ?? '', plain.enNext ?? '')
})

/** The one verdict that needs a number in its headline: how many rows are still missing. PR-7: and how many holds. */
const verdictCount = computed<string>(() => {
  const value = report.value
  if (value && value.verdict === 'suspended') {
    const holds = suspendedHoldCount.value
    return holds !== null && holds > 0 ? bi(`有 ${holds} 项待拉取人员确认。`, `${holds} item(s) await the puller’s confirmation.`) : ''
  }
  if (!value || value.verdict !== 'partial') return ''
  const failedRows = value.written?.failed ?? 0
  if (failedRows <= 0) return ''
  return bi(`还有 ${failedRows} 行没有写成。`, `${failedRows} rows did not write.`)
})

/**
 * Whether "open the multitable" renders. The test is ROWS ARE IN THE SHEET, not "the run was tidy":
 * a partial write put rows there, and `already_up_to_date` means the rows were there all along.
 */
const showsSheetLink = computed<boolean>(() => {
  const verdict = report.value?.verdict
  return verdict === 'imported' || verdict === 'already_up_to_date' || verdict === 'partial'
})

/**
 * P0-6: this run's own posture, fed to the SAME `stockPrepPosture` the home card and the workspace
 * title read. `pendingDecisionCount` prefers `queuedDecisionCount` (reconcile's real ledger count)
 * over `pendingConfirmCount` (the plan's own manualConfirm tally) — the identical precedence the
 * 「去确认队列」 link's own label already uses just below, so the two never disagree about which
 * number is the true one.
 */
const posture = computed<StockPrepPosture>(() => {
  const value = report.value
  if (!value) return stockPrepPosture({})
  // PR-7: a suspended / awaiting-recovery run speaks the refresh posture's own words (待确认 N 件 / 上次写入未完成),
  // the SAME function the board's title reads — never 「等您拿主意」 over a puller's holds.
  if (value.verdict === 'suspended') {
    return stockPrepPosture({ busy: busy.value, refreshStatus: 'pending_confirmation', refreshPendingConfirmCount: value.refresh?.holdCount ?? 0 })
  }
  if (value.verdict === 'awaiting_recovery') {
    return stockPrepPosture({ busy: busy.value, refreshStatus: 'failed_pending_recovery' })
  }
  const pendingDecisionCount = value.queuedDecisionCount > 0 ? value.queuedDecisionCount : value.pendingConfirmCount
  const missingList = value.missingComponents
  const missingComponentsCount = missingList && hasMissingComponents(missingList) ? effectiveDistinctCount(missingList) : 0
  return stockPrepPosture({
    busy: busy.value,
    pendingDecisionCount,
    missingComponentsCount,
    pulledRowCount: showsSheetLink.value ? 1 : 0,
  })
})

/**
 * The audit's second dead-end: a `large_bom_bounded` SKIP used to be the end of the story — no link,
 * no progress, no completion signal. Mounted ONLY on that exact reason, so the sub-panel's own
 * `onMounted` (which starts the background channel immediately) never fires for any other SKIP.
 */
const showsLargeBomPull = computed<boolean>(() => {
  const planStep = report.value?.steps.find((step) => step.id === 'dry-run')
  return planStep?.reason === 'PLAN_LARGE_BOM_BOUNDED'
})

/**
 * The plan's five numbers as ONE sentence. The clauses that are zero are dropped — "新增 0 行,更新 0
 * 行,跳过 12 行" makes a reader hunt for the number that matters.
 */
const countsSentence = computed<string>(() => {
  const planned = report.value?.planned
  if (!planned) return ''
  const parts: string[] = []
  if (planned.add > 0) parts.push(bi(`新增 ${planned.add} 行`, `${planned.add} rows added`))
  if (planned.update > 0) parts.push(bi(`更新 ${planned.update} 行`, `${planned.update} rows updated`))
  if (planned.skip > 0) parts.push(bi(`${planned.skip} 行已经是最新的`, `${planned.skip} rows already current`))
  if (planned.inactive > 0) parts.push(bi(`${planned.inactive} 行在源头没有了`, `${planned.inactive} rows gone from the source`))
  if (planned.manualConfirm > 0) {
    parts.push(bi(`${planned.manualConfirm} 行需要人工确认`, `${planned.manualConfirm} rows need a person to confirm`))
  }
  if (parts.length === 0) return bi('这次试算没有需要改动的行。', 'The plan found nothing to change.')
  return bi(`这次试算:${parts.join('、')}。`, `This plan: ${parts.join(', ')}.`)
})

// ---------------------------------------------------------------------------
// 缺件清单 (W3a) — the ONE place on this panel that renders a business value (a customer part number)
// straight from a response. Everything below is presentation over `report.missingComponents`, which
// `missingComponentsOf` in projectSync.ts already strict-clamped at the API boundary.
// ---------------------------------------------------------------------------

/** On-screen columns: parent gets the "(+N 处)" badge folded in — see `missingComponentParentCell`. */
const missingComponentHeaders = computed<string[]>(() => [
  bi('零件号', 'Component'),
  bi('父件', 'Parent'),
  bi('所在 BOM', 'BOM'),
  bi('层级', 'Depth'),
  bi('次数', 'Occurrences'),
])

/**
 * Export columns (TSV copy + CSV export) — point 8: the parent column is the RAW id, no localized
 * badge text (a spreadsheet cell should hold data, not a rendered sentence fragment), and two columns
 * the on-screen table has no room for ride along since the export already has them in hand:
 * `parentCount` (the number the badge would have shown) and `path` (the full BOM path).
 */
const missingComponentExportHeaders = computed<string[]>(() => [
  bi('零件号', 'Component'),
  bi('父件', 'Parent'),
  bi('所在 BOM', 'BOM'),
  bi('层级', 'Depth'),
  bi('次数', 'Occurrences'),
  bi('涉及父件数', 'Parent count'),
  bi('路径', 'Path'),
])

/** M5: does this list have anything to show? `items.length` is primary — a clamped-to-0 `distinctCount` must not hide a non-empty list. */
function hasMissingComponents(list: StockPreparationMissingComponentList): boolean {
  return list.items.length > 0 || list.distinctCount > 0
}

/**
 * M5: the number the summary/truncated text SAYS. `distinctCount` when it is a real, positive count;
 * `items.length` when the server sent garbage for it (0, negative, non-numeric — `missingComponentsOf`
 * already clamped all of those to 0) but the items themselves are real. Only genuinely empty
 * (`items.length === 0 && distinctCount <= 0`) reads as 0, and that state never reaches this function
 * because `hasMissingComponents` gates the whole block.
 */
function effectiveDistinctCount(list: StockPreparationMissingComponentList): number {
  return list.distinctCount > 0 ? list.distinctCount : list.items.length
}

/** I-20: 缺件's tooltip — what the COUNT means, since "N 种" alone reads as "N occurrences" to a
 *  first-time reader. */
const missingComponentsTooltip = STOCK_PREP_TOOLTIP_MISSING_COMPONENTS
/** I-4 / 线框 D ③: the card's own bottom closure line. */
const missingComponentsResyncHint = STOCK_PREP_MISSING_COMPONENTS_RESYNC_HINT

const missingComponentsSummary = computed<string>(() => {
  const list = report.value?.missingComponents
  if (!list) return ''
  const count = effectiveDistinctCount(list)
  return bi(
    `缺件 ${count} 种(共 ${list.probeCount} 处引用)—— 这些零件在物料表里不存在,整个项目在补齐前一行都写不进去。`,
    `${count} missing part(s) (${list.probeCount} reference(s)) — these parts do not exist `
    + 'in the materials table, and not one row of this project can be written until they are added.',
  )
})

/**
 * B2 fix: the design's original wording ("用导出取全量") was WRONG — the client holds at most 200
 * items (the same 200-item cap `missingComponentsOf` enforces), so the export is exactly the 200
 * rows already on screen, never "the full list". Says so truthfully, and gives the actual way to see
 * more: clear this batch and run the plan again — the next dry run surfaces whatever is still left.
 */
const missingComponentsTruncatedNote = computed<string>(() => {
  const list = report.value?.missingComponents
  if (!list) return ''
  const count = effectiveDistinctCount(list)
  return bi(
    `仅显示前 200 种(共 ${count} 种);导出的也是这 200 种,补完这批再试算一次会露出下一批。`,
    `Showing the first 200 of ${count} distinct parts; the export also contains only these 200 — clear `
    + 'this batch and run the plan again to see the next one.',
  )
})

/** The on-screen parent cell: the parent id, plus a "(+N 处)" badge when the part is missing under MORE than one parent. */
function missingComponentParentCell(item: StockPreparationMissingComponent): string {
  if (item.parentCount > 1) {
    return `${item.parentSourceId} ${bi(`(+${item.parentCount} 处)`, `(+${item.parentCount} more)`)}`
  }
  return item.parentSourceId
}

/** Export rows (TSV copy + CSV export) — point 8: raw parent id (no badge), plus `parentCount`/`path`. */
function missingComponentExportRows(items: StockPreparationMissingComponent[]): Array<Array<string | number>> {
  return items.map((item) => [
    item.componentSourceId,
    item.parentSourceId,
    item.bomId,
    item.depth,
    item.occurrenceCount,
    item.parentCount,
    item.path,
  ])
}

const missingComponentsCopyLabel = computed<string>(() => {
  if (missingComponentsCopyState.value === 'copied') return bi('已复制', 'Copied')
  if (missingComponentsCopyState.value === 'manual') {
    return bi('已为您选中,请按 Ctrl/Cmd+C 复制', 'Selected — press Ctrl/Cmd+C to copy')
  }
  return bi('复制', 'Copy')
})

/** Point 9: the copy button's "已复制"/"已为您选中…" label is transient — reset to idle 3s later. */
let missingComponentsCopyResetTimer: ReturnType<typeof setTimeout> | null = null

function scheduleMissingComponentsCopyReset(): void {
  if (missingComponentsCopyResetTimer !== null) clearTimeout(missingComponentsCopyResetTimer)
  missingComponentsCopyResetTimer = setTimeout(() => {
    missingComponentsCopyState.value = 'idle'
    missingComponentsCopyResetTimer = null
  }, 3000)
}

onUnmounted(() => {
  if (missingComponentsCopyResetTimer !== null) clearTimeout(missingComponentsCopyResetTimer)
})

/**
 * Clipboard-unavailable fallback: select the table's own text so the operator can copy it by hand.
 * Best-effort only — a test/jsdom environment or an old browser without Selection/Range support gets
 * the same "nothing happened" it would have gotten without this, and the label change is still true.
 */
function selectMissingComponentsTable(): void {
  try {
    const table = missingComponentsTableEl.value
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null
    if (!table || !selection || typeof document.createRange !== 'function') return
    const range = document.createRange()
    range.selectNodeContents(table)
    selection.removeAllRanges()
    selection.addRange(range)
  } catch {
    // See above — a failed selection still gets the "手动复制" label, which is the honest state.
  }
}

async function onCopyMissingComponents(): Promise<void> {
  const list = report.value?.missingComponents
  if (!list) return
  // Guard ON (2nd arg): these cells are a customer's own external part numbers reaching a
  // spreadsheet for the first time — see stockPrepCsv.ts's module comment (B3).
  const tsv = [missingComponentExportHeaders.value, ...missingComponentExportRows(list.items)]
    .map((row) => row.map((cell) => escapeTsvCell(cell, { guardFormulas: true })).join('\t'))
    .join('\n')
  // copyText never rejects; it already falls back to execCommand('copy') when the Clipboard API is
  // missing (plain-HTTP intranet) or refuses.
  if (await copyText(tsv)) {
    missingComponentsCopyState.value = 'copied'
  } else {
    // No copy mechanism worked at all: select the table for a manual copy and SAY SO — a silent
    // failure here reads as "复制 did nothing".
    selectMissingComponentsTable()
    missingComponentsCopyState.value = 'manual'
  }
  scheduleMissingComponentsCopyReset()
}

/** Point 9: characters Windows/macOS/Linux all refuse in a filename, replaced rather than left to fail the download silently. */
function sanitizeFilenameToken(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

function missingComponentsCsvFilename(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const projectToken = sanitizeFilenameToken(submittedProjectNo.value.trim() || 'project')
  return `missing-components-${projectToken}-${yyyy}${mm}${dd}.csv`
}

function onExportMissingComponents(): void {
  const list = report.value?.missingComponents
  if (!list) return
  // Guard ON (4th arg) — same reasoning as the copy path above (B3).
  downloadCsvFile(
    missingComponentsCsvFilename(),
    missingComponentExportHeaders.value,
    missingComponentExportRows(list.items),
    { guardFormulas: true },
  )
}
</script>

<style scoped>
.sp-sync {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  margin: 0 0 var(--ms-space-4);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-sync__head {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.sp-sync__title {
  margin: 0;
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.sp-sync__lede {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.6;
}

.sp-sync__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-3);
}

.sp-sync__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
}

.sp-sync__label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-sync__input {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  padding: 6px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.sp-sync__input:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-sync__run {
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-color-primary);
  padding: 6px 14px;
  color: #fff;
  font: inherit;
  font-weight: var(--ms-font-weight-title);
  cursor: pointer;
}

/* G1: the same control, stepped down while the workspace's 「下一步」 bar owns the filled primary. */
.sp-sync__run--secondary {
  background: var(--ms-bg-page);
  color: var(--ms-color-primary);
}

.sp-sync__run:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-sync__run:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 2px;
}

.sp-sync__hint,
.sp-sync__armed {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.6;
}

.sp-sync__armed {
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
}

/* S2: the project-sheet question and how a run ended without reaching the four steps. Outlined, never
   a filled primary — G1 keeps the one filled button where it is. */
.sp-sync__target-prompt,
.sp-sync__target-notice {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.sp-sync__target-line {
  margin: 0;
  color: var(--ms-text-1);
}

.sp-sync__target-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-sync__verdict {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  margin: 0;
  color: var(--ms-text-1);
  line-height: 1.6;
}

.sp-sync__verdict-count {
  color: var(--ms-color-warning, #b8860b);
}

.sp-sync__verdict-next,
.sp-sync__counts {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.sp-sync__token {
  color: var(--ms-text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.sp-sync__step-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ms-color-info) 20%, transparent);
  color: var(--ms-color-info);
  font-size: 11px;
}

.sp-sync__posture {
  margin: 0;
  font-size: 12px;
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-sync__posture--warning { color: var(--ms-color-warning); }
.sp-sync__posture--danger { color: var(--ms-color-danger); }
.sp-sync__posture--primary { color: var(--ms-color-primary); }
.sp-sync__posture--success { color: var(--ms-color-success); }
.sp-sync__posture--info { color: var(--ms-color-info); }
.sp-sync__posture--neutral { color: var(--ms-text-3); }

.sp-sync__next {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

/* A full-width line under the row of next-step buttons, so the other buttons stay on one row. */
.sp-sync__no-link-hint {
  flex-basis: 100%;
  order: 99;
  margin: 0;
  font-size: 12px;
  color: var(--ms-text-3);
}

.sp-sync__link {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-sync__link:hover {
  background: var(--el-fill-color-light);
}

.sp-sync__link:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

/* P0-3 皮肤: a connected four-step strip. `.sp-sync__step` becomes the flex ROW item (was the whole
   line before); `.sp-sync__step-marker`/`.sp-sync__step-body` are new wrappers around content that
   already existed, so nothing that was there before this pass lost its class or its testid. */
.sp-sync__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
}

.sp-sync__step {
  position: relative;
  display: flex;
  flex: 1 1 200px;
  align-items: flex-start;
  gap: var(--ms-space-2);
  padding-right: var(--ms-space-3);
  line-height: 1.6;
}

.sp-sync__step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 11px;
  right: 0;
  width: var(--ms-space-3);
  height: 1px;
  background: var(--ms-border-light);
}

.sp-sync__step-marker {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.sp-sync__step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--ms-border-light);
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-sync__step-icon--ok { border-color: var(--ms-color-success); color: var(--ms-color-success); }
.sp-sync__step-icon--skip { border-color: var(--ms-color-warning); color: var(--ms-color-warning); }
.sp-sync__step-icon--fail { border-color: var(--ms-color-danger); color: var(--ms-color-danger); }

.sp-sync__step-index {
  color: var(--ms-text-3);
  font-size: 11px;
}

.sp-sync__step-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  min-width: 0;
}

.sp-sync__status {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
}

.sp-sync__status--ok {
  color: var(--ms-color-success, #2f9e44);
}

.sp-sync__status--skip {
  color: var(--ms-color-warning, #b8860b);
}

.sp-sync__status--fail {
  color: var(--ms-color-danger, #c92a2a);
}

.sp-sync__step-name {
  color: var(--ms-text-1);
}

.sp-sync__reason,
.sp-sync__next-line {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-sync__next-line {
  color: var(--ms-text-3);
}

.sp-sync__detail {
  color: var(--ms-text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 缺件清单 (W3a) — deliberately louder than .sp-tech: this is the blocking explanation, not a
   collapsed technical aside, so it gets a border of its own rather than sp-tech's quiet hairline. */
.sp-sync__missing {
  border: 1px solid var(--ms-color-warning, #b8860b);
  border-radius: 6px;
  padding: var(--ms-space-2) var(--ms-space-3);
  background: var(--ms-bg-page);
}

.sp-sync__missing-summary {
  cursor: pointer;
  color: var(--ms-text-1);
  font-size: 13px;
  line-height: 1.6;
  list-style: none;
}

.sp-sync__missing-summary::-webkit-details-marker {
  display: none;
}

.sp-sync__missing-summary:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-sync__missing-body {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-2);
}

.sp-sync__missing-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-sync__missing-table th,
.sp-sync__missing-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  color: var(--ms-text-1);
}

.sp-sync__missing-table th {
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
  font-size: 12px;
}

.sp-sync__missing-truncated {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-sync__missing-actions {
  display: flex;
  gap: var(--ms-space-2);
}

.sp-sync__missing-resync-hint {
  margin: var(--ms-space-2) 0 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}
</style>

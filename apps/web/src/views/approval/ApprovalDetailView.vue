<template>
  <PageShell width="default">
    <PageHeader
      class="approval-detail__header"
      :title="headerTitle"
      back
      back-label="返回列表"
      @back="goBack"
    >
      <template #actions>
        <!-- B3-13 打印/复制: display-only utilities — copy the key fields + link as a plain-text
             summary, or open the browser print dialog (the @media print block below hides the
             interactive chrome). Both hidden until the detail is loaded (nothing to copy/print). -->
        <el-button
          v-if="approval"
          plain
          class="approval-detail__hide-on-print"
          data-testid="approval-copy-summary-button"
          @click="handleCopySummary"
        >
          复制摘要
        </el-button>
        <el-button
          v-if="approval"
          plain
          class="approval-detail__hide-on-print"
          data-testid="approval-print-button"
          @click="handlePrint"
        >
          打印
        </el-button>
        <!-- G-B2-10: appears only after a successful approve/reject AND with another pending
             item available in the store list (deep-link entries with no list render nothing). -->
        <el-button
          v-if="showNextEntry && nextPendingApproval"
          type="primary"
          class="approval-detail__hide-on-print"
          data-testid="approval-next-pending"
          @click="goNextPending"
        >
          下一条 →
        </el-button>
      </template>
      <template v-if="approval" #meta>
        <StatusTag domain="approvalInstance" :status="approval.status" force-locale="zh" />
        <!-- B1-03: 已等待 aging — glanceable next to the status tag, only while still pending. -->
        <el-tag
          v-if="approval.status === 'pending'"
          :type="waitChipType"
          size="large"
          effect="plain"
          data-testid="approval-wait-chip"
        >
          已等待 {{ waitChipLabel }}
        </el-tag>
        <el-tag
          v-if="isInParallelRegion"
          type="warning"
          size="large"
          class="approval-detail__parallel-badge"
          effect="light"
        >
          并行中 · {{ parallelBranchNodeKeys.map(nodeLabel).join(' / ') }}
        </el-tag>
        <!-- B1-01: my-turn cue — the reader is an active assignee at the current node(s). -->
        <el-tag
          v-if="isMyTurn"
          type="success"
          size="large"
          effect="light"
          data-testid="approval-my-turn-badge"
        >
          等待你处理
        </el-tag>
      </template>
    </PageHeader>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="approval-detail__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="retryLoad">重新加载</el-button>
      </template>
    </el-alert>

    <div v-loading="store.loading && !!approval" class="approval-detail__content-wrapper">
      <!-- UF-8 (design-lock §3.6): first paint only — no `approval` yet AND still loading. Once
           data arrives, `v-loading` above takes over for subsequent refreshes. B3-13: the two
           inline el-skeleton blocks (3-row form + 6-row timeline) moved verbatim into the shared
           AsyncStateBlock; same texture, one reusable renderer. -->
      <AsyncStateBlock
        v-if="!approval && store.loading"
        state="loading"
        :skeleton-rows="[3, 6]"
        data-testid="detail-skeleton"
      />
      <!-- B3-13 空态 CTA: deep link to a deleted/foreign/unreachable instance previously rendered
           a BLANK content area (only the top error alert). `getApproval` either resolves a DTO or
           throws, so "not loading and still no approval" IS the not-found/failed-load state. -->
      <AsyncStateBlock
        v-else-if="!approval"
        state="empty"
        title="未找到该审批"
        hint="该审批可能已被删除、链接有误或暂时无法加载"
        data-testid="detail-not-found"
      >
        <template #action>
          <el-button type="primary" data-testid="approval-not-found-retry" @click="retryLoad">
            重新加载
          </el-button>
          <el-button data-testid="approval-not-found-back" @click="goBack">返回列表</el-button>
        </template>
      </AsyncStateBlock>
      <div v-if="approval" class="approval-detail__body">
        <!-- Left: form snapshot -->
        <div ref="formSectionRef" class="approval-detail__form" data-testid="approval-detail-form-section">
          <h2>表单信息</h2>
          <div class="approval-detail__meta">
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">审批编号</span>
              <span>{{ approval.requestNo ?? '-' }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">发起人</span>
              <span>{{ approval.requester?.name ?? '-' }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">部门</span>
              <span>{{ approval.requester?.department ?? '-' }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">发起时间</span>
              <span>{{ formatDate(approval.createdAt) }}</span>
            </div>
            <div class="approval-detail__meta-item">
              <span class="approval-detail__label">进度</span>
              <span>{{ approval.currentStep ?? '-' }} / {{ approval.totalSteps ?? '-' }}</span>
            </div>
          </div>

          <el-divider />

          <div v-if="approval.formSnapshot" class="approval-detail__snapshot">
            <!-- B1-02: humanized scalar fields — ordered + labeled via the frozen formSchema
                 (buildDisplayFields), so readers see field labels and option labels instead of
                 raw machine keys/values. `detail` fields are excluded here; they keep rendering
                 via the detailTables loop below, unchanged. -->
            <div
              v-for="field in displayFields"
              :key="field.key"
              class="approval-detail__field"
            >
              <span class="approval-detail__label">{{ field.label }}</span>
              <span>{{ field.value }}</span>
            </div>
            <!-- B3-07 §8 (#4195): attachments frozen into the snapshot as an ordered id array,
                 resolved BY THE FROZEN ID through the shared pure resolver (desktop/mobile parity).
                 A ref whose row is gone/soft-deleted renders as a tombstone — never a silent swap to
                 a different file; a ref on a field hidden at the active node is omitted by the server
                 and so renders as nothing at all (redaction inheritance, G7). Downloads go through
                 the auth-proxied endpoint only. -->
            <div
              v-for="group in attachmentFields"
              :key="`att_${group.fieldId}`"
              class="approval-detail__field"
              data-testid="approval-detail-attachments"
            >
              <span class="approval-detail__label">{{ group.label }}</span>
              <ul class="approval-detail__attachments">
                <li v-for="ref in group.refs" :key="ref.id">
                  <span v-if="ref.tombstone" class="approval-detail__attachment-tombstone">附件已删除</span>
                  <template v-else>
                    <a
                      v-if="ref.downloadUrl"
                      :href="ref.downloadUrl"
                      data-testid="approval-attachment-download"
                      @click.prevent="handleAttachmentDownload(ref)"
                    >{{ ref.fileName }}</a>
                    <span v-else class="approval-detail__attachment-unavailable">附件暂不可用</span>
                    <span v-if="formatAttachmentSize(ref.sizeBytes)" class="approval-detail__attachment-size">
                      {{ formatAttachmentSize(ref.sizeBytes) }}
                    </span>
                  </template>
                </li>
              </ul>
            </div>
            <!-- detail / sub-form (明细): render the frozen rows × columns as a read-only
                 table driven by the instance's FROZEN formSchema columns (never the live
                 template). -->
            <div
              v-for="(table, key) in detailTables"
              :key="key"
              class="approval-detail__field"
            >
              <span class="approval-detail__label">{{ key }}</span>
              <el-table
                :data="table.rows"
                border
                size="small"
                class="approval-detail__detail-table"
              >
                <el-table-column
                  v-for="column in table.columns"
                  :key="column.id"
                  :label="column.label"
                >
                  <template #default="{ row }">
                    {{ formatFieldValue(row.cells[column.id], column) }}
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
          <el-empty v-else description="暂无表单数据" :image-size="80" />
        </div>

        <!-- Right: history timeline -->
        <div ref="timelineSectionRef" class="approval-detail__timeline">
          <!-- UI-6 (master §4 UI-6 / P5): anchor-style section nav — chrome only, no new
               action/verb/dialog. Desktop-only (mobile keeps current behavior unchanged);
               each tab just scrolls the already-rendered region into view, it never fetches,
               dispatches a store action, or hides an existing testid. -->
          <nav
            v-if="!isMobileLayout"
            class="approval-detail__detail-tabs"
            data-testid="approval-detail-tabs"
            aria-label="审批详情分区导航"
          >
            <button
              type="button"
              class="approval-detail__detail-tab"
              :class="{ 'approval-detail__detail-tab--active': activeDetailTab === 'form' }"
              data-testid="approval-detail-tab-info"
              @click="scrollToDetailSection('form')"
            >
              审批详情
            </button>
            <button
              type="button"
              class="approval-detail__detail-tab"
              :class="{ 'approval-detail__detail-tab--active': activeDetailTab === 'record' }"
              data-testid="approval-detail-tab-record"
              @click="scrollToDetailSection('record')"
            >
              审批记录
            </button>
            <button
              type="button"
              class="approval-detail__detail-tab"
              :class="{ 'approval-detail__detail-tab--active': activeDetailTab === 'comments' }"
              data-testid="approval-detail-tab-comments"
              @click="scrollToDetailSection('comments')"
            >
              全文评论
            </button>
          </nav>
          <h2>审批流程</h2>
          <!-- UI-6: 审批记录 view toggle — timeline (default, byte-for-byte the pre-existing
               markup below) vs a compact audit-derived table projection. Both read the SAME
               already-fetched `store.history` array; switching never fetches or dispatches. -->
          <div
            v-if="!isMobileLayout"
            class="approval-detail__record-toggle"
            data-testid="approval-detail-record-toggle"
          >
            <button
              type="button"
              class="approval-detail__record-toggle-btn"
              :class="{ 'approval-detail__record-toggle-btn--active': recordView === 'timeline' }"
              data-testid="approval-detail-record-view-timeline"
              @click="recordView = 'timeline'"
            >
              时间线
            </button>
            <button
              type="button"
              class="approval-detail__record-toggle-btn"
              :class="{ 'approval-detail__record-toggle-btn--active': recordView === 'table' }"
              data-testid="approval-detail-record-view-table"
              @click="recordView = 'table'"
            >
              表格
            </button>
          </div>
          <div v-if="recordView === 'table' && !isMobileLayout && store.history.length" class="approval-detail__record-table" data-testid="approval-detail-record-table">
            <el-table :data="recordTableRows" border size="small">
              <el-table-column label="节点名称">
                <template #default="{ row }">{{ row.nodeName }}</template>
              </el-table-column>
              <el-table-column label="审批人">
                <template #default="{ row }">{{ row.actorName }}</template>
              </el-table-column>
              <el-table-column label="审批结果/时间">
                <template #default="{ row }">
                  <div class="approval-detail__record-result">
                    <span>{{ row.resultLabel }}</span>
                    <span v-if="row.timestamp" class="approval-detail__record-time">{{ formatDate(row.timestamp) }}</span>
                  </div>
                  <div v-if="hasRecordTableBadgeMetadata(row.metadata, row.action)" class="approval-detail__timeline-meta">
                    <span v-if="row.metadata?.autoApproved" class="approval-detail__meta-badge approval-detail__meta-badge--auto">自动审批</span>
                    <span v-if="row.metadata?.approvalMode" class="approval-detail__meta-badge">
                      审批模式: {{ approvalModeLabel(row.metadata.approvalMode as string) }}
                    </span>
                    <span v-if="row.metadata?.aggregateComplete && row.metadata?.approvalMode === 'all'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">会签完成</span>
                    <span v-if="row.metadata?.aggregateComplete && row.metadata?.approvalMode === 'any'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">或签完成</span>
                    <span v-if="cancelledAssigneesLabel(row.metadata)" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                      {{ cancelledAssigneesLabel(row.metadata) }}
                    </span>
                    <span v-if="row.action === 'sign' && row.metadata?.autoCancelled" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                      （已被 {{ row.metadata?.aggregateCancelledBy || '发起人' }} 的决定覆盖）
                    </span>
                    <span v-if="row.action === 'return' && row.metadata?.targetNodeKey" class="approval-detail__meta-badge approval-detail__meta-badge--return">
                      退回至: {{ nodeLabel(row.metadata.targetNodeKey as string) }}
                    </span>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <template v-else-if="store.history.length">
            <!-- Parallel gateway (并行分支): cluster history entries under
                 each branch's approval-node key so reviewers can trace
                 per-branch decisions without re-reading the full timeline. -->
            <template v-if="isInParallelRegion && timelineBranchGroups.length">
              <div
                v-for="group in timelineBranchGroups"
                :key="group.key"
                class="approval-detail__timeline-group"
              >
                <div class="approval-detail__timeline-group-header">
                  <span class="approval-detail__timeline-group-label">
                    {{ group.label }}
                  </span>
                  <span class="approval-detail__timeline-group-count">
                    {{ group.items.length }} 条
                  </span>
                </div>
                <el-timeline>
                  <el-timeline-item
                    v-for="item in group.items"
                    :key="item.id"
                    :type="timelineItemType(item.action, item.toStatus)"
                    :icon="timelineIcon(item.action, item.metadata)"
                    :hollow="item.toStatus === 'pending'"
                    size="large"
                    :timestamp="item.occurredAt ? formatDate(item.occurredAt) : '-'"
                    placement="top"
                  >
                    <div class="approval-detail__timeline-content">
                      <div class="approval-detail__timeline-header">
                        <span class="approval-detail__actor-avatar" aria-hidden="true">{{ actorInitial(item) }}</span><strong>{{ item.metadata?.autoApproved ? '系统自动审批' : (item.actorName ?? '系统') }}</strong>
                        <el-tag :type="timelineActionTagType(item.action, item.metadata)" size="small">
                          {{ actionLabel(item.action, item.metadata) }}
                        </el-tag>
                      </div>
                      <p v-if="item.comment" class="approval-detail__timeline-comment">
                        {{ item.comment }}
                      </p>
                      <!-- Lock-9 OD-L9-10(a): process attachments staged on THIS comment action. -->
                      <ul
                        v-if="processAttachmentRefsForHistoryItem(item).length > 0"
                        class="approval-detail__attachments"
                        data-testid="approval-timeline-process-attachments"
                      >
                        <li v-for="ref in processAttachmentRefsForHistoryItem(item)" :key="ref.id">
                          <span v-if="ref.tombstone" class="approval-detail__attachment-tombstone">附件已删除</span>
                          <template v-else>
                            <a
                              v-if="ref.downloadUrl"
                              :href="ref.downloadUrl"
                              data-testid="approval-timeline-attachment-download"
                              @click.prevent="handleAttachmentDownload(ref)"
                            >{{ ref.fileName }}</a>
                            <span v-else class="approval-detail__attachment-unavailable">附件暂不可用</span>
                            <span v-if="formatAttachmentSize(ref.sizeBytes)" class="approval-detail__attachment-size">
                              {{ formatAttachmentSize(ref.sizeBytes) }}
                            </span>
                          </template>
                        </li>
                      </ul>
                      <div v-if="hasTimelineMetadata(item.metadata)" class="approval-detail__timeline-meta">
                        <span v-if="item.metadata?.autoApproved" class="approval-detail__meta-badge approval-detail__meta-badge--auto">自动审批</span>
                        <span v-if="item.metadata?.approvalMode" class="approval-detail__meta-badge">
                          审批模式: {{ approvalModeLabel(item.metadata.approvalMode as string) }}
                        </span>
                        <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'all'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">会签完成</span>
                        <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'any'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">或签完成</span>
                        <span v-if="cancelledAssigneesLabel(item.metadata)" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                          {{ cancelledAssigneesLabel(item.metadata) }}
                        </span>
                        <span v-if="item.action === 'sign' && item.metadata?.autoCancelled" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                          （已被 {{ item.metadata?.aggregateCancelledBy || '发起人' }} 的决定覆盖）
                        </span>
                        <span v-if="item.action === 'return' && item.metadata?.targetNodeKey" class="approval-detail__meta-badge approval-detail__meta-badge--return">
                          退回至: {{ nodeLabel(item.metadata.targetNodeKey as string) }}
                        </span>
                        <span v-if="item.metadata?.nodeKey" class="approval-detail__meta-badge">
                          节点: {{ nodeLabel(item.metadata.nodeKey as string) }}
                        </span>
                      </div>
                    </div>
                  </el-timeline-item>
                </el-timeline>
              </div>
            </template>
            <el-timeline v-else>
              <el-timeline-item
                v-for="item in store.history"
                :key="item.id"
                :type="timelineItemType(item.action, item.toStatus)"
                :icon="timelineIcon(item.action, item.metadata)"
                :hollow="item.toStatus === 'pending'"
                size="large"
                :timestamp="item.occurredAt ? formatDate(item.occurredAt) : '-'"
                placement="top"
              >
                <div class="approval-detail__timeline-content">
                  <div class="approval-detail__timeline-header">
                    <span class="approval-detail__actor-avatar" aria-hidden="true">{{ actorInitial(item) }}</span><strong>{{ item.metadata?.autoApproved ? '系统自动审批' : (item.actorName ?? '系统') }}</strong>
                    <el-tag :type="timelineActionTagType(item.action, item.metadata)" size="small">
                      {{ actionLabel(item.action, item.metadata) }}
                    </el-tag>
                  </div>
                  <p v-if="item.comment" class="approval-detail__timeline-comment">
                    {{ item.comment }}
                  </p>
                  <!-- Lock-9 OD-L9-10(a): process attachments staged on THIS comment action. -->
                  <ul
                    v-if="processAttachmentRefsForHistoryItem(item).length > 0"
                    class="approval-detail__attachments"
                    data-testid="approval-timeline-process-attachments"
                  >
                    <li v-for="ref in processAttachmentRefsForHistoryItem(item)" :key="ref.id">
                      <span v-if="ref.tombstone" class="approval-detail__attachment-tombstone">附件已删除</span>
                      <template v-else>
                        <a
                          v-if="ref.downloadUrl"
                          :href="ref.downloadUrl"
                          data-testid="approval-timeline-attachment-download"
                          @click.prevent="handleAttachmentDownload(ref)"
                        >{{ ref.fileName }}</a>
                        <span v-else class="approval-detail__attachment-unavailable">附件暂不可用</span>
                        <span v-if="formatAttachmentSize(ref.sizeBytes)" class="approval-detail__attachment-size">
                          {{ formatAttachmentSize(ref.sizeBytes) }}
                        </span>
                      </template>
                    </li>
                  </ul>
                  <div v-if="hasTimelineMetadata(item.metadata)" class="approval-detail__timeline-meta">
                    <span v-if="item.metadata?.autoApproved" class="approval-detail__meta-badge approval-detail__meta-badge--auto">自动审批</span>
                    <span v-if="item.metadata?.approvalMode" class="approval-detail__meta-badge">
                      审批模式: {{ approvalModeLabel(item.metadata.approvalMode as string) }}
                    </span>
                    <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'all'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">会签完成</span>
                    <span v-if="item.metadata?.aggregateComplete && item.metadata?.approvalMode === 'any'" class="approval-detail__meta-badge approval-detail__meta-badge--complete">或签完成</span>
                    <span v-if="cancelledAssigneesLabel(item.metadata)" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                      {{ cancelledAssigneesLabel(item.metadata) }}
                    </span>
                    <span v-if="item.action === 'sign' && item.metadata?.autoCancelled" class="approval-detail__meta-badge approval-detail__meta-badge--cancelled">
                      （已被 {{ item.metadata?.aggregateCancelledBy || '发起人' }} 的决定覆盖）
                    </span>
                    <span v-if="item.action === 'return' && item.metadata?.targetNodeKey" class="approval-detail__meta-badge approval-detail__meta-badge--return">
                      退回至: {{ nodeLabel(item.metadata.targetNodeKey as string) }}
                    </span>
                    <span v-if="item.metadata?.nodeKey" class="approval-detail__meta-badge">
                      节点: {{ nodeLabel(item.metadata.nodeKey as string) }}
                    </span>
                  </div>
                </div>
              </el-timeline-item>
            </el-timeline>
          </template>
          <el-empty v-else description="暂无审批历史" :image-size="80" />

          <!-- UX B2-08: current handler + upcoming nodes — synthesized (NOT real history rows),
               appended at the END of the timeline so a requester can see who it's stuck with and
               what's next, not just what already happened. Deliberately NOT built from
               `<el-timeline-item>` — its own lightweight dot+line rail instead — so it stays
               visually distinct (upcoming = greyed) and never perturbs the real history item
               count above. -->
          <div
            v-if="currentHandlerEntries.length > 0 || upcomingTimelineNodes.length > 0"
            class="approval-detail__timeline-upcoming"
            data-testid="approval-timeline-upcoming-section"
          >
            <div
              v-for="entry in currentHandlerEntries"
              :key="`current-${entry.assignmentId}`"
              class="approval-detail__timeline-upcoming-item approval-detail__timeline-upcoming-item--current"
              data-testid="approval-current-handler-item"
            >
              <span class="approval-detail__timeline-upcoming-dot" />
              <span class="approval-detail__timeline-upcoming-text">
                当前处理人：{{ entry.label }} · 已等待 {{ entry.wait }}
              </span>
            </div>
            <div
              v-for="node in upcomingTimelineNodes"
              :key="`upcoming-${node.key}`"
              class="approval-detail__timeline-upcoming-item approval-detail__timeline-upcoming-item--future"
              :class="{ 'approval-detail__timeline-upcoming-item--conditional': node.isConditional }"
              data-testid="approval-upcoming-node-item"
            >
              <span class="approval-detail__timeline-upcoming-dot" />
              <span class="approval-detail__timeline-upcoming-text">
                <strong>{{ node.name }}</strong>
                <span class="approval-detail__timeline-upcoming-summary">{{ node.assigneeSummary }}</span>
              </span>
            </div>
          </div>
        </div>

        <!-- 全文评论 (S3b): the shared comments kit, wired to the S2 approval-comments endpoints.
             Own sibling section, FULL-WIDTH (grid-column 1/-1, see the stylesheet below) below the
             two-column 审批详情/审批记录 row — same "anchor-style nav scrolls an always-rendered
             region" convention as those two, so the scroll ref target exists on first click; the
             PANEL ITSELF only mounts (and only then makes its first fetch) once
             `commentsActivated` flips true — see scrollToDetailSection. Placed AFTER, not
             between, `.approval-detail__form`/`.approval-detail__timeline` in DOM order — a
             three-item child of a 2-column `grid-auto-flow: row` (sparse, non-dense) grid placed
             BETWEEN them would instead push the timeline into the form's own column on a second
             row, since a later full-span item cannot backfill an earlier skipped cell under
             sparse packing.

             `:key="route.params.id"` (gate finding P2-2, 2026-08-22): a 下一条 / deep-link
             navigation changes `route.params.id` in place without unmounting this element. Without
             the key, the SAME `ApprovalCommentsPanel` instance survived that navigation and its
             `watch(() => props.instanceId, activate)` re-activated in place; if the OLD instance's
             in-flight `listComments`/mention-candidates fetch settled AFTER the new instance's,
             the stale response overwrote the composable's `comments.value` with the WRONG
             instance's data (constructed race, confirmed: DOM showed instance A's comments while
             `route.params.id` was already B). Keying on the route param forces a full
             unmount+remount on every instance change, so a slower, now-orphaned fetch resolves
             into a composable/`comments` ref nothing renders — the race is structurally
             unreachable rather than patched with a generation counter. -->
        <div v-if="!isMobileLayout" ref="commentsSectionRef" class="approval-detail__comments" data-testid="approval-detail-comments-section">
          <h2>全文评论</h2>
          <ApprovalCommentsPanel
            v-if="commentsActivated"
            :key="(route.params.id as string)"
            :instance-id="(route.params.id as string)"
            :current-user-id="currentUserId"
          />
        </div>
      </div>

      <!-- Action bar -->
      <div v-if="approval" class="approval-detail__actions">
        <template v-if="approval.status === 'pending'">
          <!-- B3-13 按动作 loading: every action button binds to `inFlightAction === '<its own
               action>'` instead of the store-global `loading` flag, so only the button whose
               request is actually in flight spins/disables — the rest of the bar stays usable
               (and a detail/history refresh no longer spins the whole bar). -->
          <div class="approval-detail__actions-primary">
            <el-button
              v-if="canAct"
              type="success"
              :loading="inFlightAction === 'approve'"
              data-testid="approval-approve-button"
              @click="openActionDialog('approve')"
            >
              通过
            </el-button>
            <el-button
              v-if="canAct"
              type="danger"
              :loading="inFlightAction === 'reject'"
              data-testid="approval-reject-button"
              @click="openActionDialog('reject')"
            >
              驳回
            </el-button>
          </div>
          <div class="approval-detail__actions-secondary">
            <!-- T3-1 v0 (ballot Q8): the deferred action set —
                 退回/转交/加签/减签/催办/撤回 — is desktop-only. The mobile
                 surface exposes approve/reject/comment only, so each deferred
                 control is additionally gated on `!isMobileLayout`. 评论 stays
                 visible on both surfaces. -->
            <el-button
              v-if="canAct && !isMobileLayout && returnableNodes.length > 0 && allowReturn"
              type="warning"
              :loading="inFlightAction === 'return'"
              data-testid="approval-return-button"
              @click="openReturnDialog"
            >
              退回
            </el-button>
            <el-button
              v-if="canAct && !isMobileLayout && allowTransfer"
              type="warning"
              :loading="inFlightAction === 'transfer'"
              data-testid="approval-transfer-button"
              @click="openTransferDialog"
            >
              转交
            </el-button>
            <!-- P1-B 加签: pull additional co-signer(s) into the current node. -->
            <el-button
              v-if="canAct && !isMobileLayout && allowAddSign"
              type="primary"
              plain
              :loading="inFlightAction === 'add_sign'"
              data-testid="approval-add-sign-button"
              @click="openAddSignDialog"
            >
              加签
            </el-button>
            <!-- P1-B 减签: remove a previously add-signed co-signer at the
                 current node. Only shown when at least one such row exists. -->
            <el-button
              v-if="canAct && !isMobileLayout && reducibleAssignees.length > 0 && allowReduceSign"
              type="primary"
              plain
              :loading="inFlightAction === 'reduce_sign'"
              data-testid="approval-reduce-sign-button"
              @click="openReduceSignDialog"
            >
              减签
            </el-button>
            <!-- Wave 2 WP3 slice 1: 催办. Visible only for the requester on
                 a pending instance; server-side rate-limits to once per hour
                 per user per instance (429 → surfaced as a friendly toast). -->
            <el-button
              v-if="isRequester && !isMobileLayout"
              type="primary"
              plain
              :loading="remindLoading"
              data-testid="approval-remind-button"
              @click="handleRemind"
            >
              <el-icon class="ms-mr-4"><Bell /></el-icon>催一下
            </el-button>
            <!-- B3-13 撤回策略感知: the instance policy snapshot's `allowRevoke` (frozen from the
                 published runtime graph at creation; enforced fail-closed server-side with a 409
                 APPROVAL_REVOKE_DISABLED) finally gates the affordance — a 撤回-disabled template
                 no longer shows a button that can only fail at click time. Strict `=== true`
                 check via `allowRevoke` below: absent/legacy/null policy hides it (fail-closed,
                 mirroring the backend default-deny for instances without a runtime graph). -->
            <el-popconfirm
              v-if="isRequester && !isMobileLayout && allowRevoke"
              title="确认撤回此审批？"
              confirm-button-text="确认"
              cancel-button-text="取消"
              @confirm="handleRevoke"
            >
              <template #reference>
                <el-button
                  type="info"
                  :loading="inFlightAction === 'revoke'"
                  data-testid="approval-revoke-button"
                >
                  撤回
                </el-button>
              </template>
            </el-popconfirm>
            <el-button
              plain
              :loading="inFlightAction === 'comment'"
              data-testid="approval-comment-button"
              @click="openCommentDialog"
            >
              评论
            </el-button>
          </div>
        </template>
        <template v-else>
          <el-alert
            title="该审批已结束"
            type="info"
            show-icon
            :closable="false"
            class="ms-flex-1"
          />
          <!-- UX B2-13: 再次提交 — own+terminal (rejected/revoked/cancelled) only; see
               `canResubmit`/`handleResubmit`. -->
          <el-button
            v-if="canResubmit"
            type="primary"
            data-testid="approval-resubmit-button"
            @click="handleResubmit"
          >
            再次提交
          </el-button>
        </template>
      </div>
    </div>

    <!-- Approve / Reject dialog -->
    <el-dialog
      v-model="actionDialogVisible"
      :title="actionDialogTitle"
      :width="MEMBER_ACTION_DIALOG_WIDTH"
      :data-testid="ACTION_DIALOG_TEST_ID"
      @keydown.tab="trapMemberActionDialogFocus"
      @opened="focusActionComment"
    >
      <!-- B1-04: dialog-scoped failure message — the server's own reason, kept in place of a
           generic toast so the reader learns WHY without losing the dialog/typed comment. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item :label="actionCommentLabel">
          <!-- B1-05: quick phrases — this user's recently-used phrases first, then the fixed
               preset list for 通过/驳回. Clicking a chip fills (or appends to) the textarea;
               free-typed text is never remembered, only a submitted phrase that exactly
               matches one of these chips (see `rememberQuickPhraseIfOffered`). -->
          <div v-if="quickPhraseChips.length > 0" class="approval-detail__quick-phrases">
            <el-tag
              v-for="(phrase, index) in quickPhraseChips"
              :key="phrase"
              class="approval-detail__quick-phrase-chip"
              effect="plain"
              :data-testid="`approval-quick-phrase-${index}`"
              @click="applyQuickPhrase(phrase)"
            >
              {{ phrase }}
            </el-tag>
          </div>
          <el-input
            ref="actionCommentInputRef"
            v-model="actionComment"
            type="textarea"
            :rows="3"
            :placeholder="actionCommentPlaceholder"
            :aria-label="actionCommentLabel"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionDialogVisible = false">取消</el-button>
        <el-button
          :type="currentAction === 'approve' ? 'success' : 'danger'"
          :loading="inFlightAction === currentAction"
          :disabled="actionConfirmDisabled"
          data-testid="approval-action-dialog-confirm"
          @click="submitAction"
        >
          确认
        </el-button>
      </template>
    </el-dialog>

    <!-- Transfer dialog -->
    <el-dialog
      v-model="transferDialogVisible"
      :title="MEMBER_ACTION_DIALOG_GRAMMAR.transfer.dialogTitle"
      :width="MEMBER_ACTION_DIALOG_WIDTH"
      :data-testid="MEMBER_ACTION_DIALOG_GRAMMAR.transfer.dialogTestId"
      @keydown.tab="trapMemberActionDialogFocus"
    >
      <!-- P5-C-1: same dialog-scoped failure grammar as approve/reject/comment above — the
           non-policy branch of `handleMemberActionFailure` now renders here instead of a toast
           (see that function's doc comment); a policy denial still toasts + closes the dialog. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item label="转交给">
          <ApprovalUserPicker
            :model-value="transferUserId || null"
            placeholder="搜索并选择转交对象"
            aria-label="转交给"
            @update:model-value="transferUserId = $event ?? ''"
          />
        </el-form-item>
        <el-form-item :label="MEMBER_ACTION_DIALOG_GRAMMAR.transfer.commentLabel">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="MEMBER_ACTION_DIALOG_GRAMMAR.transfer.commentRows"
            :placeholder="MEMBER_ACTION_DIALOG_GRAMMAR.transfer.commentPlaceholder"
            :aria-label="MEMBER_ACTION_DIALOG_GRAMMAR.transfer.commentLabel"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferDialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="inFlightAction === 'transfer'"
          :disabled="!transferUserId"
          data-testid="approval-transfer-submit"
          @click="submitTransfer"
        >
          {{ MEMBER_ACTION_DIALOG_GRAMMAR.transfer.confirmLabel }}
        </el-button>
      </template>
    </el-dialog>

    <!-- P1-B 加签 dialog -->
    <el-dialog
      v-model="addSignDialogVisible"
      :title="MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.dialogTitle"
      :width="MEMBER_ACTION_DIALOG_WIDTH"
      :data-testid="MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.dialogTestId"
      @keydown.tab="trapMemberActionDialogFocus"
    >
      <!-- P5-C-1: same dialog-scoped failure grammar as approve/reject/comment above. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item label="加签人">
          <!-- P1-B 加签 target picker: ApprovalUserPicker is single-select by design (v-model one
               id), so multi-target add-sign uses a REPEATED-PICK pattern instead of a multi-select
               dropdown — pick one, it lands as a removable chip below, the picker resets for the
               next pick. `addSignUserIds` (the submit payload shape) is unchanged. -->
          <div v-if="addSignUserIds.length > 0" class="approval-detail__add-sign-chips" data-testid="approval-add-sign-chips">
            <el-tag
              v-for="(uid, chipIndex) in addSignUserIds"
              :key="uid"
              closable
              class="approval-detail__add-sign-chip"
              @close="removeAddSignUser(uid)"
            >
              {{ addSignUserLabels[uid] || `成员 ${chipIndex + 1}` }}
            </el-tag>
          </div>
          <ApprovalUserPicker
            :model-value="addSignPickerValue"
            placeholder="搜索并添加加签人"
            aria-label="搜索并添加加签人"
            @select="onAddSignUserSelected"
          />
        </el-form-item>
        <!-- Lock-5 gate B-2 (`'before'` honesty): the two-arm `加签方式` radio is RETIRED. Its
             `前加签` arm claimed corpus C-3 semantics (insert a node BEFORE this one and come back
             to it) that no shipped path implements — §0.1: both modes seat co-signers at the CURRENT
             node in the SAME epoch, so outside a parallel region the arms were byte-identical (now
             pinned by a real-DB test). A radio whose arms cannot be told apart is a fake switch, so
             the arm is removed rather than relabelled and the surface states what add-sign really
             does. The wire contract is unchanged: this client sends `'parallel'`, and the server
             still accepts `'before'` from any other client. -->
        <el-form-item label="加签方式">
          <span class="approval-detail__hint" data-testid="approval-add-sign-mode-hint">{{ ADD_SIGN_MODE_HINT }}</span>
        </el-form-item>
        <el-form-item :label="MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.commentLabel">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.commentRows"
            :placeholder="MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.commentPlaceholder"
            :aria-label="MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.commentLabel"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addSignDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="inFlightAction === 'add_sign'"
          :disabled="addSignUserIds.length === 0"
          data-testid="approval-add-sign-submit"
          @click="submitAddSign"
        >
          {{ MEMBER_ACTION_DIALOG_GRAMMAR.add_sign.confirmLabel }}
        </el-button>
      </template>
    </el-dialog>

    <!-- P1-B 减签 dialog -->
    <el-dialog
      v-model="reduceSignDialogVisible"
      :title="MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.dialogTitle"
      :width="MEMBER_ACTION_DIALOG_WIDTH"
      :data-testid="MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.dialogTestId"
      @keydown.tab="trapMemberActionDialogFocus"
    >
      <!-- P5-C-1: same dialog-scoped failure grammar as approve/reject/comment above. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item label="减签人">
          <el-select
            v-model="reduceSignUserId"
            filterable
            placeholder="选择要移除的加签人"
            aria-label="选择要移除的加签人"
            class="ms-w-100pct"
            data-testid="approval-reduce-sign-user"
          >
            <el-option
              v-for="assignee in reducibleAssignees"
              :key="assignee.assigneeId"
              :label="assignee.label"
              :value="assignee.assigneeId"
              :disabled="assignee.disabled"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.commentLabel">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.commentRows"
            :placeholder="MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.commentPlaceholder"
            :aria-label="MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.commentLabel"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reduceSignDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="inFlightAction === 'reduce_sign'"
          :disabled="!reduceSignUserId"
          data-testid="approval-reduce-sign-submit"
          @click="submitReduceSign"
        >
          {{ MEMBER_ACTION_DIALOG_GRAMMAR.reduce_sign.confirmLabel }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Comment dialog -->
    <el-dialog
      v-model="commentDialogVisible"
      :title="MEMBER_ACTION_DIALOG_GRAMMAR.comment.dialogTitle"
      :width="MEMBER_ACTION_DIALOG_WIDTH"
      :data-testid="MEMBER_ACTION_DIALOG_GRAMMAR.comment.dialogTestId"
      @keydown.tab="trapMemberActionDialogFocus"
    >
      <!-- B1-04: same dialog-scoped failure message as the 通过/驳回 dialog above. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item :label="MEMBER_ACTION_DIALOG_GRAMMAR.comment.commentLabel">
          <!-- B1-05: quick phrases — see the 通过/驳回 dialog above for the same mechanics. -->
          <div v-if="quickPhraseChips.length > 0" class="approval-detail__quick-phrases">
            <el-tag
              v-for="(phrase, index) in quickPhraseChips"
              :key="phrase"
              class="approval-detail__quick-phrase-chip"
              effect="plain"
              :data-testid="`approval-quick-phrase-${index}`"
              @click="applyQuickPhrase(phrase)"
            >
              {{ phrase }}
            </el-tag>
          </div>
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="MEMBER_ACTION_DIALOG_GRAMMAR.comment.commentRows"
            :placeholder="MEMBER_ACTION_DIALOG_GRAMMAR.comment.commentPlaceholder"
            :aria-label="MEMBER_ACTION_DIALOG_GRAMMAR.comment.commentLabel"
          />
        </el-form-item>
        <!-- Lock-9 OD-L9-10(a): process-attachment uploader — gated on the pipeline flag AND
             `isMyTurn`, deliberately NOT `canAct` (the coarse `approvals:act` scope grant, which
             the 评论 button above has no gate on at all and so also renders for requesters/CC
             recipients). Budgets are server-authoritative and unratified (OD-L9-8) — no
             client-side count/size cap here.
             Lock-9 FE fix round (gate P3-1): `isMyTurn` is a narrower, FAIL-CLOSED approximation
             of the server's seat check, not an exact mirror — the server's `assignmentMatchesActor`
             also admits `assignment_type === 'role'`; `isMyTurn` (below) matches only
             `type === 'user'`. A role-seated approver whose upload the server would accept sees no
             uploader here. No security impact (fails closed) and consistent with the shipped action
             bar's own `v-if="isMyTurn"` (line ~67, unchanged by this slice) — this is a display gap,
             not a new capability gap, and correcting the "exact mirror" wording, not the gate choice
             itself, is what this fix round changed. -->
        <el-form-item
          v-if="attachmentPipelineEnabled && isMyTurn"
          label="附件"
          data-testid="approval-comment-attachment-upload"
        >
          <input
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.txt,.csv"
            data-testid="approval-comment-attachment-input"
            :disabled="commentAttachmentUploading || !commentAttachmentContextCurrent"
            @change="onCommentAttachmentPick"
          />
          <ul v-if="commentStagedAttachments.length > 0" class="approval-detail__comment-attachment-list">
            <li v-for="item in commentStagedAttachments" :key="item.id">
              <span>{{ item.name }}</span>
              <el-button link type="danger" @click="removeCommentAttachment(item.id)">移除</el-button>
            </li>
          </ul>
          <span class="approval-detail__comment-attachment-hint">支持 PDF / JPG / PNG / TXT / CSV，单文件 ≤ 20MB</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="commentDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="inFlightAction === 'comment'"
          :disabled="!actionComment.trim() || commentAttachmentUploading"
          data-testid="approval-comment-submit"
          @click="submitComment"
        >
          {{ MEMBER_ACTION_DIALOG_GRAMMAR.comment.confirmLabel }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Return dialog -->
    <el-dialog
      v-model="returnDialogVisible"
      :title="MEMBER_ACTION_DIALOG_GRAMMAR.return.dialogTitle"
      :width="MEMBER_ACTION_DIALOG_WIDTH"
      :data-testid="MEMBER_ACTION_DIALOG_GRAMMAR.return.dialogTestId"
      @keydown.tab="trapMemberActionDialogFocus"
    >
      <!-- P5-C-1: same dialog-scoped failure grammar as approve/reject/comment above. -->
      <el-alert
        v-if="actionDialogError"
        type="error"
        show-icon
        :closable="false"
        :title="actionDialogError"
        data-testid="approval-action-dialog-error"
        class="approval-detail__dialog-error"
      />
      <el-form>
        <el-form-item label="退回至节点">
          <el-select
            v-model="returnTargetNodeKey"
            placeholder="选择退回目标节点"
            aria-label="选择退回目标节点"
            class="ms-w-100pct"
          >
            <el-option
              v-for="node in returnableNodes"
              :key="node.key"
              :label="node.label"
              :value="node.key"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="MEMBER_ACTION_DIALOG_GRAMMAR.return.commentLabel">
          <el-input
            v-model="actionComment"
            type="textarea"
            :rows="MEMBER_ACTION_DIALOG_GRAMMAR.return.commentRows"
            :placeholder="MEMBER_ACTION_DIALOG_GRAMMAR.return.commentPlaceholder"
            :aria-label="MEMBER_ACTION_DIALOG_GRAMMAR.return.commentLabel"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="returnDialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="inFlightAction === 'return'"
          :disabled="!returnTargetNodeKey"
          data-testid="approval-return-submit"
          @click="submitReturn"
        >
          {{ MEMBER_ACTION_DIALOG_GRAMMAR.return.confirmLabel }}
        </el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import {
  Check,
  Close,
  Right,
  ChatDotSquare,
  Bell,
  RefreshLeft,
  CirclePlus,
  Remove,
} from '@element-plus/icons-vue'
import type { ApprovalActionType, ApprovalAssignmentDTO, ApprovalGraph } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { markApprovalRead, remindApproval, type ApprovalDirectoryUser } from '../../approvals/api'
import { ensureUserNamesResolved, getResolvedUserName } from '../../approvals/directoryResolve'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import { useAuth } from '../../composables/useAuth'
import { useFeatureFlags } from '../../stores/featureFlags'
import { useMobileViewport } from '../../composables/useMobileViewport'
import {
  buildDetailRowsForDisplay,
  buildDisplayFields,
  findDetailFieldInSchema,
  type DetailDisplayColumn,
  type DetailDisplayTable,
  type DisplayField,
} from '../../approvals/detailField'
import {
  collectAttachmentRefIds,
  collectHistoryAttachmentRefIds,
  formatAttachmentSize,
  resolveAttachmentFields,
  resolveProcessAttachmentRefs,
  type AttachmentFieldDisplay,
  type AttachmentRefMetadata,
  type ResolvedAttachmentRef,
} from '../../approvals/attachmentRefs'
import {
  deleteApprovalAttachment,
  fetchApprovalAttachmentRefs,
  uploadApprovalProcessAttachmentsAtomic,
} from '../../approvals/attachmentUpload'
import { fetchApprovalAttachmentBlob } from '../../approvals/attachmentDownload'
import { phrasesForAction, recentPhrases, rememberPhrase } from '../../approvals/quickPhrases'
import { formatRelativeWait, waitSeverity } from '../../approvals/relativeWait'
import { buildUpcomingNodes, type UpcomingApprovalNode } from '../../approvals/upcomingNodes'
import { ADD_SIGN_MODE_HINT, CLIENT_ADD_SIGN_MODE } from '../../approvals/addSignHonestyCopy'
import { memberActionFailure } from '../../approvals/memberActionErrorCopy'
import { MEMBER_ACTION_DIALOG_GRAMMAR, ACTION_DIALOG_TEST_ID } from '../../approvals/memberActionDialogGrammar'
import StatusTag from '../../components/status/StatusTag.vue'
import AsyncStateBlock from '../../components/status/AsyncStateBlock.vue'
// S3b: the 全文评论 tab wrapper. This file itself does not import shared/comments directly —
// ApprovalCommentsPanel.vue is the actual shared/comments importer the P3-A census tripwire
// (approval-member-identity-coverage-enumeration.spec.ts) triages.
import ApprovalCommentsPanel from './ApprovalCommentsPanel.vue'
import { resolveStatusDisplay } from '../../utils/statusDomains'

const route = useRoute()
const router = useRouter()
const store = useApprovalStore()
const templateStore = useApprovalTemplateStore()
const { canAct } = useApprovalPermissions()
const actionCommentInputRef = ref<{ focus: () => void } | null>(null)
const MEMBER_ACTION_DIALOG_WIDTH = 'min(480px, calc(100vw - 32px))'
const MEMBER_ACTION_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusActionComment(): void {
  actionCommentInputRef.value?.focus()
}

// Element Plus 2.11.8 can release focus to <body> at the dialog's Tab boundary in Chromium.
// Keep the member-action dialogs modal for keyboard users without changing their interior order.
function trapMemberActionDialogFocus(event: KeyboardEvent): void {
  const root = event.currentTarget
  if (!(root instanceof HTMLElement)) return

  const focusable = Array.from(root.querySelectorAll<HTMLElement>(MEMBER_ACTION_FOCUSABLE_SELECTOR))
    .filter((element) => {
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    })
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return

  if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

// T3-1 v0 — mobile approval surface (ballot Q8/Q11). When the tenant/user has
// opted into `approvalMobile` AND the viewport is narrow, the action bar is
// restricted to the v0 mobile action set — approve / reject / comment — and the
// deferred actions (transfer / return / add-sign / reduce-sign / revoke /
// remind) are hidden. The flag is loaded by the app shell; this view only reads
// it, so with the flag OFF the desktop action bar is unchanged for every
// viewport.
const { hasFeature, features: productFeatures } = useFeatureFlags()
const { isMobile } = useMobileViewport()
const isMobileLayout = computed(() => hasFeature('approvalMobile') && isMobile.value)
// B3-07: the new attachment pipeline is default OFF. Flag OFF still renders legacy
// attachment string/object snapshot values inline (no refs endpoint); flag ON uses the
// auth-proxied refs resolver + download block below.
const attachmentPipelineEnabled = computed(() => productFeatures?.value?.approvalAttachments === true)

const approval = computed(() => store.activeApproval)
// PageHeader requires a non-optional title; before the detail loads (or on error) fall back to
// the same generic copy the original hand-rolled `<h1 v-if="approval">` used.
const headerTitle = computed(() => approval.value?.title ?? '审批详情')

// ---------------------------------------------------------------------------
// UI-6 (master §4 UI-6 / P5 "add detail tabs/record projection … only from
// existing authoritative data"): tab anchors + audit-derived record table.
// Chrome only — no new action/verb/dialog, no new endpoint, no second fetch;
// both the tabs and the table read the SAME `approval`/`store.history` this
// view already loads. The existing parallel-aware timeline is NOT replaced —
// it remains the default 审批记录 content, byte-for-byte unchanged; the table
// is an additional toggle-able projection of the same source array.
// ---------------------------------------------------------------------------
const formSectionRef = ref<HTMLElement | null>(null)
const timelineSectionRef = ref<HTMLElement | null>(null)
const commentsSectionRef = ref<HTMLElement | null>(null)

type DetailAnchorSection = 'form' | 'record' | 'comments'
const activeDetailTab = ref<DetailAnchorSection>('record')

// S3b (2026-08-22): 全文评论 is no longer a dud. P3-2 (gate fix round, 2026-08-17) left it
// pointed at the SAME timeline region as 审批记录 because the only "comment" data then visible
// was inline `action === 'comment'` history rows, and the action bar (the alternative target
// tried and reverted at the time) renders no comment text at all either. The real fix named as
// deferred there — "an actual `action === 'comment'`-filtered projection" — landed differently
// than that sentence predicted: not a filtered history projection, but the S2 `approval_comments`
// mutable-comment surface (create/edit/delete/reply, HISTORY-TIMELINE arm (i) excludes its
// pointer rows from /history on purpose — comments render ONLY here, never re-hydrated into the
// timeline). 全文评论 now has its own section (`commentsSectionRef`, below) and its own anchor
// target, separate from 审批记录's `timelineSectionRef`.
// `commentsActivated` lazy-mounts `ApprovalCommentsPanel` (and therefore its first comments +
// mention-candidate fetch) on first activation only — the tab click itself still never mutates
// store state or dispatches a store action; it flips a local flag and scrolls.
const commentsActivated = ref(false)
function scrollToDetailSection(section: DetailAnchorSection): void {
  activeDetailTab.value = section
  if (section === 'comments') commentsActivated.value = true
  const target = section === 'form'
    ? formSectionRef.value
    : section === 'comments'
      ? commentsSectionRef.value
      : timelineSectionRef.value
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

type RecordView = 'timeline' | 'table'
const recordView = ref<RecordView>('timeline')

// P2-1 fix (gate PROBE B): the table view is desktop-only chrome — `isMobileLayout` is a LIVE
// computed (resize-driven, not mount-time-frozen), so a desktop→mobile viewport transition while
// `recordView === 'table'` must not strand the user on a table with no timeline and no way back.
// Belt+suspenders: the template gate (`!isMobileLayout` on the table's own `v-if`, below) is the
// primary defense; this watcher additionally restores the desktop choice to 'timeline' so the
// toggle itself never has to be touched again once the viewport widens back out.
watch(isMobileLayout, (mobile) => {
  if (mobile) recordView.value = 'timeline'
})

interface RecordTableRow {
  id: string
  nodeName: string
  actorName: string
  resultLabel: string
  timestamp: string | null
  action: string | null
  metadata: Record<string, unknown> | null
  synthetic: boolean
}

// Audit-derived record table: 提交 (from the instance's own `createdAt`/`requester` —
// never re-derived from a guessed history row) and 结束 (there is no 'end'/'complete'
// history ACTION in `UnifiedApprovalHistoryDTO['action']` at all — the backend never
// records process completion as an audit row, only the instance's own `status`/
// `updatedAt` say it happened) are computed HERE, at presentation time only, and are
// never written back into `store.history` or any outgoing payload — see
// `submitAction`/`submitComment`/etc. below, none of which read from this computed.
//
// P2-2 fix: 提交 is synthesized ONLY when `store.history` has no `created` row of its own —
// a STRUCTURAL predicate (`store.history.some((h) => h.action === 'created')`), not a value
// heuristic keyed on actor/timestamp coincidence (which would silently break the moment
// `created.occurredAt` drifts a few ms from `instance.createdAt`, the requester is renamed
// post-submission, or a null `actorName` falls back to '系统'). The audit trail's own `created`
// row is itself an audit row and wins the tie per §P5's "audit rows are the only history
// source" — synthesizing a second 提交 on top of it duplicated the submission on every normal
// instance. `actionLabel`'s map (`created: '发起'`) is exhaustive for created-ish actions, so
// this predicate never double-counts a differently-spelled equivalent.
// 结束 is added only once the instance has actually concluded (`status !== 'pending'`,
// mirroring the existing "该审批已结束" alert below) so a still-in-flight approval is
// never shown as finished. Every other row maps 1:1 to a `store.history` entry, reusing
// the exact same label/badge helpers the timeline renders (`actionLabel`, `nodeLabel`,
// `hasTimelineMetadata`, `cancelledAssigneesLabel`, `approvalModeLabel`) so the two views
// of the same data never drift.
const recordTableRows = computed<RecordTableRow[]>(() => {
  const detail = approval.value
  if (!detail) return []
  const hasCreatedRow = store.history.some((item) => item.action === 'created')
  const rows: RecordTableRow[] = []
  if (!hasCreatedRow) {
    rows.push({
      id: '__submit',
      nodeName: '提交',
      actorName: detail.requester?.name ?? '-',
      resultLabel: '提交',
      timestamp: detail.createdAt ?? null,
      action: null,
      metadata: null,
      synthetic: true,
    })
  }
  for (const item of store.history) {
    rows.push({
      id: item.id,
      nodeName: item.metadata?.nodeKey ? nodeLabel(item.metadata.nodeKey as string) : '-',
      actorName: item.metadata?.autoApproved ? '系统自动审批' : (item.actorName ?? '系统'),
      resultLabel: actionLabel(item.action, item.metadata),
      timestamp: item.occurredAt ?? null,
      action: item.action,
      metadata: item.metadata ?? null,
      synthetic: false,
    })
  }
  if (detail.status !== 'pending') {
    rows.push({
      id: '__end',
      nodeName: '结束',
      actorName: '-',
      resultLabel: resolveStatusDisplay('approvalInstance', detail.status, true).label,
      timestamp: detail.updatedAt ?? null,
      action: null,
      metadata: null,
      synthetic: true,
    })
  }
  return rows
})

// B1-03: 已等待 chip — a glanceable "how long has this been sitting" cue next to the status tag,
// only meaningful while the instance is still pending (once resolved, `updatedAt`/the history
// timeline already tell that story). Severity mirrors the list view's warn/urgent bands.
const waitChipLabel = computed(() => (approval.value ? formatRelativeWait(approval.value.createdAt) : ''))
const waitChipType = computed(() => {
  const severity = approval.value ? waitSeverity(approval.value.createdAt) : 'normal'
  if (severity === 'urgent') return 'danger'
  if (severity === 'warn') return 'warning'
  return 'info'
})

// Read-only detail (明细) tables, keyed by snapshot field id. Built from the instance's FROZEN
// formSchema (C-3a read-path) so a later column rename/reorder on the live template never
// mis-renders frozen rows. A key is present only when the field is a `detail` carrying
// `columns` AND its snapshot value is an array; everything else falls back to stringify.
const detailTables = computed<Record<string, DetailDisplayTable>>(() => {
  const snapshot = approval.value?.formSnapshot
  const formSchema = approval.value?.formSchema
  if (!snapshot || !formSchema) return {}
  const result: Record<string, DetailDisplayTable> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    const detailField = findDetailFieldInSchema(formSchema, key)
    if (!detailField) continue
    const table = buildDetailRowsForDisplay(detailField, value)
    if (table) result[key] = table
  }
  return result
})

// B1-02: humanized scalar fields (label + formatted value, schema-ordered) — see
// `buildDisplayFields` for the full contract. `detail` fields are excluded; they render via
// `detailTables` above. Attachment fields are included ONLY while the pipeline flag is OFF
// (legacy string/object values); flag ON excludes them so the refs block owns rendering.
const displayFields = computed<DisplayField[]>(() =>
  buildDisplayFields(approval.value?.formSchema ?? null, approval.value?.formSnapshot ?? null, {
    attachmentPipelineEnabled: attachmentPipelineEnabled.value,
  }),
)

// B3-07 §8 (#4195): resolve the snapshot's frozen attachment ids → metadata for the authorized
// participants of THIS instance. The server applies the same visibility + hidden-field predicates the
// byte path uses, so this view never has to (and never could) re-derive them. Fail-closed and quiet:
// any failure leaves `attachmentMetadata` empty, which renders no attachment block at all rather than
// a block of ids with fabricated names. Flag OFF: never call the new endpoint — legacy values render
// via `displayFields` above.
const attachmentMetadata = ref<AttachmentRefMetadata[]>([])
const attachmentFields = computed<AttachmentFieldDisplay[]>(() => {
  if (!attachmentPipelineEnabled.value) return []
  return resolveAttachmentFields(
    approval.value?.formSchema ?? null,
    approval.value?.formSnapshot ?? null,
    attachmentMetadata.value,
  )
})

/**
 * Lock-9 OD-L9-10(a) render path — process-attachment refs for ONE timeline entry. Proposal, not a
 * ruling: OD-L9-14 ratifies THAT every participant can read a bound process attachment; WHERE it
 * renders on the detail surface is unruled (§(c)-3 of the scouting brief) — this slice's answer is
 * the timeline entry the `comment` action produced. The 审批记录 TABLE view (`recordView ===
 * 'table'`, a separate projection of the same `store.history`) deliberately does NOT get this
 * block in this slice — see the PR body.
 *
 * STALE-COMMENT UPDATE (#5104, the backend companion this docblock originally asked for): the
 * platform branch of `GET /api/approvals/:id/history` now projects ONE metadata key —
 * `metadata: { attachmentIds }`, ONLY when a row's rider ids are non-empty — so THIS function
 * (which reads exactly `item.metadata?.attachmentIds`) now resolves refs for a platform instance's
 * rider row too, not only a PLM-bridged one. That is the FULL extent of the reconciliation: #5104
 * is additive-only and deliberately does NOT touch any other metadata key or rename any snake_case
 * field. Concretely still open, same as before #5104 (deliberately NOT line-pinned — these move):
 *   - `item.metadata?.nodeKey` is NEVER populated by the platform branch, so the `timelineBranchGroups`
 *     parallel-branch grouping above, the "节点: …" `approval-detail__meta-badge` span guarded by
 *     `item.metadata?.nodeKey` (both timeline renders), and `recordTableRows`' `nodeName` field all
 *     stay PLM-only — camelCase/snake_case-DTO-shaped work, out of #5104's additive-only scope.
 *   - Real `actor_name`/`occurred_at` vs. a synthesized display still needs the same
 *     snake_case-row-vs-camelCase-DTO reconciliation this docblock originally flagged; #5104 did
 *     not touch those fields either.
 * So: attachmentIds-only refs now render for platform instances; branch-grouping-by-node and the
 * broader DTO-shape gap do not, and are not this PR's claim.
 */
function processAttachmentRefsForHistoryItem(item: { metadata?: Record<string, unknown> }): ResolvedAttachmentRef[] {
  if (!attachmentPipelineEnabled.value) return []
  return resolveProcessAttachmentRefs(item.metadata?.attachmentIds, attachmentMetadata.value)
}

async function handleAttachmentDownload(ref: AttachmentFieldDisplay['refs'][number]): Promise<void> {
  if (!ref.downloadUrl || !ref.fileName) return
  try {
    const blob = await fetchApprovalAttachmentBlob({ downloadUrl: ref.downloadUrl, fileName: ref.fileName })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = ref.fileName
    link.rel = 'noopener'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  } catch {
    ElMessage.error('附件下载失败，请稍后重试')
  }
}

async function loadAttachmentMetadata(): Promise<void> {
  // Flag OFF (default): never hit the new refs endpoint — legacy values stay on the scalar path.
  if (!attachmentPipelineEnabled.value) {
    attachmentMetadata.value = []
    return
  }
  const instance = approval.value
  if (!instance) {
    attachmentMetadata.value = []
    return
  }
  // Lock-9 OD-L9-10(a): union the form-field ids (snapshot-scoped) with the process-attachment ids
  // staged on `comment` history rows (`metadata.attachmentIds`) into ONE `/refs` call — the server
  // applies the same per-instance authorization to both id shapes, so there is no reason to split
  // the round trip.
  const ids = [
    ...new Set([
      ...collectAttachmentRefIds(instance.formSchema ?? null, instance.formSnapshot ?? null),
      ...collectHistoryAttachmentRefIds(store.history),
    ]),
  ]
  if (ids.length === 0) {
    attachmentMetadata.value = []
    return
  }
  try {
    attachmentMetadata.value = await fetchApprovalAttachmentRefs(ids, instance.id)
  } catch {
    attachmentMetadata.value = [] // fail-closed: render nothing rather than unresolved ids
  }
}

watch(
  // Lock-9 OD-L9-10(a): `store.history` MUST be a tracked dependency here — process-attachment ids
  // live only on history-row metadata, and history loads asynchronously (often AFTER `approval`
  // itself resolves). Without this, the immediate first run fires off the ids known at that
  // instant, resolves them, and then never re-runs when `loadHistory` lands a moment later — every
  // process attachment silently never appears, permanently, for every viewer. Dropping this
  // dependency is the single most likely way to regress this slice; see
  // `approval-process-attachment-dialog.spec.ts`'s dedicated regression test for the proof.
  () => [approval.value?.id, approval.value?.formSnapshot, attachmentPipelineEnabled.value, store.history] as const,
  () => {
    void loadAttachmentMetadata()
  },
  { immediate: true },
)

// B1-01: real session identity — the previous `=== 'user_1'` mock meant production requesters
// NEVER saw the requester-only actions (撤回/催办) this view already ships. Seeded SYNCHRONOUSLY
// from the session cache so the first paint is already correct (no requester-actions pop-in);
// a cold cache falls back to the async lookup in onMounted. Until either resolves the requester
// affordances simply stay hidden (fail-closed).
const auth = useAuth()
const currentUserId = ref<string | null>(((): string | null => {
  const user = auth.getCurrentUser?.()
  const id = user && typeof user === 'object' ? (user as { id?: unknown }).id : null
  return typeof id === 'string' && id.length > 0 ? id : null
})())

const isRequester = computed(() => {
  return !!currentUserId.value && approval.value?.requester?.id === currentUserId.value
})

// B3-13 撤回策略感知: the instance DTO's `policy` snapshot carries `allowRevoke`, written at
// creation from the published runtime graph (backend ApprovalProductService — the same flag the
// server enforces fail-closed on the revoke action with 409 APPROVAL_REVOKE_DISABLED). It had 0
// FE consumers: every requester saw a 撤回 button that, on a 撤回-disabled template, could only
// fail at click time. STRICT `=== true`: an absent/legacy/null policy (e.g. externally-synced
// instances) hides the affordance — fail-closed, mirroring the backend's default-deny for
// instances without a runtime graph. Consumes the existing flag only; no new policy invented.
const allowRevoke = computed(() => approval.value?.policy?.allowRevoke === true)

// Lock-5 §2.3 / gate A-2 — the member-bar mirror of the per-node operation policy.
//
// The values are RESOLVED BY THE SERVER (`nodeOperations`, scoped to THIS viewer's own active
// seats) and merely rendered here. That is the point: §2.3 requires the FE mirror to derive from
// the SAME config the server enforces, with no second predicate, so the two doors cannot drift.
// The server remains the authority — hiding a button is never the guard, and a direct HTTP call
// still gets 409 `APPROVAL_NODE_OPERATION_DISABLED`.
//
// ABSENT ≡ ALLOWED (OD-L5-3(a)), deliberately the OPPOSITE of `allowRevoke`'s `=== true`
// fail-closed idiom above. Copying that idiom would hide all four verbs on every pre-Lock-5
// instance, on every bridged instance with no runtime graph, and for every seatless viewer.
const nodeOperations = computed(() => approval.value?.nodeOperations ?? null)
const allowTransfer = computed(() => nodeOperations.value?.allowTransfer !== false)
const allowAddSign = computed(() => nodeOperations.value?.allowAddSign !== false)
const allowReduceSign = computed(() => nodeOperations.value?.allowReduceSign !== false)
const allowReturn = computed(() => nodeOperations.value?.allowReturn !== false)

// UX B2-13 (再次提交) — the reject→fix→resubmit loop is a requester's biggest-friction moment
// today (hand-retype the whole form). Eligible ONLY for the CURRENT USER'S OWN instance (reuses
// `isRequester` above) in a TERMINAL state that means "this didn't go through and nothing
// downstream is acting on it any more": rejected / revoked / cancelled. `approved` is deliberately
// EXCLUDED — it already succeeded, there is nothing to fix/resubmit. An instance with no
// `templateId` (e.g. synced in from an external source system) has no fill-form to route back to,
// so it is excluded too — fail-closed rather than a dead button.
const RESUBMIT_ELIGIBLE_STATUSES = new Set(['rejected', 'revoked', 'cancelled'])
const canResubmit = computed(() => {
  const detail = approval.value
  if (!detail || !isRequester.value || !detail.templateId) return false
  return RESUBMIT_ELIGIBLE_STATUSES.has(detail.status)
})

// B1-01: "等待你处理" cue — the reader holds a still-active user assignment at the current
// node (or any branch of a parallel region). Mirrors, not replaces, the server-side action gate.
const isMyTurn = computed(() => {
  const me = currentUserId.value
  const detail = approval.value
  if (!me || !detail || detail.status !== 'pending') return false
  const currentKeys = new Set(currentActiveNodeKeys.value)
  if (currentKeys.size === 0) return false
  return detail.assignments.some(
    (a) => a.isActive && a.type === 'user' && a.assigneeId === me && !!a.nodeKey && currentKeys.has(a.nodeKey),
  )
})

// Parallel gateway (并行分支) — the instance is inside a parallel region when
// the backend surfaces `currentNodeKeys` with at least two entries. Templates
// with a single-branch fallback or any other shape leave the field absent, so
// existing linear-flow rendering is untouched.
const parallelBranchNodeKeys = computed<string[]>(() => {
  const nodeKeys = approval.value?.currentNodeKeys
  return Array.isArray(nodeKeys) ? nodeKeys : []
})
const isInParallelRegion = computed(() => parallelBranchNodeKeys.value.length >= 2)

interface TimelineGroup {
  key: string
  label: string
  items: typeof store.history
}

// Group the history timeline by the approval-node key each entry targets so a
// reviewer can scan each branch's decisions without interleaving. Entries
// that lack a `metadata.nodeKey` (e.g. the 'created' row or cc broadcasts
// from before the parallel fork) land in an "其他" group rendered last. The
// group order follows first-seen order in the timeline, so branches appear
// in the order the backend recorded them.
const timelineBranchGroups = computed<TimelineGroup[]>(() => {
  if (!isInParallelRegion.value) return []
  const buckets = new Map<string, TimelineGroup>()
  const order: string[] = []
  const OTHER_KEY = '__other'
  for (const item of store.history) {
    const nodeKey = typeof item.metadata?.nodeKey === 'string' ? item.metadata.nodeKey : null
    const bucketKey = nodeKey && parallelBranchNodeKeys.value.includes(nodeKey) ? nodeKey : OTHER_KEY
    if (!buckets.has(bucketKey)) {
      order.push(bucketKey)
      buckets.set(bucketKey, {
        key: bucketKey,
        label: bucketKey === OTHER_KEY ? '其他' : nodeLabel(bucketKey),
        items: [],
      })
    }
    buckets.get(bucketKey)!.items.push(item)
  }
  return order.map((key) => buckets.get(key)!)
})

// ---------------------------------------------------------------------------
// UX B2-08: current handler + upcoming nodes ("卡在谁那里 / 接下来到谁")
// ---------------------------------------------------------------------------
// The history timeline above only ever has PAST actions — there is no history row for the
// CURRENTLY open step — so a requester can't tell who it's stuck with or what comes next. This
// synthesizes that (NOT real history rows) and is rendered at the very end of the timeline, only
// while the instance is still `pending`.

// Every node key with an active pending assignment right now. Single source of truth for both
// `isMyTurn` (above) and `currentHandlerEntries` (below) — mirrors the same parallel-vs-linear
// resolution `isMyTurn` used inline before this slice.
const currentActiveNodeKeys = computed<string[]>(() => {
  if (!approval.value) return []
  if (parallelBranchNodeKeys.value.length > 0) return parallelBranchNodeKeys.value
  return approval.value.currentNodeKey ? [approval.value.currentNodeKey] : []
})

interface CurrentHandlerEntry {
  assignmentId: string
  label: string
  wait: string
}

// `assignment.metadata` carries no display name today — only `assigneeId` (see
// `ApprovalAssignmentDTO`). Prefers a future `metadata.assigneeName` if the backend ever adds one.
//
// P7-R2 gate hardening (P2-2): this used to fall back to the raw `assigneeId`, rendered
// unconditionally at `当前处理人：{{ entry.label }}` on every PENDING instance with an active user
// assignment — the single most reachable member-facing raw-id leak found in this file (not an
// exotic drift shape, the ordinary case). `metadata.assigneeName` has zero producers repo-wide
// today, so this reachable branch was effectively always the values-free "审批人" placeholder.
//
// member-display-identity (2026-08-19): now tries the shared authorized-scope resolver
// (`getResolvedUserName`, backed by `/api/approvals/directory/resolve`) BEFORE falling back to
// the generic placeholder — `currentHandlerEntries` below `ensureUserNamesResolved`s every id in
// view, so a resolvable assignee now shows their real name instead of "审批人". Still values-free
// on a miss (deactivated account / unresolved): the SAME generic placeholder as before, never the
// raw id.
function assignmentDisplayLabel(assignment: ApprovalAssignmentDTO): string {
  const metaName = assignment.metadata.assigneeName
  if (typeof metaName === 'string' && metaName.trim()) return metaName.trim()
  const resolved = getResolvedUserName(assignment.assigneeId)
  if (resolved) return resolved
  return '审批人'
}

// One entry per ACTIVE assignment at the current node(s) — every currently-pending handler, not
// just "is it me" (that's `isMyTurn`). `wait` reuses `formatRelativeWait` (B1-03) against
// `updatedAt` rather than `createdAt`: an assignment row carries no timestamp of its own, and
// `updatedAt` — bumped whenever an action actually moves/changes the instance, but NOT by a plain
// comment (see backend `ApprovalProductService`) — approximates "since this step became current"
// far better than the header chip's `createdAt` (since the whole approval was first created).
const currentHandlerEntries = computed<CurrentHandlerEntry[]>(() => {
  const detail = approval.value
  if (!detail || detail.status !== 'pending') return []
  const keys = new Set(currentActiveNodeKeys.value)
  if (keys.size === 0) return []
  const wait = formatRelativeWait(detail.updatedAt)
  return detail.assignments
    .filter((a) => a.isActive && !!a.nodeKey && keys.has(a.nodeKey))
    .map((a) => ({ assignmentId: a.id, label: assignmentDisplayLabel(a), wait }))
})

// member-display-identity (2026-08-19): kicks off the batch resolve for every member id this view
// might need to display a name for — every `assignments` row's `assigneeId` (feeds
// `assignmentDisplayLabel`/`reducibleAssignees` above/below) PLUS every history item's
// `metadata.aggregateCancelled` id list (feeds `cancelledAssigneesLabel` below). A single
// consolidated `watch` (side effect) rather than one per consumer — they draw from overlapping id
// universes and Vue de-dupes redundant `ensureUserNamesResolved` calls internally anyway. Never
// inside a `computed` — mutating the resolver's cache from within a computed that itself reads
// that cache would be a self-triggering dependency.
watch(
  () => {
    const ids: string[] = []
    for (const a of approval.value?.assignments ?? []) ids.push(a.assigneeId)
    for (const item of store.history) {
      const cancelled = item.metadata?.aggregateCancelled
      if (Array.isArray(cancelled)) for (const id of cancelled) ids.push(String(id))
    }
    return ids
  },
  (ids) => ensureUserNamesResolved(ids),
  { immediate: true },
)

// Prefer the instance's FROZEN template version (pinned at creation) over the LIVE template
// loaded below for `nodeLabel` — the live template may have been edited (renamed/reordered/
// removed nodes) since this instance started, which would silently mis-render the "upcoming
// nodes" preview against a graph the instance will never actually traverse. Falls back to the
// live template when no pinned version was reachable (see `onMounted`) — DRIFT RISK: that
// fallback path can render upcoming nodes that no longer match this instance's real remaining
// path.
const pinnedGraph = computed<ApprovalGraph | null>(() => {
  return templateStore.activeVersion?.approvalGraph ?? templateStore.activeTemplate?.approvalGraph ?? null
})

// Parallel regions have no single unambiguous "current node" to walk forward from until the
// branches rejoin at their `joinNodeKey` — skip rather than fabricate a merged/guessed path (the
// "并行中" badge in the header already communicates the parallel state itself).
const upcomingTimelineNodes = computed<UpcomingApprovalNode[]>(() => {
  const detail = approval.value
  if (!detail || detail.status !== 'pending') return []
  if (isInParallelRegion.value) return []
  const currentNodeKey = detail.currentNodeKey
  if (!currentNodeKey) return []
  const graph = pinnedGraph.value
  if (!graph) return []
  return buildUpcomingNodes(graph, currentNodeKey, approval.value?.formSchema ?? null)
})

const actionDialogVisible = ref(false)
const transferDialogVisible = ref(false)
const commentDialogVisible = ref(false)
// Lock-9 OD-L9-10(a): files uploaded (process-attachment route) while the comment dialog is open
// but not yet bound to a `comment` action. `openCommentDialog` resets this to `[]`; `submitComment`
// clears it (WITHOUT deleting — the server has just bound them) BEFORE closing the dialog, so the
// close-watcher below only ever DELETEs uploads that were never submitted.
const commentStagedAttachments = ref<Array<{ id: string; name: string }>>([])
const commentAttachmentUploading = ref(false)
const commentAttachmentContextCurrent = computed(() => {
  const routeInstanceId = route.params.id
  return typeof routeInstanceId === 'string' && routeInstanceId !== '' && approval.value?.id === routeInstanceId
})
// Captured at each pick; incremented (invalidated) by retract BEFORE staged cleanup so a later-
// resolving upload cannot append into a closed/unmounted/switched context. Empty staged lists
// still invalidate — that is the in-flight-pick case (nothing to retract yet).
let commentAttachmentLifecycleGeneration = 0
// Cancel/close (取消 button, mask click, ESC — all flip `commentDialogVisible` via v-model) must
// retract any staged-but-never-bound process attachment: otherwise it sits as an unbound orphan
// until the 168h sweep AND keeps consuming the per-staged-instance upload budget (OD-L9-8's
// disclosed shape gap — see the PR body). Runs only when the list is non-empty, so the
// post-successful-submit close (list already cleared) never issues a DELETE for an id the server
// just bound.
//
// Lock-9 FE fix round (2026-08-22, gate P3-2): this watcher only fires on a `commentDialogVisible`
// true→false transition. Two exits never produce that transition and were leaking staged uploads:
// (a) unmounting this view entirely (route change to a DIFFERENT view) — no watcher on an unmounted
// component's own ref ever runs again; (b) 下一条/deep-link navigation, which changes
// `route.params.id` IN PLACE without unmounting (same precedent as this file's own `:key`
// comment above) — `commentDialogVisible` stays whatever it was across the reload. Factored into
// `retractStagedCommentAttachments` and called from both `onBeforeUnmount` and the params-id watch
// below, in addition to this close-watcher.
//
// Lock-9 C1: retract ALSO invalidates the in-flight pick token first. An upload that is still
// awaiting has not yet landed in `commentStagedAttachments`, so the empty-list early-return
// used to skip cleanup; when the deferred success resolved it appended onto the dead/switched
// instance. Dialog close uses this same retract, so it is covered without a third site.
function retractStagedCommentAttachments(): void {
  commentAttachmentLifecycleGeneration += 1
  commentAttachmentUploading.value = false
  const staged = commentStagedAttachments.value
  if (staged.length === 0) return
  commentStagedAttachments.value = []
  for (const item of staged) {
    void deleteApprovalAttachment(item.id).catch(() => {
      // Best-effort retraction: a transient DELETE failure leaves an unbound server-side orphan,
      // which the TTL/reconciler must collect — the dialog is already closed, there is no UI left
      // to report this failure into.
    })
  }
}

function isLiveCommentAttachmentPick(generation: number, instanceId: string): boolean {
  return generation === commentAttachmentLifecycleGeneration
    && commentAttachmentContextCurrent.value
    && approval.value?.id === instanceId
}

watch(commentDialogVisible, (visible, wasVisible) => {
  if (visible || !wasVisible) return
  retractStagedCommentAttachments()
})

onBeforeUnmount(() => {
  retractStagedCommentAttachments()
})
const returnDialogVisible = ref(false)
const currentAction = ref<ApprovalActionType>('approve')
const actionComment = ref('')
// B1-04, extended by P5-C-1: dialog-scoped failure message, now shared by ALL SIX member-action
// dialogs (approve/reject/comment originally; transfer/add-sign/reduce-sign/return joined in
// P5-C-1's failure-surfacing unification — see `handleMemberActionFailure` below). Cleared on
// every dialog's own `open*` / next submit attempt, so a stale error from one verb's dialog can
// never bleed into a freshly-opened OTHER dialog. The catch blocks set it INSTEAD OF a generic
// toast so the reader sees the server's actual reason without losing their typed comment/pick —
// the dialog stays open. A POLICY denial (§2.3) is the one exception: it still toasts (the honest
// copy) AND closes the dialog, so there is nothing for this ref to render. Non-dialog actions
// (revoke's popconfirm) are unaffected and keep their own toast (see `handleRevoke`).
const actionDialogError = ref<string | null>(null)
// B3-13 按动作 loading: which action's request is in flight right now (null = none). Each action
// button/dialog-confirm binds `:loading` to `inFlightAction === '<its action>'` so ONLY the
// button whose request is running spins/disables — the store-global `loading` flag (also set by
// plain detail/history refreshes) no longer freezes the whole bar. Every submit helper sets it
// in a try/finally, so it clears on success AND failure; the shared early-return below keeps the
// previous one-action-at-a-time behavior without visually disabling the other buttons.
const inFlightAction = ref<ApprovalActionType | null>(null)
const transferUserId = ref('')
const returnTargetNodeKey = ref('')
// P1-B 加签/减签 dialog state.
const addSignDialogVisible = ref(false)
const addSignUserIds = ref<string[]>([])
// B3-04 D-2: the repeated-pick picker's OWN transient slot (always reset to null after each pick
// so it is ready for the next one) + a display-name side map keyed by id (ApprovalUserPicker only
// carries ids in `addSignUserIds` — the submit payload shape — so the chip labels need their own
// lookup, populated from the picker's richer `select` event).
const addSignPickerValue = ref<string | null>(null)
const addSignUserLabels = ref<Record<string, string>>({})
// Lock-5 B-2: the mode is no longer user-selectable (the retired radio's two arms were
// byte-identical outside a parallel region). It stays in the SUBMIT PAYLOAD, pinned to the one
// semantic we implement, so the wire contract is unchanged for the server and for replay.
const reduceSignDialogVisible = ref(false)
const reduceSignUserId = ref('')

// P1-B 减签 picker — only previously add-signed (`metadata.addSign === true`),
// still-active, user-typed assignments at the CURRENT node are reducible.
// Requester-original / template-resolved / role rows are never listed (mirrors
// the backend `reduce_sign` `removable` predicate — INV-2).
//
// Values-free doctrine (mirrors `assignmentDisplayLabel` above): the option LABEL an admin reads
// must never be the raw internal `assigneeId` — `metadata.assigneeName` has zero producers
// repo-wide today, so this used to be the reachable, ordinary-path leak, not an exotic shape. The
// picker still needs its options MUTUALLY DISTINGUISHABLE (an admin must be able to tell which
// seat they are removing), so the fallback is a stable per-list ordinal (`成员 N`), not a single
// repeated generic string. `assigneeId` stays the option VALUE (the actual submit payload) —
// only the LABEL text changes.
//
// member-display-identity (2026-08-19) — owner directive: 减签 is a FLOW-CHANGING selector (it
// removes a real approval seat), so a member who cannot be resolved to an identifiable name must
// be DISABLED, never just relabelled with an ordinal and left pickable — a blind ordinal personnel
// change is exactly what this directive forbids. `disabled` is `true` for BOTH "not yet resolved"
// and "confirmed unresolved" (see directoryResolve.ts's tri-state doc) — there is no window where
// an unconfirmed option is briefly selectable. When resolved, the real name replaces the ordinal
// AND the option becomes selectable.
const reducibleAssignees = computed<Array<{ assigneeId: string; label: string; disabled: boolean }>>(() => {
  if (!approval.value || approval.value.status !== 'pending') return []
  const currentNodeKey = approval.value.currentNodeKey
  if (!currentNodeKey) return []
  const seen = new Set<string>()
  const result: Array<{ assigneeId: string; label: string; disabled: boolean }> = []
  let ordinal = 0
  for (const assignment of approval.value.assignments) {
    if (!assignment.isActive) continue
    if (assignment.type !== 'user') continue
    if (assignment.nodeKey !== currentNodeKey) continue
    if (assignment.metadata?.addSign !== true) continue
    if (seen.has(assignment.assigneeId)) continue
    seen.add(assignment.assigneeId)
    ordinal += 1
    const metaName = assignment.metadata?.assigneeName
    const trimmedMetaName = typeof metaName === 'string' ? metaName.trim() : ''
    const resolvedName = trimmedMetaName || getResolvedUserName(assignment.assigneeId)
    const label = resolvedName || `成员 ${ordinal}`
    result.push({ assigneeId: assignment.assigneeId, label, disabled: !resolvedName })
  }
  return result
})

const returnableNodes = computed(() => {
  if (!approval.value || approval.value.status !== 'pending') return []
  const currentNodeKey = approval.value.currentNodeKey
  const visited = new Set<string>()
  for (const h of store.history) {
    const nk = h.metadata?.nodeKey as string | undefined
    if (nk && nk !== currentNodeKey && nk !== 'start' && nk !== 'end') {
      visited.add(nk)
    }
  }
  return Array.from(visited).map((key) => ({
    key,
    label: nodeLabel(key),
  }))
})

const actionDialogTitle = computed(() =>
  currentAction.value === 'approve' ? '审批通过' : '审批驳回',
)

// B1-04: reject-comment pre-flight. `policy.rejectCommentRequired` defaults to "required" — only
// an explicit `false` waives it, so an absent/legacy policy snapshot stays conservative. Scoped to
// the reject action only; the 通过 dialog's "审批意见" stays optional (mirrors the add-sign
// disabled-until-complete pattern already used by `submitAddSign`/`submitReduceSign` below).
// Lock-5 §1.3 / gate CR-3 — derived from the EFFECTIVE (node-level, snapshot-fallback) requirement
// the server resolved, not from the `policy.rejectCommentRequired` literal. Three values, so the
// APPROVE side is wired too and not merely relabelled: `'always'` requires a comment on 通过 as well
// as 驳回, `'reject_only'` reproduces today exactly, `'never'` requires neither. The legacy literal
// stays the fallback for a bridged/legacy instance that ships no `nodeOperations`.
const effectiveCommentRequired = computed<'never' | 'reject_only' | 'always'>(() => {
  const resolved = approval.value?.nodeOperations?.commentRequired
  if (resolved) return resolved
  return approval.value?.policy?.rejectCommentRequired === false ? 'never' : 'reject_only'
})
const commentRequiredForAction = computed(() => {
  if (currentAction.value === 'reject') return effectiveCommentRequired.value !== 'never'
  if (currentAction.value === 'approve') return effectiveCommentRequired.value === 'always'
  return false
})
// Retained name: four template bindings and several specs key on the reject-side meaning.
const rejectCommentRequired = computed(() => currentAction.value === 'reject' && commentRequiredForAction.value)
const actionCommentLabel = computed(() => {
  if (rejectCommentRequired.value) return '驳回原因（必填）'
  return commentRequiredForAction.value ? '审批意见（必填）' : '审批意见'
})
const actionCommentPlaceholder = computed(() => (rejectCommentRequired.value ? '请填写驳回原因' : '请输入审批意见'))
const actionConfirmDisabled = computed(() => commentRequiredForAction.value && !actionComment.value.trim())

// B1-05: quick-phrase chips for whichever action's dialog is currently open — this user's own
// recently-used phrases (most-recent-first) first, then the fixed preset list, deduped, capped
// at 5. `currentAction` is kept in sync with the open dialog by `openActionDialog`/
// `openCommentDialog` below.
const quickPhraseChips = computed<string[]>(() => {
  const merged = [...recentPhrases(currentUserId.value, currentAction.value), ...phrasesForAction(currentAction.value)]
  return Array.from(new Set(merged)).slice(0, 5)
})

function applyQuickPhrase(phrase: string): void {
  actionComment.value = actionComment.value ? `${actionComment.value}，${phrase}` : phrase
}

/**
 * Only remembers a submitted comment as a quick-phrase shortcut when it exactly matches one of
 * the phrases OFFERED for the currently open dialog's action (recent ∪ preset, i.e.
 * `quickPhraseChips` at submit time) — free-typed comments are never persisted, so this can't
 * become a backdoor free-text log.
 */
function rememberQuickPhraseIfOffered(comment: string): void {
  if (!quickPhraseChips.value.includes(comment)) return
  rememberPhrase(currentUserId.value, currentAction.value, comment)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// UF-3: the header status tag now renders via <StatusTag domain="approvalInstance"> (see
// utils/statusDomains.ts). `statusTagType` stays — it's still used below by
// `timelineActionTagType` to color the timeline's per-entry ACTION tag (approve/reject/pending
// are borrowed here as an action-outcome palette, not a rendered instance status — the timeline's
// own event-kind badges like 自动审批/会签完成/退回 are a separate, out-of-scope concept; see
// `.approval-detail__meta-badge*`).
function statusTagType(status: string) {
  const map: Record<string, string> = {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    revoked: 'info',
    cancelled: 'info',
  }
  return map[status] ?? ''
}

function actionLabel(action: string, metadata?: Record<string, unknown>) {
  if (action === 'approve' && metadata?.autoApproved) return '自动通过'
  if (action === 'sign' && metadata?.autoCancelled) return '自动失效'
  const map: Record<string, string> = {
    created: '发起',
    approve: '通过',
    reject: '驳回',
    transfer: '转交',
    revoke: '撤回',
    comment: '评论',
    return: '退回',
    sign: '签字',
    add_sign: '加签',
    reduce_sign: '减签',
    cc: '抄送',
    // Lock-3 §2.1 — a handler submission renders as 办理 in the timeline (never the raw English verb).
    handle: '办理',
  }
  return map[action] ?? action
}

// G-B2-09: initial-letter avatar for timeline actors — display only, token-styled.
function actorInitial(item: { actorName?: string | null; metadata?: Record<string, unknown> | null }): string {
  if (item.metadata?.autoApproved) return '系'
  const name = (item.actorName ?? '').trim()
  return name ? Array.from(name)[0]! : '系'
}

function timelineItemType(action: string, toStatus: string): string {
  if (action === 'return') return 'warning'
  if (action === 'approve') return 'success'
  if (action === 'reject') return 'danger'
  if (action === 'transfer') return 'warning'
  if (action === 'revoke') return 'warning'
  if (toStatus === 'pending') return 'primary'
  return 'info'
}

function timelineActionTagType(action: string, metadata?: Record<string, unknown>): string {
  if (action === 'approve' && metadata?.autoApproved) return 'info'
  if (action === 'return') return 'warning'
  return statusTagType(action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending')
}

function timelineIcon(action: string, metadata?: Record<string, unknown>) {
  if (action === 'return') return RefreshLeft
  if (action === 'approve' && metadata?.autoApproved) return Bell
  const map: Record<string, any> = {
    approve: Check,
    reject: Close,
    transfer: Right,
    comment: ChatDotSquare,
    cc: Bell,
    revoke: RefreshLeft,
    add_sign: CirclePlus,
    reduce_sign: Remove,
  }
  return map[action] ?? undefined
}

function hasTimelineMetadata(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false
  return !!(
    metadata.autoApproved
    || metadata.approvalMode
    || metadata.aggregateComplete
    || metadata.aggregateCancelled
    || metadata.autoCancelled
    || metadata.aggregateCancelledBy
    || metadata.nodeKey
    || metadata.targetNodeKey
  )
}

// UI-6: table-specific variant of `hasTimelineMetadata` above. The table has its OWN 节点名称
// column, so a bare `metadata.nodeKey` (with nothing else) must not open an empty
// `.approval-detail__timeline-meta` container the way the timeline's combined
// header+badges block tolerates — this mirrors exactly the badge `v-if`s actually rendered in
// the table cell below (autoApproved / approvalMode / aggregateComplete /
// cancelledAssigneesLabel / sign+autoCancelled / return+targetNodeKey), nothing more.
function hasRecordTableBadgeMetadata(metadata?: Record<string, unknown> | null, action?: string | null): boolean {
  if (!metadata) return false
  return !!(
    metadata.autoApproved
    || metadata.approvalMode
    || metadata.aggregateComplete
    || cancelledAssigneesLabel(metadata)
    || (action === 'sign' && metadata.autoCancelled)
    || (action === 'return' && metadata.targetNodeKey)
  )
}

function approvalModeLabel(mode: string): string {
  const map: Record<string, string> = { single: '单人', all: '会签', any: '或签' }
  return map[mode] ?? mode
}

/**
 * Builds a muted note listing sibling approvers whose active assignments were cancelled by
 * an any-mode (或签) first-wins resolution. Returns empty string when metadata carries no
 * aggregateCancelled list or when the list is empty — callers `v-if` on the truthy string.
 */
// P7-R2 candidate #2 fix (values-free doctrine, confirmed member-facing raw-id exposure): resolve
// each cancelled sibling to a display name — first from data already in scope (the instance's own
// `assignments` array's `metadata.assigneeName`, if a producer ever sets it), then (2026-08-19)
// from the shared authorized-scope resolver cache (`getResolvedUserName`, ensured by the
// consolidated watcher above). If EVERY id resolves to a real name, join the names; if any id has
// no reachable name, fall back to a values-free count instead of a partial name list padded with a
// repeated generic placeholder (which would read as a formatting bug more than a redaction).
// Either branch, a raw user id is never rendered.
function cancelledAssigneesLabel(metadata?: Record<string, unknown>): string {
  if (!metadata) return ''
  const cancelled = metadata.aggregateCancelled
  if (!Array.isArray(cancelled) || cancelled.length === 0) return ''
  const assignments = approval.value?.assignments ?? []
  const names: string[] = []
  for (const id of cancelled) {
    const idStr = String(id)
    const match = assignments.find((a) => a.assigneeId === idStr)
    const metaName = match?.metadata?.assigneeName
    if (typeof metaName === 'string' && metaName.trim()) {
      names.push(metaName.trim())
      continue
    }
    const resolved = getResolvedUserName(idStr)
    if (resolved) {
      names.push(resolved)
      continue
    }
    // No display name reachable from already-loaded metadata OR the resolver — render a
    // values-free count rather than ever falling back to the raw id.
    return `其他 ${cancelled.length} 位审批人已失效`
  }
  return `其他审批人已失效: ${names.join('、')}`
}

// P7-R2 candidate #3 fix (values-free doctrine, HIGHEST PRIORITY confirmed exposure — fires on
// ordinary template drift, not an exotic shape): prefer the LIVE template's current name (the
// common case, and the freshest one when the node still exists); when the live template no
// longer carries this key (renamed/reordered/removed since this row's node ran), fall back to a
// values-free "节点已变更" — never the raw internal node key (mirrors the "附件已删除" tombstone
// convention already used for a deleted attachment ref above).
//
// P7-R2 gate hardening (P2-1): an earlier revision also tried `pinnedGraph` (the FROZEN template
// version pinned at instance creation) as a second fallback before the values-free placeholder.
// That branch is dead for its intended audience: `pinnedGraph` only resolves once
// `templateStore.activeVersion` loads, and `loadVersion` calls
// `GET /api/approval-templates/:id/versions/:versionId`, which is
// `approvalTemplateAdminGuard`-gated (routes/approvals.ts:756, requiring
// `approval-templates:manage`/`approvals:admin-templates`) — ordinary members never have
// permission to reach it, so `activeVersion` stays null and `pinnedGraph` null-coalesces straight
// back to `activeTemplate?.approvalGraph`, the SAME live graph already searched one line above.
// Removed rather than left as a branch that only ever fires for template admins while its own
// comment implied it worked for everyone. Showing the historical name to ordinary members is a
// real enhancement worth having, but it needs the pinned graph exposed on a surface members can
// already read (e.g. frozen alongside `formSchema` on the instance DTO itself, the way
// `formSchema` is already frozen from the pinned version without an admin-guarded fetch) — that is
// backend work and a separate follow-up slice, not something this frontend-only fix can do without
// adding a new endpoint or widening the admin guard (both out of scope here).
function nodeLabel(nodeKey: string): string {
  if (!nodeKey) return '-'
  const live = templateStore.activeTemplate?.approvalGraph.nodes.find((entry) => entry.key === nodeKey)
  if (live?.name?.trim()) return live.name.trim()
  return '节点已变更'
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

// P7-R2 candidate #1 fix (values-free doctrine, confirmed member-facing raw-JSON exposure):
// detail/sub-form leaf columns are scalar-only by contract (`DETAIL_LEAF_FIELD_TYPES` excludes
// `record-link`/`detail` nesting), so an object reaching here is either a legacy/malformed
// snapshot or a richer shape than the leaf contract promises. Never render raw JSON to an
// ordinary user — surface a known display key if the shape happens to carry one (mirrors
// `recordLinkField.ts`'s displayValue convention), else a typed, values-free placeholder.
function objectDisplayValue(value: Record<string, unknown>): string {
  for (const key of ['displayValue', 'name', 'label', 'title'] as const) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return '复杂内容'
}

// P7-R2 gate hardening (P2-2/P3-2): the array branch used to `.join(', ')` every element
// verbatim, including a leaf-contract-violating array of raw record/user ids (only `multi-select`
// legitimately produces an array here, and only as a set of the column's OWN defined option
// values). A bare string element has no structural signal distinguishing "a raw id" from "a
// legitimate option value" — resolving that ambiguity with a hand-built id-shape heuristic would
// be exactly the kind of home-grown normalizer the values-free doctrine warns against. Use the
// REPO'S OWN whitelist instead: `column.options` (already defined at authoring time for every
// select/multi-select field). A stored value found in that whitelist renders its label; anything
// else — including a contract-violating raw id — renders a values-free placeholder, never
// verbatim. Object elements resolve through the same known-key-or-placeholder logic as a
// single object value above.
function formatFieldValue(value: unknown, column?: DetailDisplayColumn): string {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) {
    const byValue = column?.options?.length
      ? new Map(column.options.map((opt) => [opt.value, opt.label]))
      : null
    return value
      .map((entry) => {
        if (byValue) return byValue.get(String(entry)) ?? '未知选项'
        if (entry !== null && typeof entry === 'object') return objectDisplayValue(entry as Record<string, unknown>)
        // No options whitelist for this column and a bare (non-object) element — every leaf type
        // other than `multi-select` expects a single scalar, so an array reaching here at all is
        // already an anomalous/contract-violating shape; a values-free placeholder is the safe
        // default rather than trusting an unvalidated element.
        return '未知选项'
      })
      .join(', ')
  }
  if (typeof value === 'object') return objectDisplayValue(value as Record<string, unknown>)
  return String(value)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function goBack() {
  router.push({ name: 'approval-list' })
}

// G-B2-10: after a successful approve/reject, offer the next pending item — clearing N items
// costs N×(back+scan+click) without it. Target computed at CLICK time from the store's pending
// list (freshest view), always excluding the just-acted instance; deep-link entries with an
// empty/unloaded list simply render no button (no new fetch — display only).
const showNextEntry = ref(false)

const nextPendingApproval = computed(() => {
  const currentId = route.params.id as string
  return store.pendingApprovals.find((entry) => entry.id !== currentId) ?? null
})

function goNextPending() {
  const next = nextPendingApproval.value
  if (!next) return
  showNextEntry.value = false
  router.push({ name: 'approval-detail', params: { id: next.id } })
}

function retryLoad() {
  const id = route.params.id as string
  store.error = null
  Promise.all([store.loadDetail(id), store.loadHistory(id)])
}

// UX B2-13 (再次提交) — route to the SAME template's fill page, carrying this instance's id as
// `fromInstance` so `ApprovalNewView` can load it and prefill the fresh draft (see
// `prefillFromSnapshot`). Does NOT submit anything itself — the requester still reviews + submits
// the new draft normally (B2-15 validation, B2-07 preview, etc. all still apply).
function handleResubmit(): void {
  const detail = approval.value
  if (!detail?.templateId) return
  router.push({
    name: 'approval-create',
    params: { templateId: detail.templateId },
    query: { fromInstance: detail.id },
  })
}

function openActionDialog(action: 'approve' | 'reject') {
  currentAction.value = action
  actionComment.value = ''
  actionDialogError.value = null
  actionDialogVisible.value = true
}

function openTransferDialog() {
  transferUserId.value = ''
  actionComment.value = ''
  // P5-C-1: stale-error guard — every `open*` resets the shared `actionDialogError` so a failure
  // left over from a DIFFERENT verb's dialog can never render in this freshly-opened one.
  actionDialogError.value = null
  transferDialogVisible.value = true
}

function openReturnDialog() {
  returnTargetNodeKey.value = ''
  actionComment.value = ''
  actionDialogError.value = null
  returnDialogVisible.value = true
}

function openCommentDialog() {
  // B1-05: keeps `currentAction` in sync with the open dialog so `quickPhraseChips` offers the
  // 'comment' preset/recent list here (rather than whatever approve/reject dialog ran last).
  currentAction.value = 'comment'
  actionComment.value = ''
  actionDialogError.value = null
  commentStagedAttachments.value = [] // Lock-9: fresh state — this is the ONLY site that opens it.
  commentDialogVisible.value = true
}

/**
 * Lock-9 OD-L9-10(a) — process-attachment picker for the comment dialog. Gated by the caller
 * template on `attachmentPipelineEnabled && isMyTurn` (never `canAct`, which is the coarse
 * `approvals:act` scope grant — a requester/CC recipient with that scope on a DIFFERENT instance
 * must not see an uploader here). `stagedInstanceId` is this instance's own id: the row does not
 * commit to it until the comment action's `attachmentIds` rider binds it (§5.4).
 */
async function onCommentAttachmentPick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  input.value = '' // allow re-picking the same file after a reject/remove
  if (picked.length === 0) return
  const instanceId = approval.value?.id
  if (!instanceId || !commentAttachmentContextCurrent.value) return
  const pickGeneration = commentAttachmentLifecycleGeneration
  commentAttachmentUploading.value = true
  try {
    // Atomic selection: a later authoritative server reject compensates (DELETE) every file
    // uploaded from THIS pick, so a refused selection leaves zero live/bindable refs behind.
    const uploaded = await uploadApprovalProcessAttachmentsAtomic(picked, instanceId)
    if (!isLiveCommentAttachmentPick(pickGeneration, instanceId)) {
      for (const item of uploaded) {
        void deleteApprovalAttachment(item.id).catch(() => {
          // Best-effort: same as retract — the originating dialog/instance is already gone.
        })
      }
      return
    }
    for (let i = 0; i < uploaded.length; i += 1) {
      commentStagedAttachments.value.push({ id: uploaded[i].id, name: picked[i].name })
    }
  } catch (error) {
    if (!isLiveCommentAttachmentPick(pickGeneration, instanceId)) return
    // values-free code from the client mirror / server reject — never file contents or paths.
    ElMessage.error(error instanceof Error ? error.message : '附件上传失败')
  } finally {
    // A same-generation store refresh can briefly expose a different instance. That invalidates
    // staging/toasts, but this pick still owns the generation's loading bit and must release it.
    if (pickGeneration === commentAttachmentLifecycleGeneration) {
      commentAttachmentUploading.value = false
    }
  }
}

/**
 * §4.3-style removal (mirrors `ApprovalNewView.vue`'s `removeAttachment`): the server DELETE is the
 * load-bearing half (soft-delete + durable purge-intent enqueue); the local drop only happens after
 * it resolves, and a genuine failure leaves the entry in the list so the user can retry.
 *
 * Lock-9 FE fix round (gate P3-3): re-reads `commentStagedAttachments.value` AFTER the `await`
 * rather than closing over the array reference from before it — the close-watcher
 * (`retractStagedCommentAttachments`) can replace that ref with a NEW (now-empty) array while this
 * DELETE is in flight (dialog closed mid-remove). Splicing a captured pre-await reference would
 * mutate an array nothing renders any more, on top of double-DELETEing the same id. Re-reading means
 * a dialog-closed-mid-remove race finds nothing to splice (already retracted) instead of corrupting
 * a detached array.
 */
async function removeCommentAttachment(attachmentId: string): Promise<void> {
  try {
    await deleteApprovalAttachment(attachmentId)
  } catch {
    ElMessage.error('附件移除失败，请重试')
    return
  }
  const index = commentStagedAttachments.value.findIndex((item) => item.id === attachmentId)
  if (index >= 0) commentStagedAttachments.value.splice(index, 1)
}

// T3-1 v0 (ballot Q7): the mobile surface reuses the SAME version-less unified
// `/api/approvals/:id/actions` endpoint as desktop (via `store.executeAction`).
// Its only concurrency guard is refresh-on-4xx: when the action is rejected with
// a 4xx (the instance advanced under the approver — a stale action), re-pull the
// detail + history so the mobile action bar reflects live state instead of a
// stale one. Scoped to the mobile layout so desktop behavior is unchanged.
function is4xxConflict(error: unknown): boolean {
  // B1-04: `dispatchAction`'s real failures now carry a typed `.status` (see
  // `ApprovalApiError`/`approvalRequestError` in approvals/api.ts) whose `.message` is the
  // server's own text — it no longer matches the legacy "API error: NNN" shape below. Check
  // `.status` first; keep the regex as a fallback for anything still throwing the old generic
  // format (e.g. a mocked/legacy rejection).
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return status >= 400 && status < 500
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const match = /API error:\s*(\d{3})/.exec(message)
  if (!match) return false
  const status = Number(match[1])
  return status >= 400 && status < 500
}

// B1-04: prefer the typed/thrown error's own message (server text, or the helper's
// status-coded fallback); anything else (a non-Error throw) falls back to the caller-supplied
// generic copy so the dialog never renders a blank alert.
function dialogErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function refreshAfterStaleMobileAction(id: string, error: unknown): Promise<void> {
  if (!isMobileLayout.value) return
  if (!is4xxConflict(error)) return
  await Promise.all([store.loadDetail(id), store.loadHistory(id)]).catch(() => undefined)
}

async function submitAction() {
  if (actionConfirmDisabled.value) return
  if (inFlightAction.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  inFlightAction.value = currentAction.value
  try {
    await store.executeAction(id, {
      action: currentAction.value,
      comment: actionComment.value || undefined,
    })
    ElMessage.success(currentAction.value === 'approve' ? '审批已通过' : '审批已驳回')
    rememberQuickPhraseIfOffered(actionComment.value)
    actionDialogVisible.value = false
    showNextEntry.value = true
    await store.loadHistory(id)
  } catch (error) {
    // B1-04: keep the dialog open + show the server's own reason inline instead of a generic
    // toast (see `actionDialogError` above); non-dialog actions further down keep their toasts.
    actionDialogError.value = dialogErrorMessage(error, '操作失败，请重试')
    await refreshAfterStaleMobileAction(id, error)
  } finally {
    inFlightAction.value = null
  }
}

/**
 * Lock-5 §2.3 (gate A-2 residual repair) — the ONE failure path all four deferred member verbs share.
 *
 * Factored out after gate finding P3-R1 on PR #4983: the four handlers were hand-copies, so the
 * mounted pin on `submitTransfer` covered only that one — neutering `submitReturn` alone reded
 * nothing. One helper means one pin covers all four, and a fifth verb cannot be added with a private
 * copy of the rule.
 *
 * A policy denial is PERMANENT for this node, so it says so (values-free, no 请重试), TOASTS it, and
 * CLOSES the dialog: the old bare `catch {}` discarded the server's code, invited a retry, and every
 * retry minted another `policy_denied` audit row that D-3 then hides from the timeline. A toast is
 * still right for THIS branch specifically — the dialog is disappearing, so an alert rendered inside
 * it would never be seen.
 *
 * P5-C-1 (member-action dialog grammar unification): any OTHER failure used to toast too, while the
 * approve/reject/comment dialogs already rendered the server's message INLINE via `actionDialogError`
 * and stayed open — two different failure grammars for the same "retry is legitimate" outcome. That
 * divergence is now closed: a non-policy failure sets `dialogError` (the same shared ref those three
 * dialogs already render through) instead of toasting, so all six member-action dialogs surface a
 * non-fatal failure the same way. `fallback` is used only for a message-less or non-`Error` throw.
 */
function handleMemberActionFailure(
  error: unknown,
  fallback: string,
  dialogVisible: Ref<boolean>,
  dialogError: Ref<string | null>,
): void {
  const failure = memberActionFailure(error, fallback)
  if (failure.isPolicyDenial) {
    ElMessage.error(failure.message)
    dialogVisible.value = false
    return
  }
  dialogError.value = failure.message
}

async function submitTransfer() {
  if (!transferUserId.value) return
  if (inFlightAction.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  inFlightAction.value = 'transfer'
  try {
    await store.executeAction(id, {
      action: 'transfer',
      comment: actionComment.value || undefined,
      targetUserId: transferUserId.value,
    })
    ElMessage.success('已成功转交')
    transferDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    handleMemberActionFailure(error, '转交失败，请重试', transferDialogVisible, actionDialogError)
  } finally {
    inFlightAction.value = null
  }
}

function openAddSignDialog() {
  addSignUserIds.value = []
  addSignUserLabels.value = {}
  addSignPickerValue.value = null
  actionComment.value = ''
  actionDialogError.value = null
  addSignDialogVisible.value = true
}

// B3-04 D-2: repeated-pick handler for the add-sign target picker — append the picked id (no
// duplicates), remember its display label for the chip, then reset the picker's transient slot
// so it is ready for the next pick.
//
// raw-id-exposure-fix (20260819): `searchApprovalDirectoryUsers` defaults a missing/non-string
// backend `name` to `''` (see api.ts) — a real, reachable shape, not a type-only possibility. The
// old `option.name || option.id` fallback rendered the raw directory user id verbatim as the chip
// text in that case. Only a non-blank name is stored here now; the template falls back to a
// values-free, still-distinguishable per-list ordinal (`成员 N`) when no label is stored, the same
// convention used by `assignmentDisplayLabel`/`reducibleAssignees` above.
function onAddSignUserSelected(option: ApprovalDirectoryUser | null): void {
  if (!option) return
  if (!addSignUserIds.value.includes(option.id)) {
    addSignUserIds.value = [...addSignUserIds.value, option.id]
    const name = option.name.trim()
    if (name) {
      addSignUserLabels.value = { ...addSignUserLabels.value, [option.id]: name }
    }
  }
  addSignPickerValue.value = null
}

function removeAddSignUser(id: string): void {
  addSignUserIds.value = addSignUserIds.value.filter((existing) => existing !== id)
}

async function submitAddSign() {
  if (addSignUserIds.value.length === 0) return
  if (inFlightAction.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  inFlightAction.value = 'add_sign'
  try {
    await store.executeAction(id, {
      action: 'add_sign',
      comment: actionComment.value || undefined,
      targetUserIds: addSignUserIds.value,
      addSignMode: CLIENT_ADD_SIGN_MODE,
    })
    ElMessage.success('已成功加签')
    addSignDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    handleMemberActionFailure(error, '加签失败，请重试', addSignDialogVisible, actionDialogError)
  } finally {
    inFlightAction.value = null
  }
}

function openReduceSignDialog() {
  reduceSignUserId.value = ''
  actionComment.value = ''
  actionDialogError.value = null
  reduceSignDialogVisible.value = true
}

async function submitReduceSign() {
  if (!reduceSignUserId.value) return
  // member-display-identity (2026-08-19) — defense-in-depth mirror of the disabled `<el-option>`
  // above: the primary gate is Element Plus refusing to select a disabled option, but this refuses
  // the submit itself too if the target isn't (still) in the reducible-AND-resolved set, so the
  // flow-changing action stays impossible for an unidentifiable member even if `reduceSignUserId`
  // were ever set some other way than picking a rendered option.
  const target = reducibleAssignees.value.find((a) => a.assigneeId === reduceSignUserId.value)
  if (!target || target.disabled) return
  if (inFlightAction.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  inFlightAction.value = 'reduce_sign'
  try {
    await store.executeAction(id, {
      action: 'reduce_sign',
      comment: actionComment.value || undefined,
      targetAssignmentUserId: reduceSignUserId.value,
    })
    ElMessage.success('已成功减签')
    reduceSignDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    handleMemberActionFailure(error, '减签失败，请重试', reduceSignDialogVisible, actionDialogError)
  } finally {
    inFlightAction.value = null
  }
}

async function submitComment() {
  if (!actionComment.value.trim()) return
  if (commentAttachmentUploading.value) return
  if (inFlightAction.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  inFlightAction.value = 'comment'
  // Lock-9 OD-L9-10(a): key PRESENCE, not an empty array — mirrors the backend's own
  // `hasOwnProperty('attachmentIds')` discipline (routes/approvals.ts §5.5, ApprovalProductService
  // §5.4). A dialog with no staged uploads sends the exact same request shape as before this slice.
  const stagedIds = commentStagedAttachments.value.map((item) => item.id)
  try {
    await store.executeAction(id, {
      action: 'comment',
      comment: actionComment.value,
      ...(stagedIds.length > 0 ? { attachmentIds: stagedIds } : {}),
    })
    ElMessage.success('评论已提交')
    rememberQuickPhraseIfOffered(actionComment.value)
    // Clear BEFORE closing the dialog — the close-watcher above DELETEs whatever is still in this
    // list, and these ids are now server-bound (clearing after the flip would race a DELETE against
    // an already-bound row).
    commentStagedAttachments.value = []
    commentDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    // B1-04: same dialog-scoped inline error as `submitAction` above.
    actionDialogError.value = dialogErrorMessage(error, '评论提交失败，请重试')
    await refreshAfterStaleMobileAction(id, error)
  } finally {
    inFlightAction.value = null
  }
}

async function submitReturn() {
  if (!returnTargetNodeKey.value) return
  if (inFlightAction.value) return
  const id = route.params.id as string
  actionDialogError.value = null
  inFlightAction.value = 'return'
  try {
    await store.executeAction(id, {
      action: 'return',
      comment: actionComment.value || undefined,
      targetNodeKey: returnTargetNodeKey.value,
    })
    ElMessage.success('已退回审批')
    returnDialogVisible.value = false
    await store.loadHistory(id)
  } catch (error) {
    handleMemberActionFailure(error, '退回失败，请重试', returnDialogVisible, actionDialogError)
  } finally {
    inFlightAction.value = null
  }
}

// P5-C-1: 撤回 has no dialog (a popconfirm, not a member-action dialog — deliberately OUT of the
// grammar unification per the scout brief: wrapping it in one would ADD a flow, not unify one).
// The only in-scope fix here is message FIDELITY — the old bare `catch {}` discarded whatever the
// server actually said and always rendered the same fixed copy. `dialogErrorMessage` (already used
// by `submitAction`/`submitComment` above) prefers the thrown error's own message and falls back to
// this same fixed string only for a message-less/non-`Error` throw, so a legacy/mocked rejection
// still renders something instead of a blank toast.
async function handleRevoke() {
  if (inFlightAction.value) return
  const id = route.params.id as string
  inFlightAction.value = 'revoke'
  try {
    await store.executeAction(id, { action: 'revoke' })
    ElMessage.success('审批已撤回')
    await store.loadHistory(id)
  } catch (error) {
    ElMessage.error(dialogErrorMessage(error, '撤回失败，请重试'))
  } finally {
    inFlightAction.value = null
  }
}

// ---------------------------------------------------------------------------
// B3-13 打印/复制 — display-only utilities in the page header.
// ---------------------------------------------------------------------------
// 复制摘要: the approval's key fields + a link back to this detail route as plain text, for
// pasting into chat/email when asking someone to handle or unblock an approval. Status label
// reuses the shared statusDomains vocabulary (same table the header StatusTag renders from) —
// no second status→label map. Field values reuse the exact formatters the visible meta grid
// uses, so the copied text always matches what the reader sees on screen.
function buildApprovalSummary(): string | null {
  const detail = approval.value
  if (!detail) return null
  return [
    `审批：${detail.title ?? '-'}`,
    `编号：${detail.requestNo ?? '-'}`,
    `状态：${resolveStatusDisplay('approvalInstance', detail.status, true).label}`,
    `发起人：${detail.requester?.name ?? '-'}`,
    `发起时间：${formatDate(detail.createdAt)}`,
    `进度：${detail.currentStep ?? '-'} / ${detail.totalSteps ?? '-'}`,
    `链接：${window.location.href}`,
  ].join('\n')
}

async function handleCopySummary() {
  const text = buildApprovalSummary()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('审批摘要已复制')
  } catch {
    // Clipboard API unavailable (insecure context / older browser) or permission denied.
    ElMessage.error('复制失败，请重试')
  }
}

// 打印: hand off to the browser's print dialog; the scoped `@media print` block hides the
// sticky action bar + header buttons and collapses the two-column body (see <style>).
function handlePrint() {
  window.print()
}

// Wave 2 WP3 slice 1: 催办. Loading state is local to this button so the main
// approve/reject action row does not go into a spinner while a requester
// nudges. On 429 we surface the server-supplied `lastRemindedAt` so the user
// knows why the button rejected them.
const remindLoading = ref(false)

function formatRemindAgo(lastRemindedAt?: string): string {
  if (!lastRemindedAt) return '刚刚'
  const timestamp = new Date(lastRemindedAt).getTime()
  if (!Number.isFinite(timestamp)) return '刚刚'
  const diffMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes <= 0) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时前`
}

async function handleRemind() {
  const id = route.params.id as string
  if (remindLoading.value) return
  remindLoading.value = true
  try {
    const result = await remindApproval(id)
    if (result.ok) {
      ElMessage.success('已催办')
      await store.loadHistory(id)
    } else if (result.status === 429) {
      ElMessage.warning(`已在 ${formatRemindAgo(result.error.lastRemindedAt)}催办过`)
    } else {
      ElMessage.error(result.error.message || '催办失败，请重试')
    }
  } finally {
    remindLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// G-B2-10: extracted from onMounted so detail→detail navigation (下一条 →) reloads — the router
// reuses this component instance on a params-only change, so onMounted alone would show stale data.
async function loadDetailPage() {
  const id = route.params.id as string
  // Wave 2 WP3 slice 2 — fire-and-forget mark-read. Runs in parallel with the
  // detail load so the unread badge drops immediately while the detail view
  // keeps rendering regardless of mark-read's outcome. Errors are logged but
  // never surfaced via toast: this is silent presence data, not an action.
  void markApprovalRead(id).catch((error) => {
    // eslint-disable-next-line no-console
    console.warn('[approval-detail] mark-read failed', error)
  })
  // B1-01: cold-cache fallback for the session identity — fire-and-forget in parallel with
  // the detail load; a failed session lookup just leaves requester-only actions hidden.
  if (!currentUserId.value) {
    void auth
      .getCurrentUserId()
      .then((uid) => {
        currentUserId.value = uid
      })
      .catch(() => {})
  }
  await Promise.all([store.loadDetail(id), store.loadHistory(id)])
  const detail = store.activeApproval
  if (detail?.templateId) {
    const templateFetches: Array<Promise<unknown>> = [
      templateStore.loadTemplate(detail.templateId).catch(() => undefined),
    ]
    // B2-08: ALSO fetch the instance's pinned template version (if the DTO exposes one) so
    // `pinnedGraph`/the current+upcoming synthesis can walk the FROZEN graph. Kept as an
    // ADDITIONAL fetch (not a replacement) so `nodeLabel`'s existing history lookups keep using
    // the live template exactly as before.
    if (detail.templateVersionId) {
      templateFetches.push(templateStore.loadVersion(detail.templateId, detail.templateVersionId).catch(() => undefined))
    }
    await Promise.all(templateFetches)
  }
}

onMounted(loadDetailPage)

// Params-only navigation (下一条 →): reset the next-entry offer and reload for the new instance.
watch(
  () => route.params.id,
  (next, prev) => {
    if (typeof next === 'string' && next && next !== prev) {
      // Lock-9 FE fix round (gate P3-2): this component instance is REUSED across a params-only
      // navigation (no unmount), so any process attachment still staged on the OUTGOING instance's
      // comment dialog must be retracted here — `onBeforeUnmount` never fires for this transition.
      retractStagedCommentAttachments()
      showNextEntry.value = false
      void loadDetailPage()
    }
  },
)
</script>

<style scoped>
.approval-detail__error {
  margin-bottom: 16px;
}

/* B1-04: dialog-scoped failure alert (approve/reject + comment dialogs). */
.approval-detail__dialog-error {
  margin-bottom: 16px;
}

.approval-detail__content-wrapper {
  min-height: 200px;
}

/* UF-8: first-paint skeleton (form snapshot + timeline) — markup + spacing now live in the
   shared AsyncStateBlock (see the wrapper's v-if/v-loading split). */

.approval-detail__body {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 24px;
}

.approval-detail__form,
.approval-detail__timeline,
.approval-detail__comments {
  min-width: 0;
  padding: var(--ms-space-5);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

/* S3b: full-width row below the 审批详情/审批记录 two-column row — see the template comment on
   this section for why it is a THIRD, full-span grid child rather than living between the other
   two (sparse `grid-auto-flow: row` cannot backfill an earlier skipped cell for a later item). */
.approval-detail__comments {
  grid-column: 1 / -1;
}

.approval-detail__actor-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-right: var(--ms-space-2);
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
  vertical-align: middle;
}

.approval-detail__form h2,
.approval-detail__timeline h2,
.approval-detail__comments h2 {
  margin: 0 0 var(--ms-space-4);
  color: var(--ms-text-1);
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
}

/* UI-6: anchor-style tab nav above the right column. */
.approval-detail__detail-tabs {
  display: flex;
  gap: var(--ms-space-2);
  margin-bottom: var(--ms-space-4);
  border-bottom: 1px solid var(--ms-border-light);
}

.approval-detail__detail-tab {
  padding: 6px 4px 10px;
  border: none;
  background: none;
  color: var(--ms-text-3);
  font-size: 14px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.approval-detail__detail-tab:hover {
  color: var(--ms-text-1);
}

.approval-detail__detail-tab--active {
  color: var(--el-color-primary);
  border-bottom-color: var(--el-color-primary);
  font-weight: 600;
}

/* UI-6: 审批记录 timeline/table toggle. */
.approval-detail__record-toggle {
  display: inline-flex;
  gap: 4px;
  margin-bottom: var(--ms-space-3);
  padding: 2px;
  border-radius: var(--ms-radius-md);
  background: var(--el-fill-color-light);
}

.approval-detail__record-toggle-btn {
  padding: 4px 12px;
  border: none;
  border-radius: calc(var(--ms-radius-md) - 2px);
  background: none;
  color: var(--ms-text-3);
  font-size: 12px;
  cursor: pointer;
}

.approval-detail__record-toggle-btn--active {
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  box-shadow: var(--ms-shadow-card);
}

.approval-detail__record-table {
  margin-bottom: var(--ms-space-3);
}

.approval-detail__record-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.approval-detail__record-time {
  font-size: 12px;
  color: var(--ms-text-3);
}

.approval-detail__meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.approval-detail__meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.approval-detail__snapshot {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.approval-detail__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail__detail-table {
  margin-top: 4px;
}

/* B3-07 §8: frozen attachment refs — download links + tombstones for deleted refs. */
.approval-detail__attachments {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail__attachment-size {
  margin-left: 8px;
  color: var(--ms-text-3);
  font-size: 12px;
}

.approval-detail__attachment-tombstone {
  color: var(--ms-text-3);
  font-style: italic;
}

/* Lock-9 OD-L9-10(a): comment-dialog staged process-attachment list, mirrors ApprovalNewView's
   own uploader list styling. */
.approval-detail__comment-attachment-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail__comment-attachment-hint {
  display: block;
  margin-top: 4px;
  color: var(--ms-text-3);
  font-size: 12px;
}

.approval-detail__quick-phrases {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.approval-detail__quick-phrase-chip {
  cursor: pointer;
}

.approval-detail__add-sign-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.approval-detail__timeline-content {
  padding: 0;
}

.approval-detail__timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.approval-detail__timeline-comment {
  margin: 4px 0 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.approval-detail__timeline-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.approval-detail__meta-badge {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

.approval-detail__meta-badge--auto {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.approval-detail__meta-badge--complete {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.approval-detail__meta-badge--return {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.approval-detail__parallel-badge {
  margin-left: 8px;
  font-weight: 500;
  letter-spacing: 0.05em;
}

.approval-detail__timeline-group {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: var(--el-fill-color-blank);
}

.approval-detail__timeline-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}

.approval-detail__timeline-group-label {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.approval-detail__timeline-group-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* UX B2-08: synthesized "current handler + upcoming nodes" rail, appended after the real
   history entries. A lightweight dot+line rail of its own (not `<el-timeline-item>`) so the
   upcoming (future/uncertain) entries can render visibly greyed without touching the styling
   of real history rows above. */
.approval-detail__timeline-upcoming {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.approval-detail__timeline-upcoming-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.approval-detail__timeline-upcoming-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--el-color-primary);
}

.approval-detail__timeline-upcoming-item--future .approval-detail__timeline-upcoming-dot {
  background: var(--el-text-color-placeholder);
}

.approval-detail__timeline-upcoming-item--current .approval-detail__timeline-upcoming-text {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.approval-detail__timeline-upcoming-item--future .approval-detail__timeline-upcoming-text {
  color: var(--el-text-color-placeholder);
}

.approval-detail__timeline-upcoming-summary {
  margin-left: 6px;
}

/* B1-05: sticky at the viewport bottom so approve/reject/... stay reachable while the form
   snapshot / timeline scroll underneath, instead of requiring a scroll-to-bottom first. The
   safe-area padding keeps the buttons clear of the home-indicator area on notched devices. */
.approval-detail__actions {
  margin-top: var(--ms-space-5);
  padding: var(--ms-space-4) var(--ms-space-5);
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  background: var(--ms-bg-card);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  box-shadow: var(--ms-shadow-pop);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  position: sticky;
  bottom: 0;
  z-index: 1;
}

.approval-detail__actions-primary {
  display: flex;
  gap: 12px;
}

.approval-detail__actions-secondary {
  display: flex;
  gap: 12px;
}

/* Responsive: stack on small screens.
   T3-1 v0: on the mobile approval surface the action set is restricted to
   approve/reject/comment (deferred actions hidden), so the remaining controls
   are laid out as full-width, comfortably tappable rows. */
@media (max-width: 768px) {
  .approval-detail__body {
    grid-template-columns: 1fr;
  }

  .approval-detail__meta {
    grid-template-columns: 1fr;
  }

  .approval-detail__actions {
    flex-direction: column;
    align-items: stretch;
  }

  /* B1-05: the primary 通过/驳回 pair stays a two-up row (not a full column stack) so both
     land in comfortable thumb reach; flex: 1 + min-height 44px keeps them evenly-sized,
     tappable targets. The deferred secondary set keeps the existing full-width column stack —
     its visibility/action set is unchanged (T3-1 v0 mobile gating still applies above). */
  .approval-detail__actions-primary {
    flex-direction: row;
  }

  .approval-detail__actions-secondary {
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
  }

  .approval-detail__actions-primary :deep(.el-button) {
    flex: 1;
    min-height: 44px;
    margin-left: 0;
  }

  .approval-detail__actions-secondary :deep(.el-button) {
    width: 100%;
    margin-left: 0;
  }
}

/* B3-13 打印: paper gets the form snapshot + timeline only — the sticky action bar and the
   header's utility buttons (复制摘要/打印/下一条) are interactive chrome with no meaning on
   paper, and the two-column grid collapses so the timeline prints below the form instead of
   being crushed into a 400px rail. */
@media print {
  .approval-detail__actions,
  .approval-detail__hide-on-print,
  .approval-detail__detail-tabs,
  .approval-detail__record-toggle {
    display: none;
  }

  .approval-detail__body {
    grid-template-columns: 1fr;
  }
}
</style>

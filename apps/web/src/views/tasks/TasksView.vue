<template>
  <section class="tasks-view" aria-labelledby="tasks-view-title">
    <template v-if="contextState?.state === 'ready'">
      <!-- `/tasks/:id` loads this SAME component (tasks-routes.spec.ts gate 22). Backend PR #6062
           ships `GET /api/tasks/:id`; this renders its real states. Design lock §5.2 "引导流三触发"
           still applies to the WRITE actions available here (complete/reopen can 422 ORG_MISSING) —
           that reuses the SAME `orgMissingFromAction` flag / guidance block the list branch uses, so
           it is checked first, before the detail read's own states. -->
      <template v-if="taskId">
        <header class="tasks-view__header">
          <h1 id="tasks-view-title">{{ t.detailTitle }}</h1>
          <router-link class="tasks-view__back-link" to="/tasks" data-testid="tasks-detail-back-link">
            &larr; {{ t.backToList }}
          </router-link>
        </header>

        <template v-if="orgMissingFromAction">
          <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
            {{ t.orgMissing }}
          </p>
        </template>
        <template v-else>
          <p v-if="actionErrorMessage" class="tasks-view__message" data-testid="tasks-action-error" role="alert">
            {{ actionErrorMessage }}
          </p>

          <div v-if="detailResult.kind === 'ok'" class="tasks-view__detail" data-testid="tasks-detail">
            <h2 class="tasks-view__detail-title" data-testid="tasks-detail-title">{{ detailResult.task.title }}</h2>
            <p class="tasks-view__detail-status" data-testid="tasks-detail-status">
              {{ detailResult.task.status === 'done' ? t.statusDone : t.statusOpen }}
            </p>
            <p class="tasks-view__detail-completion-mode" data-testid="tasks-detail-completion-mode">
              {{ detailResult.task.completionMode === 'all' ? t.modeAll : t.modeAny }}
            </p>
            <p class="tasks-view__detail-due" data-testid="tasks-detail-due">
              {{ formatDueDisplay(detailResult.task, t, viewerLocale) }}
            </p>
            <!-- M4 (design §7.2): the read-only rows of the PR-3a S4 fields. The four keys arrive as a
                 group, so `description` stands for all of them; an older body shows none. The rows
                 render whether or not the editor is open (`[fe-20]`). -->
            <template v-if="detailResult.task.description !== undefined">
              <p class="tasks-view__detail-start" data-testid="tasks-detail-start">
                {{ t.detailStartLabel }}{{ formatStartDisplay(detailResult.task, t) }}
              </p>
              <p class="tasks-view__detail-description" data-testid="tasks-detail-description">{{ t.detailDescriptionLabel }}{{ detailResult.task.description || t.noDescription }}</p>
              <p class="tasks-view__detail-remind" data-testid="tasks-detail-remind">
                {{ t.detailRemindLabel }}{{ detailResult.task.remindAt ? formatViewerInstant(detailResult.task.remindAt, undefined, viewerLocale) : t.noReminder }}
              </p>
            </template>

            <ul class="tasks-view__detail-assignees" data-testid="tasks-detail-assignees">
              <li
                v-for="assignee in detailResult.task.assignees"
                :key="assignee.userId"
                class="tasks-view__detail-assignee"
                data-testid="tasks-detail-assignee"
              >
                <span class="tasks-view__detail-assignee-id">{{ assignee.userId }}</span>
                <span class="tasks-view__detail-assignee-status" data-testid="tasks-detail-assignee-status">
                  {{ assignee.completedAt ? fmt.completedAt(formatViewerInstant(assignee.completedAt, undefined, viewerLocale)) : t.assigneeNotDone }}
                </span>
                <button
                  v-if="canManageTaskMembers"
                  type="button"
                  data-testid="tasks-detail-assignee-remove"
                  :disabled="detailActionPending"
                  @click="onRemoveAssignee(assignee.userId)"
                >{{ t.remove }}</button>
              </li>
            </ul>

            <form v-if="canManageTaskMembers" class="tasks-view__add-assignee" data-testid="tasks-detail-add-assignee-form" @submit.prevent="onAddAssignee">
              <input
                v-model="newAssigneeId"
                type="text"
                data-testid="tasks-detail-add-assignee-input"
                :placeholder="t.addAssigneePlaceholder"
              />
              <button
                type="submit"
                data-testid="tasks-detail-add-assignee-submit"
                :disabled="detailActionPending || newAssigneeId.trim().length === 0"
              >{{ t.addAssignee }}</button>
            </form>

            <label v-if="canEditTask" class="tasks-view__completion-mode-switch">
              {{ t.switchModeLabel }}
              <select
                data-testid="tasks-detail-completion-mode-select"
                :value="detailResult.task.completionMode"
                :disabled="detailActionPending"
                @change="onCompletionModeChange"
              >
                <option value="all">{{ t.modeAll }}</option>
                <option value="any">{{ t.modeAny }}</option>
              </select>
            </label>
            <p v-if="membershipError" class="tasks-view__message" data-testid="tasks-detail-membership-error" role="alert">
              {{ codeMessage(membershipError, t) }}
            </p>

            <button
              v-if="detailResult.task.status === 'open' && detailResult.task.canComplete"
              type="button"
              data-testid="tasks-detail-complete-button"
              :disabled="detailActionPending"
              @click="onDetailComplete"
            >{{ t.complete }}</button>
            <button
              v-if="detailResult.task.status === 'done' && detailResult.task.canReopen"
              type="button"
              data-testid="tasks-detail-reopen-button"
              :disabled="detailActionPending"
              @click="onDetailReopen"
            >{{ t.reopen }}</button>

            <!-- M4 (design §2.4, §4.3): the editor and the lists section, both stateless — their state
                 is held below, because this whole block is re-created on every `loadDetail`. The
                 editor renders on `editorAvailable` (the S4 group and `version`, see the script);
                 the lists section needs `listIds` (PR-3a S7 adds it to the detail body). The lists
                 section's remove controls follow `canEdit`, its add picker the member-management
                 ability (`[fe-47]`: adding a task to a list takes a direct role on it, the same
                 predicate). -->
            <TaskDetailEditor
              v-if="editorAvailable && editorState.draft"
              :task="detailResult.task"
              :draft="editorState.draft"
              :phase="editorState.phase"
              :conflict-version="editorState.conflictVersion"
              :field-errors="editorState.fieldErrors"
              :server-updated="editorState.serverUpdated"
              :pending="detailActionPending"
              @update:draft="onEditorDraftUpdate"
              @submit="onPatchTask"
              @discard="onEditorDiscard"
            />
            <TaskDetailLists
              v-if="detailResult.task.listIds !== undefined"
              :list-ids="detailResult.task.listIds"
              :my-lists="myListsResult"
              :can-edit="canEditTask"
              :can-add="canManageTaskMembers"
              :pending="detailActionPending"
              :error="listsError"
              @add="onAddTaskToList"
              @remove="onRemoveTaskFromList"
            />

            <!-- M3 §3.1/§3.2: subtasks. `children`/`depth` are OPTIONAL-per-render even though
                 `TaskDetail` types them as required — a `getTask` result mocked directly (bypassing
                 `isTaskDetail`'s real validation) by an M2 spec predating this section would
                 otherwise throw on `.length`/`.children`. The real `getTask` parser still requires
                 both fields; this fallback only protects rendering against a caller that skips it. -->
            <section class="tasks-view__subtasks" data-testid="tasks-detail-subtasks-section">
              <h3>{{ t.subtasksHeading }}</h3>
              <p data-testid="tasks-detail-depth">{{ t.depthLabel }}{{ detailResult.task.depth ?? 0 }}</p>
              <p v-if="detailResult.task.parentId" data-testid="tasks-detail-parent">
                {{ t.parentLabel }}
                <router-link :to="`/tasks/${encodeURIComponent(detailResult.task.parentId ?? '')}`">{{ detailResult.task.parentId }}</router-link>
              </p>
              <ul data-testid="tasks-detail-children">
                <li
                  v-for="child in detailResult.task.children ?? []"
                  :key="child.id"
                  data-testid="tasks-detail-child"
                >
                  <router-link :to="`/tasks/${encodeURIComponent(child.id)}`">{{ child.title }}</router-link>
                  <span>{{ child.status === 'done' ? t.statusDone : t.statusOpen }}</span>
                </li>
              </ul>
              <p
                v-if="(detailResult.task.children ?? []).length === 0"
                class="tasks-view__message"
                data-testid="tasks-detail-children-empty"
              >{{ t.noChildren }}</p>
              <form v-if="canEditTask" class="tasks-view__set-parent" data-testid="tasks-detail-set-parent-form" @submit.prevent="onSetParent">
                <input
                  v-model="parentInput"
                  type="text"
                  data-testid="tasks-detail-set-parent-input"
                  :placeholder="t.setParentPlaceholder"
                />
                <button
                  type="submit"
                  data-testid="tasks-detail-set-parent-submit"
                  :disabled="detailActionPending || parentInput.trim().length === 0"
                >{{ t.setParent }}</button>
              </form>
              <button
                v-if="canEditTask && detailResult.task.parentId"
                type="button"
                data-testid="tasks-detail-make-independent"
                :disabled="detailActionPending"
                @click="onMakeIndependent"
              >{{ t.makeIndependent }}</button>
              <p v-if="parentError" class="tasks-view__message" data-testid="tasks-detail-parent-error" role="alert">
                {{ codeMessage(parentError, t) }}
              </p>
            </section>

            <!-- M3 §3.5: followers. §3.5's `GET /api/tasks/:id` never carries this list — see
                 `followersState`'s docblock in the script for why `null` (not `[]`) means "unknown". -->
            <section class="tasks-view__followers" data-testid="tasks-detail-followers-section">
              <h3>{{ t.followersHeading }}</h3>
              <ul v-if="followersState !== null" data-testid="tasks-detail-followers">
                <li v-for="followerId in followersState" :key="followerId" data-testid="tasks-detail-follower">
                  <span>{{ followerId }}</span>
                  <button
                    v-if="canManageTaskMembers"
                    type="button"
                    data-testid="tasks-detail-follower-remove"
                    :disabled="detailActionPending"
                    @click="onRemoveFollower(followerId)"
                  >{{ t.remove }}</button>
                </li>
              </ul>
              <p v-else class="tasks-view__message" data-testid="tasks-detail-followers-unknown">
                {{ t.followersUnknown }}
              </p>
              <form v-if="canManageTaskMembers" class="tasks-view__add-follower" data-testid="tasks-detail-add-follower-form" @submit.prevent="onAddFollower">
                <input
                  v-model="newFollowerId"
                  type="text"
                  data-testid="tasks-detail-add-follower-input"
                  :placeholder="t.addFollowerPlaceholder"
                />
                <button
                  type="submit"
                  data-testid="tasks-detail-add-follower-submit"
                  :disabled="detailActionPending || newFollowerId.trim().length === 0"
                >{{ t.addFollower }}</button>
              </form>
              <button
                v-if="canLeaveCurrentTask"
                type="button"
                data-testid="tasks-detail-leave"
                :disabled="detailActionPending"
                @click="onLeave"
              >{{ t.leave }}</button>
              <p v-if="followerError" class="tasks-view__message" data-testid="tasks-detail-follower-error" role="alert">
                {{ codeMessage(followerError, t) }}
              </p>
            </section>

            <!-- M3 §3.6: comments. Tombstones render as 已删除; edit/delete gated by
                 `canEditOwnComment` (own-comment only — see the script for the "id unavailable"
                 fallback). -->
            <section class="tasks-view__comments" data-testid="tasks-detail-comments">
              <h3>{{ t.commentsHeading }}</h3>
              <p v-if="commentsResult.kind === 'loading'" data-testid="tasks-detail-comments-loading">{{ t.loading }}</p>
              <p
                v-else-if="commentsResult.kind === 'error'"
                class="tasks-view__message"
                data-testid="tasks-detail-comments-error"
                role="alert"
              >{{ t.commentsLoadFailed }}</p>
              <p
                v-if="commentsResult.kind === 'ok' && commentsTruncated"
                class="tasks-view__message"
                data-testid="tasks-detail-comments-truncated"
              >{{ t.commentsTruncated }}</p>
              <ul v-if="commentsResult.kind === 'ok'" data-testid="tasks-detail-comments-list">
                <li v-for="comment in commentsResult.items" :key="comment.id" data-testid="tasks-detail-comment">
                  <template v-if="editingCommentId === comment.id">
                    <textarea v-model="editingCommentBody" data-testid="tasks-detail-comment-edit-input"></textarea>
                    <button
                      type="button"
                      data-testid="tasks-detail-comment-edit-save"
                      :disabled="detailActionPending"
                      @click="onSaveEditComment(comment.id)"
                    >{{ t.save }}</button>
                    <button
                      type="button"
                      data-testid="tasks-detail-comment-edit-cancel"
                      :disabled="detailActionPending"
                      @click="onCancelEditComment"
                    >{{ t.cancel }}</button>
                    <p v-if="editCommentError" data-testid="tasks-detail-comment-edit-error" role="alert">{{ codeMessage(editCommentError, t) }}</p>
                  </template>
                  <template v-else>
                    <span data-testid="tasks-detail-comment-body">{{ comment.deleted ? t.commentDeleted : comment.body }}</span>
                    <span data-testid="tasks-detail-comment-author">{{ comment.authorId }}</span>
                    <template v-if="canEditOwnComment(comment)">
                      <button
                        type="button"
                        data-testid="tasks-detail-comment-edit"
                        :disabled="detailActionPending"
                        @click="onStartEditComment(comment)"
                      >{{ t.edit }}</button>
                      <button
                        type="button"
                        data-testid="tasks-detail-comment-delete"
                        :disabled="detailActionPending"
                        @click="onDeleteComment(comment.id)"
                      >{{ t.delete }}</button>
                    </template>
                  </template>
                </li>
              </ul>
              <form v-if="canCommentTask" class="tasks-view__create-comment" data-testid="tasks-detail-comment-form" @submit.prevent="onCreateComment">
                <textarea v-model="newCommentBody" data-testid="tasks-detail-comment-input"></textarea>
                <button type="submit" data-testid="tasks-detail-comment-submit" :disabled="detailActionPending">{{ t.postComment }}</button>
              </form>
              <p v-if="commentError" class="tasks-view__message" data-testid="tasks-detail-comment-error" role="alert">
                {{ codeMessage(commentError, t) }}
              </p>
            </section>

            <!-- M3 §3.7: delete, with an INLINE confirm step (no window.confirm — see the M3
                 frontend design doc). -->
            <section v-if="canDeleteTask" class="tasks-view__delete-task" data-testid="tasks-detail-delete-section">
              <button
                v-if="!deleteConfirmVisible"
                type="button"
                data-testid="tasks-detail-delete"
                :disabled="detailActionPending"
                @click="onDeleteClick"
              >{{ t.deleteTask }}</button>
              <div v-else data-testid="tasks-detail-delete-confirm">
                <p>{{ t.deleteConfirmPrompt }}</p>
                <button
                  type="button"
                  data-testid="tasks-detail-delete-confirm-yes"
                  :disabled="detailActionPending"
                  @click="onDeleteConfirm"
                >{{ t.deleteConfirm }}</button>
                <button
                  type="button"
                  data-testid="tasks-detail-delete-confirm-cancel"
                  :disabled="detailActionPending"
                  @click="onDeleteCancel"
                >{{ t.cancel }}</button>
              </div>
              <p v-if="deleteError" class="tasks-view__message" data-testid="tasks-detail-delete-error" role="alert">
                {{ codeMessage(deleteError, t) }}
              </p>
            </section>
          </div>
          <p
            v-else-if="detailResult.kind === 'not_found'"
            class="tasks-view__message"
            data-testid="tasks-detail-not-found"
            role="status"
          >{{ t.detailNotFound }}</p>
          <p
            v-else-if="detailResult.kind === 'forbidden'"
            class="tasks-view__message"
            data-testid="tasks-detail-forbidden"
            role="status"
          >{{ t.detailForbidden }}</p>
          <p
            v-else-if="detailResult.kind === 'error'"
            class="tasks-view__message"
            data-testid="tasks-detail-error"
            role="alert"
          >{{ t.detailLoadFailed }}</p>
          <p v-else class="tasks-view__message" data-testid="tasks-detail-loading">
            {{ t.loading }}
          </p>
        </template>
      </template>

      <!-- Design lock §5.2 "引导流三触发": a list read or a write (create/complete/reopen) that
           reports org_missing hides the rest of the ready UI and shows the SAME guidance block the
           context-level 'org_missing' state below shows. `predicate_error` never sets this. -->
      <template v-else-if="orgMissingFromAction">
        <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
          {{ t.orgMissing }}
        </p>
      </template>

      <template v-else>
        <header class="tasks-view__header">
          <h1 id="tasks-view-title">{{ t.listTitle }}</h1>
          <!-- M4 (design §2.2): the only entry to /tasks/settings. It renders in the ready list branch
               only, so it sits behind the same gate as the page it opens. -->
          <router-link class="tasks-view__settings-link" to="/tasks/settings" data-testid="tasks-settings-link">
            {{ t.settingsLink }}
          </router-link>
        </header>

        <!-- M4 (design §2.4, §4.1): the lists sidebar beside the task list. It lives in this ready list
             branch, so it sits behind the same gate as the page; a lists read that reports no org
             switches this page to the guidance block above. -->
        <div class="tasks-view__columns">
          <TaskListsSidebar class="tasks-view__sidebar" @org-missing="onListsOrgMissing" />
          <div class="tasks-view__main">
            <nav class="tasks-view__switcher" :aria-label="t.viewSwitcherLabel">
              <button
                v-for="viewOption in VIEWS"
                :key="viewOption.value"
                type="button"
                class="tasks-view__switch-button"
                :data-testid="`tasks-view-switch-${viewOption.value}`"
                :aria-pressed="currentView === viewOption.value"
                :disabled="currentView === viewOption.value"
                @click="switchView(viewOption.value)"
              >{{ t[viewOption.labelKey] }}</button>
            </nav>

            <form class="tasks-view__create" data-testid="tasks-create-form" @submit.prevent="onCreate">
              <input
                v-model="newTitle"
                type="text"
                class="tasks-view__create-title"
                data-testid="tasks-create-title"
                :placeholder="t.createTitlePlaceholder"
              />
              <select v-model="newCompletionMode" data-testid="tasks-create-completion-mode">
                <option value="all">{{ t.modeAll }}</option>
                <option value="any">{{ t.modeAny }}</option>
              </select>
              <button
                type="submit"
                data-testid="tasks-create-submit"
                :disabled="creating || newTitle.trim().length === 0"
              >{{ t.create }}</button>
            </form>
            <p v-if="createErrorVisible" class="tasks-view__message" data-testid="tasks-create-error" role="alert">
              {{ createErrorInvalidTitle ? t.createInvalidTitle : createErrorCode ? codeMessage(createErrorCode, t) : t.createFailed }}
            </p>
            <!-- Complete/reopen results other than ok/org_missing (forbidden / not_found / error) used
                 to be silently dropped — the click just did nothing, with no way to tell "it worked" from
                 "it failed". This surfaces the failure WITHOUT clearing the list, so the row the action
                 failed on is still visible for a retry. -->
            <p v-if="actionErrorMessage" class="tasks-view__message" data-testid="tasks-action-error" role="alert">
              {{ actionErrorMessage }}
            </p>

            <!-- M4 (design §2.4, §4.6): the assigned view groups its rows into the viewer's personal
                 groups — mounted only for a non-empty ok list read in that view, flat rows while
                 the group reads are out or failed, the board's root keeping `tasks-list` ([fe-16]).
                 The row content below is the same markup as the plain list's rows further down
                 (tasks-groups.spec.ts pins the two equal); the row actions stay this view's
                 ([fe-33]). -->
            <TaskPersonalGroups
              v-if="listResult.kind === 'ok' && currentView === 'assigned'"
              :items="listResult.items"
              :reload-items="reloadListQuietly"
              @org-missing="onListsOrgMissing"
            >
              <template #row="{ item: task }">
                <router-link
                  class="tasks-view__item-title"
                  :to="`/tasks/${encodeURIComponent(task.id)}`"
                  data-testid="tasks-list-item-link"
                >{{ task.title }}</router-link>
                <span class="tasks-view__item-status">{{ task.status === 'done' ? t.statusDone : t.statusOpen }}</span>
                <span v-if="task.due_at" class="tasks-view__item-due" data-testid="tasks-list-item-due">{{ formatViewerInstant(task.due_at, undefined, viewerLocale) }}</span>
                <button
                  v-if="task.status === 'open'"
                  type="button"
                  data-testid="tasks-complete-button"
                  @click="onComplete(task.id)"
                >{{ t.complete }}</button>
                <button
                  v-else
                  type="button"
                  data-testid="tasks-reopen-button"
                  @click="onReopen(task.id)"
                >{{ t.reopen }}</button>
              </template>
            </TaskPersonalGroups>
            <ul v-else-if="listResult.kind === 'ok'" class="tasks-view__list" data-testid="tasks-list">
              <li v-for="task in listResult.items" :key="task.id" class="tasks-view__item" data-testid="tasks-list-item">
                <router-link
                  class="tasks-view__item-title"
                  :to="`/tasks/${encodeURIComponent(task.id)}`"
                  data-testid="tasks-list-item-link"
                >{{ task.title }}</router-link>
                <span class="tasks-view__item-status">{{ task.status === 'done' ? t.statusDone : t.statusOpen }}</span>
                <span v-if="task.due_at" class="tasks-view__item-due" data-testid="tasks-list-item-due">{{ formatViewerInstant(task.due_at, undefined, viewerLocale) }}</span>
                <button
                  v-if="task.status === 'open'"
                  type="button"
                  data-testid="tasks-complete-button"
                  @click="onComplete(task.id)"
                >{{ t.complete }}</button>
                <button
                  v-else
                  type="button"
                  data-testid="tasks-reopen-button"
                  @click="onReopen(task.id)"
                >{{ t.reopen }}</button>
              </li>
            </ul>
            <p v-else-if="listResult.kind === 'empty'" class="tasks-view__message" data-testid="tasks-list-empty">
              {{ t.listEmpty }}
            </p>
            <p v-else-if="listResult.kind === 'error'" class="tasks-view__message" data-testid="tasks-list-error" role="alert">
              {{ t.listLoadFailed }}
            </p>
            <p v-else class="tasks-view__message" data-testid="tasks-list-loading">
              {{ t.loading }}
            </p>
          </div>
        </div>
      </template>
    </template>

    <template v-else-if="contextState?.state === 'org_missing'">
      <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
        {{ t.orgMissing }}
      </p>
    </template>

    <template v-else-if="contextState?.state === 'unavailable'">
      <p class="tasks-view__message" data-testid="tasks-view-unavailable" role="status">
        {{ t.contextUnavailable }}
      </p>
    </template>

    <template v-else-if="contextState?.state === 'forbidden'">
      <p class="tasks-view__message" data-testid="tasks-view-forbidden" role="status">
        {{ t.contextForbidden }}
      </p>
    </template>

    <template v-else-if="contextState?.state === 'error'">
      <p class="tasks-view__message" data-testid="tasks-view-error" role="status">
        {{ t.contextError }}
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../../composables/useAuth'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_FMT_EN, TASKS_FMT_ZH, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import { loadTasksContext, type TasksContextResult } from '../../tasks/tasksContext'
import {
  addAssignee,
  addFollower,
  addTaskToList,
  checkCommentBody,
  completeTask,
  createComment,
  createTask,
  deleteComment,
  deleteTask,
  editComment,
  getTask,
  leaveTask,
  listAllTaskLists,
  listComments,
  listTasks,
  patchTask,
  removeAssignee,
  removeFollower,
  removeTaskFromList,
  reopenTask,
  setCompletionMode,
  setParent,
  type Comment,
  type CompletionMode,
  type TaskDetail,
  type TaskListItem,
  type TaskPatch,
  type TaskView,
  type WriteFailure,
} from '../../tasks/tasksApi'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'
import { formatDueDisplay, formatStartDisplay, formatViewerInstant } from '../../tasks/tasksDateDisplay'
import { onListsChanged } from '../../tasks/tasksListsBus'
import {
  buildTaskPatch,
  checkRemindAt,
  checkTaskDates,
  checkTaskDescription,
  checkTaskTitle,
  createEditorState,
  initDraft,
  rebaseDraft,
  type EditorErrorSlot,
  type EditorState,
  type TaskDraft,
} from '../../tasks/tasksDraft'
import TaskDetailEditor from './TaskDetailEditor.vue'
import TaskDetailLists, { type DetailListsError, type MyListsState } from './TaskDetailLists.vue'
import TaskListsSidebar from './TaskListsSidebar.vue'
import TaskPersonalGroups from './TaskPersonalGroups.vue'

const route = useRoute()
const router = useRouter()

/** `/tasks/:id`'s param, normalized: vue-router can hand back a `string[]` for a repeated segment,
 *  which this route never declares, but reading defensively costs nothing. */
const taskId = computed<string | undefined>(() => {
  const raw = (route as { params?: Record<string, unknown> } | undefined)?.params?.id
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return undefined
})

const contextState = ref<TasksContextResult | null>(null)

// M4 FE-0 (design §9.1): every string this view renders comes from `tasks/labels.ts`, picked by
// `useLocale().isZh` through a `computed` — so a locale change after mount re-renders the copy.
// `viewerLocale` is the matching BCP-47 tag for the two `tasksDateDisplay.ts` formatters.
const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))
const viewerLocale = computed(() => (isZh.value ? 'zh-CN' : 'en-US'))

const VIEWS: Array<{ value: TaskView; labelKey: keyof TasksText }> = [
  { value: 'assigned', labelKey: 'viewAssigned' },
  { value: 'following', labelKey: 'viewFollowing' },
  { value: 'created', labelKey: 'viewCreated' },
  { value: 'delegated', labelKey: 'viewDelegated' },
  { value: 'any_role', labelKey: 'viewAnyRole' },
]

const currentView = ref<TaskView>('assigned')

type ListRenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: TaskListItem[] }
  | { kind: 'empty' }
  | { kind: 'error' }

const listResult = ref<ListRenderState>({ kind: 'loading' })

type DetailRenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; task: TaskDetail }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

const detailResult = ref<DetailRenderState>({ kind: 'loading' })

const orgMissingFromAction = ref(false)

const newTitle = ref('')
const newCompletionMode = ref<CompletionMode>('all')
const creating = ref(false)
const createErrorVisible = ref(false)
const createErrorInvalidTitle = ref(false)
// M4: the contract code of a `validation` create failure (the allowlist of `createTask`), shown
// through `codeMessage` like every inline code here.
// RULED(2026-10-07): [R17] [N2] — an assignee who is not an active member of the org is 422
// `INACTIVE_ORG_MEMBER`. The form sends no `assignees` (the creator alone, whom the server never
// looks up), so today no form input reaches these codes.
const createErrorCode = ref<string | null>(null)

// ---------------------------------------------------------------------------------------------
// M3 (backend contract §3.1, §3.3-§3.7): subtasks, membership, followers, comments, delete.
// ---------------------------------------------------------------------------------------------

// The per-section inline error refs below (`parentError`, `membershipError`, `followerError`,
// `commentError`, `editCommentError`, `deleteError`) hold the contract error CODE the failed call
// reported, not a rendered message: the template maps each through `codeMessage(code, t)`
// (`tasks/labels.ts`) at render time, so the message follows the locale like every other string
// here. A code the table does not list renders the table's generic `actionFailed` copy.

// Subtasks / parent.
const parentInput = ref('')
const parentError = ref<string | null>(null)

// Assignees / completion mode. Both reuse `detailResult.task.assignees` for rendering — neither
// keeps a separate local copy — because a successful mutation always reloads via `loadDetail`
// (see `onAddAssignee` etc. below): the membership response alone does not carry `canComplete`/
// `canReopen`, and removing yourself as an assignee can change YOUR OWN value for those two.
const newAssigneeId = ref('')
const membershipError = ref<string | null>(null)

// Followers. §3.5: `GET /api/tasks/:id` never carries the follower list — the ONLY way the
// frontend learns it is a successful add/remove/leave response. `null` means "never learned it
// yet" (distinct from `[]`, a genuinely empty list) — see the M3 frontend design doc for how the
// follower section and the Leave button read this.
const followersState = ref<string[] | null>(null)

// Leave: the server's `canLeave` decides when the detail body carries it; otherwise fall back to
// "the viewer appears in the follower list we have learned".
const canLeaveCurrentTask = computed(() => {
  const state = detailResult.value
  if (state.kind === 'ok' && state.task.canLeave !== undefined) return state.task.canLeave
  return followersState.value !== null && currentUserId.value !== null && followersState.value.includes(currentUserId.value)
})
const newFollowerId = ref('')
const followerError = ref<string | null>(null)

// Row-level abilities from the detail body (contract §3.2). `false` hides the controls the server
// would answer with its uniform 404; an absent flag (an older body) leaves them visible, and the
// server's own check stays the only gate. Hiding is a courtesy, never the enforcement.
function detailAbility(flag: 'canEdit' | 'canDelete' | 'canComment'): boolean {
  const state = detailResult.value
  return state.kind === 'ok' && state.task[flag] !== false
}
const canEditTask = computed(() => detailAbility('canEdit'))
const canDeleteTask = computed(() => detailAbility('canDelete'))
const canCommentTask = computed(() => detailAbility('canComment'))
// [fe-45] ruled 2026-10-07: adding or removing an assignee or a follower takes a
// direct role on the task (creator or assignee). The detail's `canManageMembers` says whether the
// viewer has one, so the four member controls follow it rather than `canEdit`, which a viewer who
// edits the task only through a list also has; completion mode, the parent and the editor stay on
// `canEdit`, and Leave on `canLeave`.
// [fe-46] a body without the key (main's M3 backend, where `edit` comes only from being the task's
// creator or an assignee) falls back to `canEdit`, the ability that backend checks for the four
// writes; the M3 behaviour stays as it is, the absent-flag rule of `detailAbility` included.
const canManageTaskMembers = computed(() => {
  const state = detailResult.value
  if (state.kind === 'ok' && state.task.canManageMembers !== undefined) return state.task.canManageMembers
  return canEditTask.value
})

// Comments. Own its own render state and its own out-of-order-resolution generation — a stale
// `listComments` response must not paint over a NEWER task's comments (or the current task's
// freshly-empty state after a fast re-entry), the same discipline `detailGeneration` applies to
// `getTask`. A comments load failure never blanks `detailResult` — the task itself still rendered
// fine — so it gets its own dedicated error testid instead of reusing `tasks-action-error`.
type CommentsRenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: Comment[] }
  | { kind: 'error' }
const commentsResult = ref<CommentsRenderState>({ kind: 'loading' })
// `true` when the last load stopped at the client's page bound with more comments on the server —
// the list is then the OLDEST part of the thread and the template says so.
const commentsTruncated = ref(false)
let commentsGeneration = 0
const newCommentBody = ref('')
const commentError = ref<string | null>(null)
const editingCommentId = ref<string | null>(null)
const editingCommentBody = ref('')
const editCommentError = ref<string | null>(null)

// The viewer's own id — resolved ONCE (not re-fetched per task navigation) via `useAuth`, and
// used for two gates the M3 contract leaves entirely to the client: which comments show
// edit/delete (own-comment only), and whether the Leave button should render at all (only once a
// followers response has confirmed the viewer IS one — §3.5's `leave` ability is follower-only;
// a non-follower calling it gets a plain 404, so showing it unconditionally would invite that).
// `'unavailable'` (the id itself could not be resolved) falls back to showing edit/delete on
// EVERY comment — documented in the M3 frontend design doc — but does NOT extend to the Leave
// button: an unresolvable id can never prove "the viewer is this follower", so Leave stays hidden
// rather than guessing.
const currentUserId = ref<string | null>(null)
const currentUserStatus = ref<'pending' | 'known' | 'unavailable'>('pending')
let currentUserFetchStarted = false

async function ensureCurrentUser(): Promise<void> {
  if (currentUserFetchStarted) return
  currentUserFetchStarted = true
  let id: string | null = null
  try {
    id = await useAuth().getCurrentUserId()
  } catch {
    id = null
  }
  currentUserId.value = id
  currentUserStatus.value = id ? 'known' : 'unavailable'
}

function canEditOwnComment(comment: Comment): boolean {
  if (comment.deleted) return false
  if (!canCommentTask.value) return false
  if (currentUserStatus.value === 'pending') return false
  if (currentUserStatus.value === 'unavailable') return true
  return comment.authorId === currentUserId.value
}

// Delete task.
const deleteConfirmVisible = ref(false)
const deleteError = ref<string | null>(null)

/** Set by `onComplete`/`onReopen` for any result other than 'ok'/'org_missing' (those two are
 *  handled separately — 'ok' refreshes the list, 'org_missing' switches to the guidance block).
 *  'not_found' and 'error' share one generic message: neither is actionable differently by the
 *  viewer, unlike 'forbidden', which names the real cause. */
const actionErrorKind = ref<'forbidden' | 'not_found' | 'error' | 'invalid_version' | null>(null)

const actionErrorMessage = computed(() => {
  if (actionErrorKind.value === 'forbidden') return t.value.actionForbidden
  // M4 (design §4.3): a PATCH answered 422 `INVALID_VERSION` — not something the viewer can fix
  // on the form, so it takes the page banner, with its own copy.
  if (actionErrorKind.value === 'invalid_version') return t.value.codeInvalidVersion
  if (actionErrorKind.value) return t.value.actionFailed
  return null
})

// Guards against a slow response for a superseded view (or a superseded reload) painting over a
// newer one's result — the same shape as this codebase's other transition-safe reads.
let listGeneration = 0

// Identifies "the list page" a row action (complete/reopen) — or the create form — started from,
// mirroring the detail page's own `taskId.value !== id` guard (see `onDetailComplete`/
// `onDetailReopen` below). Bumped whenever the viewer leaves the list for a reason an in-flight
// action can't see coming: navigating to `/tasks/:id` (the `watch(taskId, ...)` handler below) or
// switching to a different list view (`switchView`). A captured token that no longer matches after
// an await means the response belongs to a page the viewer isn't looking at anymore.
let listPageToken = 0

async function loadList(): Promise<void> {
  listGeneration += 1
  const mine = listGeneration
  listResult.value = { kind: 'loading' }
  const result = await listTasks(currentView.value)
  if (mine !== listGeneration) return

  if (result.kind === 'ok') {
    listResult.value = result.items.length === 0 ? { kind: 'empty' } : { kind: 'ok', items: result.items }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissingFromAction.value = true
    return
  }
  // 'predicate_error' | 'forbidden' | 'not_found' | 'error': all render as the same discriminable
  // failure state (distinct from 'empty' — an empty 200 and a failed load must never look the
  // same), but 'predicate_error' specifically must NOT set `orgMissingFromAction`.
  listResult.value = { kind: 'error' }
}

/** M4 (design §4.6, `[fe-40]`): the list re-read in place for the assigned view's grouping board
 *  (its refresh button, and after a write the server answered 404) — the rows stay on screen until
 *  the answer lands, so the board keeps its state. The answer reads like `loadList`'s, under the
 *  same generation. */
async function reloadListQuietly(): Promise<void> {
  listGeneration += 1
  const mine = listGeneration
  const result = await listTasks(currentView.value)
  if (mine !== listGeneration) return
  if (result.kind === 'ok') {
    listResult.value = result.items.length === 0 ? { kind: 'empty' } : { kind: 'ok', items: result.items }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissingFromAction.value = true
    return
  }
  listResult.value = { kind: 'error' }
}

// Same out-of-order-resolution discipline as `listGeneration` above, for the detail read: a
// superseded `getTask` response (an OLDER id's request resolving AFTER a NEWER id's already did)
// must never overwrite the currently-displayed task.
let detailGeneration = 0

async function loadDetail(id: string): Promise<void> {
  detailGeneration += 1
  const mine = detailGeneration
  detailResult.value = { kind: 'loading' }
  const result = await getTask(id)
  if (mine !== detailGeneration) return
  detailResult.value = result.kind === 'ok' ? { kind: 'ok', task: result.task } : { kind: result.kind }
  if (result.kind === 'ok' && result.task.followers !== undefined) followersState.value = result.task.followers
}

/** M3: a SECOND read the detail page needs — `GET /api/tasks/:id` (`loadDetail` above) does not
 *  carry comments. Own generation counter, same out-of-order-resolution discipline as
 *  `detailGeneration`/`listGeneration`: every call bumps it itself (no separate bump needed
 *  anywhere else), so a fresh call — whether from a real navigation or a fast re-entry to the
 *  SAME id — always wins over anything still in flight from before it. */
async function loadComments(id: string): Promise<void> {
  commentsGeneration += 1
  const mine = commentsGeneration
  commentsResult.value = { kind: 'loading' }
  commentsTruncated.value = false
  const result = await listComments(id, { isSuperseded: () => mine !== commentsGeneration })
  if (mine !== commentsGeneration) return
  commentsResult.value = result.kind === 'ok' ? { kind: 'ok', items: result.items } : { kind: 'error' }
  commentsTruncated.value = result.kind === 'ok' && result.items.length < result.total
}

/** Entry point for landing on `/tasks/:id` — used by the `taskId` watch and `onMounted`, NOT by
 *  the M3 action handlers below (those call `loadDetail` directly when they need a refresh; a
 *  membership/parent mutation does not change the comment thread, and re-fetching the viewer's
 *  own id on every action would be pointless — `ensureCurrentUser` is itself idempotent). */
async function enterDetail(id: string): Promise<void> {
  // M4: the "my lists" read runs on its own (own generation), outside the two reads this entry
  // waits for — it names the lists of the lists section and nothing else waits on it.
  void loadMyLists()
  await Promise.all([loadDetail(id), loadComments(id)])
  void ensureCurrentUser()
}

function switchView(view: TaskView): void {
  if (view === currentView.value) return
  listPageToken += 1
  currentView.value = view
  void loadList()
}

async function onCreate(): Promise<void> {
  const title = newTitle.value.trim()
  if (!title || creating.value) return
  creating.value = true
  createErrorVisible.value = false
  createErrorInvalidTitle.value = false
  createErrorCode.value = null
  const page = listPageToken
  try {
    const result = await createTask({ title, completionMode: newCompletionMode.value })
    // Same page-moved-on guard as `onComplete`/`onReopen` below — a late org_missing here would
    // otherwise flip `orgMissingFromAction`, which the detail-page template checks FIRST (before
    // its own states), painting the guidance block over whatever the viewer navigated to. A late
    // 'ok' still clears the typed title (the task really was created — leaving stale text sitting
    // in the input invites a duplicate submit next time the viewer is back on the list) and still
    // notifies the badge bus; it just has no current list to reload.
    if (page !== listPageToken) {
      if (result.kind === 'ok') {
        newTitle.value = ''
        notifyTasksChanged()
      }
      return
    }
    if (result.kind === 'ok') {
      newTitle.value = ''
      notifyTasksChanged()
      await loadList()
    } else if (result.kind === 'org_missing') {
      orgMissingFromAction.value = true
    } else {
      createErrorInvalidTitle.value = result.kind === 'invalid_title'
      if (result.kind === 'validation') createErrorCode.value = result.code
      createErrorVisible.value = true
    }
  } finally {
    creating.value = false
  }
}

/** Shared result-classification for `completeTask`/`reopenTask` outcomes, used by BOTH the list
 *  row actions and the detail-page actions below. Returns `'ok'` when the caller should reload its
 *  own data source; any other outcome has already fully updated the shared `orgMissingFromAction` /
 *  `actionErrorKind` state and the caller does nothing further. */
function applyActionOutcome(kind: 'ok' | 'org_missing' | 'forbidden' | 'not_found' | 'error'): 'ok' | 'other' {
  if (kind === 'org_missing') {
    orgMissingFromAction.value = true
    return 'other'
  }
  if (kind === 'ok') {
    // P3(iii): a later action succeeding must clear a stale guidance flag left by an EARLIER
    // action (or an earlier list/detail read) — nothing else ever flips this back to false, so
    // without this the view would stay stuck on the org-guidance block for the rest of the mounted
    // instance even after the org context recovers. Reset BEFORE the reload, not after: the reload
    // can legitimately set this flag itself (its own org_missing branch), and resetting after it
    // would clobber that fresh `true` back to `false`.
    orgMissingFromAction.value = false
    notifyTasksChanged()
    return 'ok'
  }
  // 'forbidden' | 'not_found' | 'error' — surfaced via `actionErrorMessage`; the caller leaves its
  // own data exactly as it is (no reload), so whatever the action failed on stays visible.
  actionErrorKind.value = kind
  return 'other'
}

async function onComplete(id: string): Promise<void> {
  actionErrorKind.value = null
  const page = listPageToken
  const result = await completeTask(id)
  // Guard against the viewer having moved on WHILE the request was in flight — navigated to a
  // task's detail page, or switched to a different list view — mirroring the detail page's own
  // `taskId.value !== id` guard below. A late forbidden/error/org_missing must not paint its
  // banner/guidance over wherever the viewer is looking now, and a late 'ok' has no list left to
  // reload here (wherever they moved to already loaded its own data) — but it really did happen
  // server-side, so the shared badge bus still needs to hear about it.
  if (page !== listPageToken) {
    if (result.kind === 'ok') notifyTasksChanged()
    return
  }
  if (applyActionOutcome(result.kind) === 'ok') await loadList()
}

async function onReopen(id: string): Promise<void> {
  actionErrorKind.value = null
  const page = listPageToken
  const result = await reopenTask(id, 'self')
  if (page !== listPageToken) {
    if (result.kind === 'ok') notifyTasksChanged()
    return
  }
  if (applyActionOutcome(result.kind) === 'ok') await loadList()
}

// True while a detail complete/reopen request is in flight — disables both detail action buttons
// so a second click can't fire a second overlapping request. A per-request token (rather than a
// bare boolean flip in `finally`) so a STALE request's `finally` can never clear a NEWER request's
// pending flag out from under it.
const detailActionPending = ref(false)
let detailActionToken = 0

async function onDetailComplete(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await completeTask(id)
    // Guard against a navigation (to a different id, OR back to the list) that happened WHILE the
    // request was in flight. Checked BEFORE `applyActionOutcome` — not just before the reload:
    // a late 403/error/org_missing result must not paint its banner/guidance over whatever the
    // viewer is looking at now, and reloading a no-longer-current id would bump `detailGeneration`
    // and briefly paint the OLD task's data over it too. The watch below already issued its own
    // `loadDetail`/`loadList` for wherever the viewer navigated to, so this action has nothing
    // left to do there — except a late 'ok' really did happen server-side, so the shared badge
    // still needs to hear about it.
    if (taskId.value !== id) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (applyActionOutcome(result.kind) === 'ok') await loadDetail(id)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onDetailReopen(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await reopenTask(id, 'self')
    if (taskId.value !== id) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (applyActionOutcome(result.kind) === 'ok') await loadDetail(id)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

// ---------------------------------------------------------------------------------------------
// M3 detail actions. All share `detailActionPending`/`detailActionToken` with
// `onDetailComplete`/`onDetailReopen` above — ONE shared in-flight flag disables every detail
// button (not just the one clicked) while ANY detail action is pending, deliberately: only one
// button click can start an action at a time anyway (the buttons are all `:disabled` on the same
// flag), so per-section tokens would only multiply the guard surface for no extra coverage. See
// the M3 frontend design doc for this choice written out in full.
//
// UNLIKE `onDetailComplete`/`onDetailReopen` (which compare `taskId.value !== id`), every handler
// below compares the captured `token` against `detailActionToken` instead. The two are NOT
// equivalent: `taskId.value !== id` only catches "the viewer is looking at a different id now" —
// it misses "the viewer left this exact id and came back to it" (detail t1 -> list -> detail t1
// again), which bumps `detailActionToken` twice (once per navigation edge, in the `watch` below)
// while `taskId.value` ends up right back at `t1`. The token strictly increases on every such
// edge, so it catches that round trip too.
// ---------------------------------------------------------------------------------------------

/** Shared failure classification for every M3 detail action. `not_found` / `forbidden` / `error`
 *  reuse the SAME `actionErrorKind` banner `onDetailComplete`/`onDetailReopen` already use;
 *  `org_missing` reuses the SAME org-guidance flag. `validation` and `conflict` are per-call —
 *  each call site below passes its OWN setter so the message renders next to the control that
 *  caused it rather than in the generic banner; a call site that has no validation/conflict codes
 *  of its own simply omits that argument, and this falls back to the generic banner rather than
 *  silently dropping the failure. */
function applyDetailFailure(
  failure: WriteFailure,
  onValidation?: (code: string) => void,
  onConflict?: (code: string) => void,
): void {
  if (failure.kind === 'org_missing') {
    orgMissingFromAction.value = true
    return
  }
  if (failure.kind === 'validation') {
    if (onValidation) onValidation(failure.code)
    else actionErrorKind.value = 'error'
    return
  }
  if (failure.kind === 'conflict') {
    if (onConflict) onConflict(failure.code)
    else actionErrorKind.value = 'error'
    return
  }
  actionErrorKind.value = failure.kind
}

async function onSetParent(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  const raw = parentInput.value.trim()
  if (!raw) return
  parentError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await setParent(id, raw)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      parentInput.value = ''
      notifyTasksChanged()
      await loadDetail(id)
      return
    }
    applyDetailFailure(result, (code) => { parentError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onMakeIndependent(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  parentError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await setParent(id, null)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      notifyTasksChanged()
      await loadDetail(id)
      return
    }
    applyDetailFailure(result, (code) => { parentError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onAddAssignee(): Promise<void> {
  const id = taskId.value
  const userId = newAssigneeId.value.trim()
  if (!id || !userId || detailActionPending.value) return
  membershipError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await addAssignee(id, userId)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      newAssigneeId.value = ''
      notifyTasksChanged()
      await loadDetail(id)
      return
    }
    applyDetailFailure(result, (code) => { membershipError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onRemoveAssignee(userId: string): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  membershipError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await removeAssignee(id, userId)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      notifyTasksChanged()
      await loadDetail(id)
      return
    }
    applyDetailFailure(result, (code) => { membershipError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

function onCompletionModeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'all' || value === 'any') void onSetCompletionMode(value)
}

async function onSetCompletionMode(mode: CompletionMode): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  if (detailResult.value.kind === 'ok' && detailResult.value.task.completionMode === mode) return
  membershipError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await setCompletionMode(id, mode)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      notifyTasksChanged()
      await loadDetail(id)
      return
    }
    applyDetailFailure(result, (code) => { membershipError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

/** After a follower write the detail's abilities (`canLeave` in particular) are stale, so re-read
 *  it. Leaving can end the viewer's access altogether: a follower-only viewer's re-read is a 404,
 *  and the page then returns to the list instead of showing "task not found". */
async function refreshAfterFollowerWrite(id: string, options: { leaving?: boolean } = {}): Promise<void> {
  await loadDetail(id)
  if (options.leaving && taskId.value === id && detailResult.value.kind === 'not_found') {
    await router.push('/tasks')
  }
}

async function onAddFollower(): Promise<void> {
  const id = taskId.value
  const userId = newFollowerId.value.trim()
  if (!id || !userId || detailActionPending.value) return
  followerError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await addFollower(id, userId)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      newFollowerId.value = ''
      followersState.value = result.task.followers
      notifyTasksChanged()
      await refreshAfterFollowerWrite(id)
      return
    }
    applyDetailFailure(result, (code) => { followerError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onRemoveFollower(userId: string): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  followerError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await removeFollower(id, userId)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      followersState.value = result.task.followers
      notifyTasksChanged()
      await refreshAfterFollowerWrite(id)
      return
    }
    applyDetailFailure(result, (code) => { followerError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onLeave(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  followerError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await leaveTask(id)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      followersState.value = result.task.followers
      notifyTasksChanged()
      await refreshAfterFollowerWrite(id, { leaving: true })
      return
    }
    applyDetailFailure(result, (code) => { followerError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onCreateComment(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  const body = newCommentBody.value
  const check = checkCommentBody(body)
  if (check !== 'ok') {
    commentError.value = check
    return
  }
  commentError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await createComment(id, body)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      newCommentBody.value = ''
      if (commentsResult.value.kind === 'ok') {
        commentsResult.value = { kind: 'ok', items: [...commentsResult.value.items, result.comment] }
      } else {
        // The list is still loading or failed to load, so there is nothing to append to: re-read
        // it (bumping the generation also discards a stale in-flight read that predates this post).
        void loadComments(id)
      }
      notifyTasksChanged()
      return
    }
    applyDetailFailure(result, (code) => { commentError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

function onStartEditComment(comment: Comment): void {
  editingCommentId.value = comment.id
  editingCommentBody.value = comment.body ?? ''
  editCommentError.value = null
}

function onCancelEditComment(): void {
  editingCommentId.value = null
  editingCommentBody.value = ''
  editCommentError.value = null
}

async function onSaveEditComment(commentId: string): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  const body = editingCommentBody.value
  const check = checkCommentBody(body)
  if (check !== 'ok') {
    editCommentError.value = check
    return
  }
  editCommentError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await editComment(id, commentId, body)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      editingCommentId.value = null
      editingCommentBody.value = ''
      if (commentsResult.value.kind === 'ok') {
        commentsResult.value = {
          kind: 'ok',
          items: commentsResult.value.items.map((c) => (c.id === result.comment.id ? result.comment : c)),
        }
      }
      notifyTasksChanged()
      return
    }
    applyDetailFailure(result, (code) => { editCommentError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onDeleteComment(commentId: string): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  commentError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await deleteComment(id, commentId)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      if (commentsResult.value.kind === 'ok') {
        commentsResult.value = {
          kind: 'ok',
          items: commentsResult.value.items.map((c) => (c.id === result.comment.id ? result.comment : c)),
        }
      }
      notifyTasksChanged()
      return
    }
    applyDetailFailure(result, (code) => { commentError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

function onDeleteClick(): void {
  deleteConfirmVisible.value = true
  deleteError.value = null
}

function onDeleteCancel(): void {
  deleteConfirmVisible.value = false
  deleteError.value = null
}

/** §3.7: no cascade — `HAS_CHILDREN` (409, via `applyDetailFailure`'s `conflict` branch) shows
 *  inline next to the delete control instead of the generic banner. On success, `notifyTasksChanged`
 *  fires (inside the shared 'ok' branch, BEFORE the navigation below) and THEN this navigates to
 *  `/tasks` — the `watch(taskId, …)` handler that navigation triggers bumps `detailActionToken`
 *  itself, so this action's own `finally` (token already stale by then) correctly does nothing
 *  further instead of re-touching `detailActionPending`. */
async function onDeleteConfirm(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  deleteError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await deleteTask(id)
    if (token !== detailActionToken) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      deleteConfirmVisible.value = false
      notifyTasksChanged()
      await router.push('/tasks')
      return
    }
    applyDetailFailure(result, undefined, (code) => { deleteError.value = code })
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

// ---------------------------------------------------------------------------------------------
// M4 FE-4 (design §4.3, §7.2, §7.3): the editor (`PATCH /api/tasks/:id`) and the lists section.
//
// Both child components are stateless (`[fe-15]`): the detail block is re-created on every
// `loadDetail` (it first sets `loading`), so the draft, the editor's phase and errors, and the
// "my lists" read live here. Every write below runs on the shared `detailActionToken` /
// `detailActionPending` — one action at a time across the whole detail page, M3's included — and
// a result that lands after a route edge only does its side effects.
// ---------------------------------------------------------------------------------------------

/** The editor state: `EditorState` plus the canonical values the draft was taken from (`base`,
 *  what `rebaseDraft` and `dirty` compare against) and a `form` slot for a code that names no
 *  field. */
interface DetailEditorState extends EditorState {
  fieldErrors: Partial<Record<EditorErrorSlot, string>>
  base: TaskDraft | null
}

function createDetailEditorState(): DetailEditorState {
  return { ...createEditorState(), base: null }
}

const editorState = ref<DetailEditorState>(createDetailEditorState())

// The editor needs a backend with `PATCH /api/tasks/:id`. That route and the detail's four S4 keys
// come from the same PR-3a slice, so the S4 group (read through `description`, as the read-only
// rows read it) says the route is there; main's M3 backend sends `version` too, but neither the S4
// keys nor the route. `version` is what the request sends back as `expectedVersion`.
const editorAvailable = computed(() => {
  const state = detailResult.value
  return canEditTask.value && state.kind === 'ok' && state.task.description !== undefined && state.task.version !== undefined
})

// Synchronous, so the update lands in the same step as the assignment `loadDetail` makes — before
// any code after an `await loadDetail(...)` runs — and the editor's own handlers below see the
// state this produced.
// - a clean draft (or none yet) takes the reloaded values;
// - a dirty draft is carried across (`rebaseDraft`, `[fe-19]`); after the editor's own 409 reload
//   the phase becomes `conflict`, after any other reload the viewer is told the server changed;
// - `pending` / `reloading` are the editor's own phases; the PATCH-ok path resets the state to a
//   clean one before it reloads, so that reload just re-initializes the draft.
watch(
  detailResult,
  (next) => {
    if (next.kind !== 'ok') return
    const state = editorState.value
    const fresh = initDraft(next.task)
    if (state.draft === null || state.base === null || !state.dirty) {
      editorState.value = {
        ...state,
        draft: fresh,
        base: fresh,
        dirty: false,
        serverUpdated: false,
        phase: state.phase === 'reloading' ? 'conflict' : state.phase,
      }
      return
    }
    const draft = rebaseDraft(state.base, state.draft, fresh)
    const dirty = buildTaskPatch(next.task, draft) !== null
    if (state.phase === 'reloading') {
      editorState.value = { ...state, draft, base: fresh, dirty, phase: 'conflict', serverUpdated: false }
      return
    }
    editorState.value = { ...state, draft, base: fresh, dirty, serverUpdated: dirty }
  },
  { flush: 'sync' },
)

function onEditorDraftUpdate(next: TaskDraft): void {
  const state = editorState.value
  if (state.base === null) return
  editorState.value = { ...state, draft: next, dirty: buildTaskPatch(state.base, next) !== null, fieldErrors: {} }
}

/** "Discard my changes": the draft goes back to the task's current values. */
function onEditorDiscard(): void {
  const state = detailResult.value
  if (state.kind !== 'ok' || detailActionPending.value) return
  const fresh = initDraft(state.task)
  editorState.value = { ...createDetailEditorState(), draft: fresh, base: fresh }
}

const DATE_PATCH_KEYS = ['dueDate', 'dueTime', 'startDate', 'startTime', 'timeZone'] as const
const DATE_ONLY_PATCH_KEYS = ['dueDate', 'dueTime', 'startDate', 'startTime'] as const

// RULED(2026-10-07): [R16] — the badge counts by due date and zone, so a PATCH touching
// either is the only one that notifies it.
const BADGE_PATCH_KEYS = ['dueDate', 'dueTime', 'timeZone'] as const

/** The pre-checks, in the server's order — title, description, dates, reminder — each on the
 *  keys the patch carries (the date rules read the whole draft: it is the intended end state).
 *  The first code found and the field it renders next to; `null` when all pass. */
function precheckTaskPatch(patch: TaskPatch, draft: TaskDraft): { slot: EditorErrorSlot; code: string } | null {
  if (patch.title !== undefined) {
    const code = checkTaskTitle(patch.title)
    if (code !== 'ok') return { slot: 'title', code }
  }
  if (patch.description !== undefined) {
    const code = checkTaskDescription(patch.description)
    if (code !== 'ok') return { slot: 'description', code }
  }
  if (DATE_PATCH_KEYS.some((key) => key in patch)) {
    const check = checkTaskDates(draft)
    if (!check.ok) return { slot: check.field, code: check.code }
  }
  if ('remindAt' in patch) {
    const code = checkRemindAt(patch.remindAt ?? null)
    if (code !== 'ok') return { slot: 'remindAt', code }
  }
  return null
}

/** Where a 422 code of `PATCH /api/tasks/:id` renders. `INVALID_DATE` names no field: it goes
 *  next to the first date / time key the request carried (the due date when it carried none — a
 *  zone change re-computes the due instant). A code outside the contract goes next to the submit
 *  button. */
function editorSlotForCode(code: string, patch: TaskPatch): EditorErrorSlot {
  switch (code) {
    case 'INVALID_TITLE':
      return 'title'
    case 'INVALID_DESCRIPTION':
      return 'description'
    case 'INVALID_TIME_ZONE':
    case 'TIME_ZONE_REQUIRED':
      return 'timeZone'
    case 'INVALID_REMIND_AT':
      return 'remindAt'
    case 'INVALID_DATE':
      return DATE_ONLY_PATCH_KEYS.find((key) => key in patch) ?? 'dueDate'
    default:
      return 'form'
  }
}

function setEditorError(slot: EditorErrorSlot, code: string): void {
  editorState.value = { ...editorState.value, fieldErrors: { [slot]: code } }
}

// RULED(2026-10-07): [R03] — the edit is one `PATCH /api/tasks/:id` under `expectedVersion`;
// a 409 reloads the task, keeps the draft and asks the viewer to review it.
/**
 * Submit (design §4.3, §7.3). The request carries `expectedVersion` = the `version` of the detail
 * on screen — after a 409 that is the RELOADED detail's, never the 409 body's `currentVersion`
 * (that one only goes into the message). Outcomes:
 *   - ok: the editor resets, the task reloads, and the badge hears about it when the patch
 *     touched the due date, its time or the zone;
 *   - 409 `VERSION_CONFLICT`: phase `reloading`, reload, then `conflict` with the draft carried
 *     over (the `detailResult` watch above);
 *   - 422 `INVALID_VERSION`: the page banner; any other 422 / 409 code: next to its field, the
 *     draft kept; anything else: the shared detail failure handling.
 */
async function onPatchTask(patch: TaskPatch): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  const detail = detailResult.value
  const state = editorState.value
  if (!editorAvailable.value || detail.kind !== 'ok' || detail.task.version === undefined || state.draft === null) return
  const failed = precheckTaskPatch(patch, state.draft)
  if (failed) {
    setEditorError(failed.slot, failed.code)
    return
  }
  const touchesBadge = BADGE_PATCH_KEYS.some((key) => key in patch)
  editorState.value = { ...state, phase: 'pending', conflictVersion: null, fieldErrors: {}, serverUpdated: false }
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await patchTask(id, { expectedVersion: detail.task.version, ...patch })
    if (token !== detailActionToken) {
      if (result.kind === 'ok' && touchesBadge) notifyTasksChanged()
      return
    }
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      editorState.value = createDetailEditorState()
      if (touchesBadge) notifyTasksChanged()
      await loadDetail(id)
      return
    }
    if (result.kind === 'conflict' && result.code === 'VERSION_CONFLICT') {
      editorState.value = { ...editorState.value, phase: 'reloading', conflictVersion: result.currentVersion ?? null }
      await loadDetail(id)
      // A reload that landed moved the phase on already (the `detailResult` watch). A failed one
      // leaves the detail's own error state on screen, and the phase still ends here. A route edge
      // during the reload reset the editor to `idle`, which this leaves alone.
      if (editorState.value.phase === 'reloading') editorState.value = { ...editorState.value, phase: 'conflict' }
      return
    }
    editorState.value = { ...editorState.value, phase: 'idle' }
    const onCode = (code: string): void => {
      if (code === 'INVALID_VERSION') actionErrorKind.value = 'invalid_version'
      else setEditorError(editorSlotForCode(code, patch), code)
    }
    applyDetailFailure(result, onCode, onCode)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

// The "my lists" read: every page of the viewer's lists, archived included, so the lists section
// can name the lists holding the task and offer the ones it can be added to. Own generation.
const myListsResult = ref<MyListsState>({ kind: 'loading' })
let myListsGeneration = 0
const listsError = ref<DetailListsError | null>(null)

async function loadMyLists(): Promise<void> {
  myListsGeneration += 1
  const mine = myListsGeneration
  myListsResult.value = { kind: 'loading' }
  const result = await listAllTaskLists({ includeArchived: true }, { isSuperseded: () => mine !== myListsGeneration })
  if (mine !== myListsGeneration) return
  // Any failure (the degraded `org_missing` body included) only leaves the names unknown: the
  // section still lists the ids; it never takes over the detail page.
  myListsResult.value = result.kind === 'ok'
    ? { kind: 'ok', items: result.items, complete: result.items.length >= result.total }
    : { kind: 'unavailable' }
}

// M4 FE-5 (design §4.3): a list write elsewhere (the lists bus) re-reads "my lists" — on the detail
// page only, the one place they are shown; entering a detail page reads them anyway (`[fe-23]`:
// only while the context is ready). Subscribed in setup, before anything awaits, so an early
// unmount can never leave a listener behind.
const unsubscribeLists = onListsChanged(() => {
  if (contextState.value?.state === 'ready' && taskId.value) void loadMyLists()
})

onBeforeUnmount(() => {
  unsubscribeLists()
})

/** The lists sidebar's read or create, or a grouping-board write, reported no org selected: the
 *  list page shows the same guidance block as its own list read does. */
function onListsOrgMissing(): void {
  orgMissingFromAction.value = true
}

// RULED(2026-10-07): [own-25] (PR-3a, R12 (a1)) — adding needs a direct role on the task; the 404
// folds that with "no such list" and "not in this org", and the inline copy reads it that way
// (`[fe-02]`).
/** Add the task to one of my lists (design §4.3). ok reloads the detail (its `listIds`); the
 *  badge does not count lists, so nothing is notified, late or not. */
async function onAddTaskToList(listId: string): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  listsError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await addTaskToList(listId, id)
    if (token !== detailActionToken) return
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      await loadDetail(id)
      return
    }
    if (result.kind === 'not_found') {
      listsError.value = { kind: 'add_not_found' }
      return
    }
    const onCode = (code: string): void => {
      listsError.value = { kind: 'code', code }
    }
    applyDetailFailure(result, onCode, onCode)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

/** Remove the task from a list (design §4.3), after the section's inline confirmation. ok
 *  reloads the detail; a 404 takes the page banner. */
async function onRemoveTaskFromList(listId: string): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  listsError.value = null
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await removeTaskFromList(listId, id)
    if (token !== detailActionToken) return
    if (result.kind === 'ok') {
      orgMissingFromAction.value = false
      await loadDetail(id)
      return
    }
    const onCode = (code: string): void => {
      listsError.value = { kind: 'code', code }
    }
    applyDetailFailure(result, onCode, onCode)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

// Vue Router reuses this component instance across `/tasks` <-> `/tasks/:id` navigations (both
// resolve to the same file), so `onMounted` alone would miss a same-instance transition. This
// fires on every edge: list -> detail and detail -> detail load the new id's detail; detail -> list
// reloads the list. Also clears any action-error state left over from whatever the viewer was
// looking at before — it belongs to that stale id, not the one now showing.
watch(taskId, (id) => {
  if (contextState.value?.state !== 'ready') return
  actionErrorKind.value = null
  // A navigation away invalidates whatever detail action was in flight for the PREVIOUS id — bump
  // the token so that request's own `finally` (see `onDetailComplete`/`onDetailReopen`) can no
  // longer be the one that clears `detailActionPending`, and unblock the buttons on wherever the
  // viewer just navigated to (there is no still-in-flight request FOR that page yet).
  detailActionToken += 1
  detailActionPending.value = false
  // Same idea for the LIST page's own row actions / create form (see `listPageToken` above) — any
  // route change away from (or between) `/tasks/:id` routes also means "the list" is no longer
  // what's showing, so a list action still in flight from before this navigation must be treated
  // as stale too.
  listPageToken += 1
  // A list READ still in flight from before this navigation is stale too: bump the generation so
  // its late result (including a late org_missing) cannot paint over the page now showing.
  listGeneration += 1
  // M3: every section's per-task local state belongs to whichever id was showing before this
  // navigation — reset it here, the same reasoning as `actionErrorKind` above. `followersState`
  // resets to `null` ("never learned it yet") rather than `[]`: the new id's follower list is
  // genuinely unknown until an add/remove/leave response on THAT task confirms it, distinct from
  // a task that really has zero followers. `commentsResult` resets to `loading` for the same
  // reason `detailResult` does — `loadComments` (via `enterDetail` below) also does this itself
  // at its own start, so this is a defensive reset for the "navigated away from a detail page
  // entirely" edge (list route, where nothing calls `loadComments` again) that `enterDetail`
  // alone would not reach.
  parentInput.value = ''
  parentError.value = null
  newAssigneeId.value = ''
  membershipError.value = null
  followersState.value = null
  newFollowerId.value = ''
  followerError.value = null
  newCommentBody.value = ''
  commentError.value = null
  editingCommentId.value = null
  editingCommentBody.value = ''
  editCommentError.value = null
  commentsResult.value = { kind: 'loading' }
  commentsTruncated.value = false
  deleteConfirmVisible.value = false
  deleteError.value = null
  // M4: the editor's draft, phase and errors, the "my lists" read and the lists section's inline
  // error belong to the task that was showing (design §7.3: a route edge returns to idle).
  editorState.value = createDetailEditorState()
  myListsGeneration += 1
  myListsResult.value = { kind: 'loading' }
  listsError.value = null
  if (id) {
    void enterDetail(id)
  } else {
    void loadList()
  }
})

onMounted(async () => {
  contextState.value = await loadTasksContext()
  if (contextState.value.state !== 'ready') return
  if (taskId.value) {
    await enterDetail(taskId.value)
  } else {
    await loadList()
  }
})
</script>

<style scoped>
.tasks-view {
  padding: 24px;
}

.tasks-view__header h1 {
  margin: 0 0 8px;
}

.tasks-view__message {
  color: var(--el-text-color-secondary, #666);
}

.tasks-view__detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tasks-view__detail-assignees {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-view__detail-assignee {
  display: flex;
  gap: 12px;
  padding: 4px 0;
}

.tasks-view__detail-description {
  white-space: pre-wrap;
}

.tasks-view__columns {
  display: grid;
  grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

@media (max-width: 720px) {
  .tasks-view__columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

.tasks-view__switcher {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}

.tasks-view__create {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.tasks-view__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-view__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter, #eee);
}
</style>

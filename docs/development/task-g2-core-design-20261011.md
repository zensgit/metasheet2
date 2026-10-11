# Task line G2-core: status filter on the task list — design (2026-10-11)

Status: implementation candidate, for an independent gate. It does not authorize a merge, DDL, a
flag change, or any staging or production step.

## 1. Source and scope

- Owner ruling of 2026-10-09 (item 3): G2-core ships as a standalone small PR after M4 (M4 is fully
  merged on main) and before FE-e. The status filter is **orthogonal** to the role views, and the
  list and its total **share the same condition**. Sorting and field visibility are **not** in
  scope; they are listed separately.
- Lock `task-feature-design-lock-20260917.md` §2 item 1 (four role views + 已完成 + 全部; 默认未完成可切).
- In scope: `GET /api/tasks?status=open|done|all` (backend), the 未完成 / 已完成 / 全部 switch on the
  /tasks list page (frontend), tests, and lane registration.
- Out of scope: sorting, field visibility, `/api/tasks/pending` and `/pending-count` (unchanged),
  the list page `/task-lists/:id`, any new index or migration.

## 2. What "status" means

The filter reads the task's own `tasks.status` column (`open` | `done`, constraint
`tasks_status_chk`). It does **not** read the viewer's assignee row. An all-mode task that the
viewer has completed while another assignee has not is still `open`, so it is listed under
未完成 and not under 已完成. This matches lock §12 gate 4 (visible is not pending): the task stays
in the assigned view, and stays out of `/pending`.

## 3. Backend contract

| Request | Answer |
|---|---|
| `status` absent | rows of the view, no status filter (same as before G2-core) |
| `status=all` | same as absent, byte for byte (same SQL, same items, same total) |
| `status=open` / `status=done` | rows of the view ∩ `tasks.status = <value>`; `total` = size of that set |
| any other value (unknown, empty, other case, padded) | 200 `{ items: [], degraded: true, reason: 'predicate_error' }` — the same answer as an unknown `view` |
| `status` repeated or nested (not a single string) | same as an unknown value (it is **not** defaulted, unlike `view`, so two values never yield every row) |
| invalid page and invalid status together | 422 `INVALID_LIMIT` / `INVALID_OFFSET` (page is parsed first, as for view) |
| no org on the token | `org_missing` degraded body, before anything else (unchanged) |

Implementation:

- `services/task-records.ts`: `TASK_STATUS_FILTERS = ['open', 'done', 'all']`. The private
  `taskViewCondition` (used by both `listTasks` and `countTasks`) appends the status clause after the
  view condition. The clause is a literal taken from the closed set after validation, so the bind
  slots stay `$1`/`$2` and the page binds keep their numbers. An invalid value throws
  `422 INVALID_STATUS` before any statement.
- `buildTaskScopeCondition` and `buildTaskPendingCondition` (`tasks/task-access.ts`) are **not**
  changed. The scope builder is the org single-emission point, and `/pending` derives from it.
- `routes/tasks.ts`: reads `status` and passes the same value to `listTasks` and `countTasks`;
  `INVALID_STATUS` joins `INVALID_VIEW` on the existing `predicate_error` branch.
- The existing partial index `idx_tsk_org_status (org_id, status) WHERE deleted_at IS NULL` serves
  the clause. **No DDL, no migration.**

## 4. Frontend

- `tasks/tasksApi.ts`: `listTasks(view, page?, status?)`. With a status, `&status=<value>` follows the
  view and precedes the page. Without one, the request string is unchanged.
- `views/tasks/TasksView.vue`: a second switcher (`nav`, `aria-label` 任务状态 / Task status) with
  three buttons 未完成 / 已完成 / 全部 (`aria-pressed`, the current one disabled, test ids
  `tasks-status-switch-open|done|all`). The default is `open`. Every list read (`loadList`,
  `reloadListQuietly`) sends the current status. `all` is sent explicitly, so the page never depends
  on the server default. A status switch bumps the same page token as a view switch, and the
  existing generation guard drops a late answer.
- `tasks/tasksStatusFilter.ts`: remembers the choice per browser under
  `metasheet.tasks.statusFilter`. Reads and writes are each in their own try/catch, the storage
  accessor itself is guarded, and a stored value outside the closed set reads as `open`.
- `tasks/labels.ts`: `statusFilterLabel`, `statusFilterOpen` (未完成 / Not completed),
  `statusFilterDone` (已完成 / Completed), `statusFilterAll` (全部 / All).

### 4.1 The assigned view's grouping board under a status filter (visible consequence)

The assigned view renders its rows through the personal grouping board (M4 FE-7). The board joins
the rows from `GET /api/tasks` with the placements from `GET /api/task-groups/items`. The placements
read is **not** filtered by status: its visible set is the assigned view, open and done, and a move's
`position` counts that set (M4 PR-3a design §3.5). The board's existing rule (`[fe-35]`,
`tasks/tasksGroupBoard.ts`) offers moves only while every placement names a shown row. Otherwise it
shows the order without the missing tasks, disables every move control, and shows the notice
「部分任务未显示，排序已停用」.

The consequence under the default 未完成: once a task placed in a personal group is completed, it is
no longer a row. The board then holds every move off, with the notice, for as long as any completed
task stays placed. 全部 shows the completed tasks again, and moves come back in the server's index
space. Groups can still be created, renamed and deleted. No request goes out in the wrong index
space, so no placement is written wrong. `tasks-groups.spec.ts` pins three cells:
- moves are off under 未完成 with a placed completed task, and a forced control sends nothing;
- 全部 restores moves, and the PUT counts the completed task;
- with no completed task placed, moves stay on under 未完成.

G2-core does not change the board rules. That would be FE-7 scope and outside the owner's G2-core
ruling. The choice is listed as Q-G2-2.

## 5. Owner question (not ruled)

**Q-G2-1: the server default when `status` is absent.** Implemented: `all`. This keeps the row sets
of ratified gate 19 and gate 4 (and every existing caller and test) unchanged, and the page sends
`open` itself. The alternative is `open` on the server, which makes every caller that omits the
parameter (including any external client) see only unfinished tasks. That would change the
gate 19 and gate 4 row sets, and would need those gates re-cut. Changing the default later is a
one-line change in `taskStatusClause` plus the cells that pin `absent = all`.

**Q-G2-2: reordering on the assigned view's board under 未完成 (§4.1).** Implemented: the existing
board rule holds moves off while a completed task is placed, and 全部 restores them. This is
data-safe but visible: a user of personal groups loses reordering under the default as soon as they
complete a placed task. Alternatives, each outside G2-core's scope as ruled:
- (a) a follow-up FE slice: the board keeps the server's index space by counting placements of tasks
  hidden by the status filter, while still not showing them;
- (b) the placements read takes the same status filter, and the move position counts only that set.
  This changes the PR-3a contract;
- (c) the assigned view's board reads its rows with `all` whatever the switch says. The filter would
  then not apply to the grouped rows.

The server default in Q-G2-1 does not affect this, because the page always sends its status.

Recorded assumption (not an owner question unless the owner wants it to be): a repeated `status`
is answered as invalid rather than defaulted. `view` defaults a non-string to `assigned`; doing the
same for `status` would turn `?status=open&status=done` into every row.

## 6. Test cells

Backend unit (`tests/unit/task-status-filter.test.ts`, `src/db/pg` mocked):
- per view × {open, done}: list and count WHERE text = view condition + the same status clause;
  binds `$1`/`$2`, page at `$3`/`$4`;
- per view: absent and `all` emit the pre-G2 text;
- invalid values (including injection-shaped text): `INVALID_STATUS` from both reads, zero statements;
- route: list and total read with the same clause; absent = `all`; unknown, empty, upper-case,
  repeated and nested `status` answer the same body as an unknown view, with zero statements; a bad
  page beats a bad status; `/pending` ignores `status`.

Backend real DB (`tests/integration/task-g2-status-filter.db.test.ts`, lane `tasks-realdb`):
- fixture: one org, two actors. For each status, one task per relation of the viewer (assignee
  only, follower only, creator without assignee, creator with another assignee) plus one with no
  relation. Done rows are reached through `completeTask`. One extra all-mode task is completed by
  the viewer only (stays `open`). Every view has at least one open and one done row.
- per view × {open, done}: HTTP rows = `taskMatchesView` rows ∩ status, and the same set as the
  unfiltered view rows intersected with status; `total` = set size, unpaged and with `limit=1`;
  `countTasks` agrees;
- per view: absent = `all` = the pre-G2 answer, and its size = open + done;
- the self-completed all-mode task is under open, not done, and not in `/pending`; `/pending` is
  unchanged;
- invalid status answers like an invalid view; a bad page beats a bad status;
- another actor's done list is that actor's rows only;
- negative controls (`runSourceMutant`, backup, restore and byte-compare): nc1 delete the clause;
  nc2 count without status (list right, total red); nc3 route total without status; nc4 route list
  without status. Each child exits 0 only when the mutant makes the positive cell's assertion fail.

Test names start with `g2core|` and never with the gate-19 prefix, so the gate 19 extractor is
unaffected.

Frontend (`apps/web/tests/tasks-status-filter.spec.ts`): default `open` and pressed state; labels;
switch to done / all with `all` sent explicitly; view and status orthogonal; pressing the current
one is a no-op; a late answer for the previous status cannot paint; a reload after complete keeps
the status; persistence across a remount; stored `open`/`done`/`all` honoured; stored garbage reads
as `open`; `getItem` throws; `setItem` throws; the `localStorage` accessor throws. Changed:
`tasks-list-view.spec.ts` and `tasks-groups.spec.ts` (the list read now carries `status=open`), and
`tasks-api-m4.spec.ts` (the request string with a status). `tasks-groups.spec.ts` also gains the
three board cells of §4.1. Their fake backend filters rows by `status` as the server does, and passes
the status to the reply as a second argument; the existing cells keep the fake that ignores it.

## 7. Registration

- `packages/core-backend/vitest.config.ts` exclude list and `.github/workflows/tasks-realdb.yml` lane
  list gain the new real-DB file. `task-ci-coverage-enumeration.test.ts` checks that disk, exclude
  list and lane list are the same set.
- `apps/web/scripts/run-required-web-tests.sh` gains the new spec. The `.tokens` file is
  regenerated with `node scripts/ops/required-web-lane-token-manifest.mjs --write`.
  `.github/workflows/tasks-web-guard.yml` lists it as the twenty-fifth whole-file argument.
- The PR-3c touchpoint census (`task-counts-touchpoints.test.ts`) scans writes of pending inputs. This
  change only reads `tasks.status`, and the census stays green.

## 8. Earlier records not edited

- The route table in `task-m4-pr3a-backend-design-20260930.md` lists `view` `limit` `offset` for
  `GET /api/tasks`. That table is the M4 record; this design adds `status`, and the older record is
  not rewritten.
- Lock §12 gate 4 and gate 19 call `GET /api/tasks?view=…` without `status`. With the server default
  `all` (Q-G2-1), their row sets are unchanged. If the owner picks `open`, those gates need re-cutting
  as part of that ruling.

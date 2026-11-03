# Task line G2-core: status filter on the task list — design (2026-10-11)

Status: implementation candidate, for an independent gate. It does not authorize a merge, DDL, a
flag change, or any staging or production step.

## 1. Source and scope

- Owner ruling of 2026-10-09: G2-core ships as a standalone small PR after M4 (M4 is fully
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
  view condition. After the closed-set check, the clause is picked from a fixed map
  (`open` → ` AND tasks.status = 'open'`, `done` → ` AND tasks.status = 'done'`, `all` → nothing), so
  no request text is rendered into the SQL, the bind slots stay `$1`/`$2`, and the page binds keep
  their numbers. An invalid value throws `422 INVALID_STATUS` before any statement.
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
  three buttons 未完成 / 已完成 / 全部 (test ids `tasks-status-switch-open|done|all`). Only
  `aria-pressed` marks the current one. It is **not** disabled, so keyboard focus stays on it after
  activation and screen-reader focus mode can reach it; pressing it again is a no-op in
  `switchStatus`. (The view switcher above still disables its current button, as since M2; aligning
  it is a named follow-up, §9.) The default is `open`. Every list read (`loadList`,
  `reloadListQuietly`) sends the current status. `all` is sent explicitly, so the page never depends
  on the server default. A status switch bumps the same page token as a view switch, and the
  existing generation guard drops a late answer.
- `tasks/tasksStatusFilter.ts`: remembers the choice per browser under
  `metasheet.tasks.statusFilter`. Reads and writes are each in their own try/catch, the storage
  accessor itself is guarded, and a stored value outside the closed set reads as `open`.
- `tasks/labels.ts`: `statusFilterLabel`, `statusFilterOpen` (未完成 / Not completed),
  `statusFilterDone` (已完成 / Completed), `statusFilterAll` (全部 / All); the empty line names the
  filter it was read under (`listEmptyOpen` 暂无未完成任务 / No incomplete tasks, `listEmptyDone`
  暂无已完成任务 / No completed tasks, and the existing `listEmpty` under 全部); the board's status line
  `groupsHiddenByFilter`. The row label stays 进行中 / In progress: 未完成 is the lock's wording for
  the filter, and the row label is unchanged since M2.

### 4.1 The assigned view's grouping board under a status filter

The assigned view renders its rows through the personal grouping board (M4 FE-7). The board joins
the rows from `GET /api/tasks` with the placements from `GET /api/task-groups/items`. The placements
read is **not** filtered by status: its visible set is the assigned view, open and done, numbered
densely, and a move's `position` counts that set (M4 PR-3a design §3.5). The board's existing rule
(`[fe-35]` in `views/tasks/TaskGroupBoard.vue`, over the `consistent` flag from
`tasks/tasksGroupBoard.ts`) offers moves only while every placement names a shown row and a known
group.

Left alone, that rule would make the default 未完成 hold every move off, on every group, as soon as
one placed task is completed, and for as long as it stays placed (and 已完成 the same for any placed
open task). The first gate round confirmed this as a defect. The fix is frontend only. It changes
no API, no DDL and no lock text:

- TasksView passes `rowsFiltered` (the switch is not 全部) through `TaskPersonalGroups` to the board.
- With `rowsFiltered`, `buildBoardModel` keeps a placement whose task is not a row in its group's
  order as a **hidden entry** (`hidden`) and does not clear `consistent`. The placements read is the
  server's whole visible set, so the order with the hidden entries in it is the server's index
  space. A placement in an unknown group still clears `consistent`.
- The board renders each group's order without the hidden entries. Up and down are disabled by the
  shown index. A step passes over hidden entries to the next shown row, and its `position` is that
  row's index in the full order: up lands before it, down after it. Join, move to a group and drop
  already count full orders. The live region names the shown place.
- A status line names the count:「另有 N 项已分组任务不在当前状态筛选中，未显示」/ "N grouped tasks are
  outside the status filter and not shown".
- Without a filter (全部), and in the list page's board, nothing changes: a placement whose task is
  not a row still holds moves off. The same holds when the row read itself stopped short of its
  `total`. A row cut off by the page cannot be told from one the filter left out, so TasksView then
  does not pass `rowsFiltered`.

`tasks-groups.spec.ts` pins this:
- the hidden-entry rules: order, `consistent`, steps, joins, drops and `applyMove`;
- under 未完成, moves stay on and the status line shows;
- a step up or down past the hidden task, a move from another group, and a drag each send the
  position that counts it;
- the in-flight order renders no row for the hidden task;
- under 已完成, the mirror case;
- 全部 has no hidden entries;
- under 全部, a placement whose task is not a row still holds moves off;
- a row read cut short under 未完成 still holds moves off.

## 5. Owner question (not ruled)

**Q-G2-1: the server default when `status` is absent.** Implemented: `all`. This keeps the row sets
of ratified gate 19 and gate 4 (and every existing caller and test) unchanged, and the page sends
`open` itself. The alternative is `open` on the server, which makes every caller that omits the
parameter (including any external client) see only unfinished tasks. That would change the
gate 19 and gate 4 row sets, and would need those gates re-cut. Changing the default later is a
one-line change in `taskStatusClause` plus the cells that pin `absent = all`.

**Q-G2-2: reordering on the assigned view's board under a status filter (§4.1).** Implemented (a)
after the first gate round. This is the implementer's choice of the least contract-changing fix, not
an owner ruling. The board keeps the server's index space by counting placements of tasks the filter
hides, while not showing them. It is frontend only, with no API, DDL or lock change. Under the
filter, a move then lands relative to tasks the user cannot see: a step up past a hidden completed
task puts the moved task before it in the server's order. The other options stay open for the
owner:
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

Frontend (`apps/web/tests/tasks-status-filter.spec.ts`): default `open` and pressed state, with no
option disabled; labels; switch to done / all with `all` sent explicitly; view and status
orthogonal; pressing the current (enabled) option is a no-op and keeps focus on it; a late answer
for the previous status cannot paint; a reload after complete keeps the status; persistence across
a remount; stored `open`/`done`/`all` honoured; stored garbage reads as `open`; `getItem` throws;
`setItem` throws; the `localStorage` accessor throws. The status analogues of the view switch's five
page-token cells: a pending complete, reopen or create settling after a status switch shows no
banner or guidance and causes no extra reload, while the badge bus is still notified and the title
still cleared. The empty line per status. Changed: `tasks-list-view.spec.ts` and
`tasks-groups.spec.ts` (the list read now carries `status=open`), `tasks-api-m4.spec.ts` (the request
string with a status), and `tasks-labels.spec.ts` (the empty line under the default 未完成, and the
new format function). `tasks-groups.spec.ts` also gains the hidden-entry rule cells and the board
cells of §4.1. Their fake backend filters rows by `status` as the server does, and passes the status
to the reply as a second argument; the existing cells keep the fake that ignores it.

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

## 9. Follow-ups (not in this change)

- The view switcher disables its current button (since M2), unlike the status switch. Aligning it
  is a follow-up, so that the M2 cells that pin `disabled` change in their own slice.
- Both switchers are `nav` landmarks, and the remembered status is per browser, not per user or
  org. This is noted and left as is, consistent with the page's other per-browser conveniences.
- `?status[a]=open` is refused only because Express 4 parses nested queries (the `nested` unit cell
  is the tripwire). A move to Express 5 must keep the extended query parser or refuse unknown
  `status*` keys.

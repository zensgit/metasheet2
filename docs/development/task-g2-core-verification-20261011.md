# Task line G2-core: status filter — verification (2026-10-11)

Design: `task-g2-core-design-20261011.md`. Code head under test: `a44b168260` (branch
`claude/tasks-g2-core`, based on main `906840c74c`). This note is added in a later commit on top of
that head. The same commit also adds the three board cells to `tasks-groups.spec.ts`, a comment in
`tasks-web-guard.yml`, and the design's §4.1 and Q-G2-2. Those are test and docs changes only, so the
real-DB runs below still apply. Every row below says RAN or NOT RUN. Nothing was pushed to GitHub, and no PR was
opened. No DDL, no flag, and no staging or production step.

Machines: "local" is the development laptop, with node_modules linked from the main clone.
"Other machine" is a second development machine running PostgreSQL 16.15, used through the
task-line lane helper (fresh database, CI migration excludes, every file in `tasks-realdb.yml`, then
the tasks auth gate).

## 1. Local (RAN)

| Check | Result |
|---|---|
| `tsc --noEmit -p tsconfig.json` (core-backend) | RAN — exit 0 |
| `vue-tsc --noEmit -p tsconfig.app.json` (web) | RAN — exit 0 |
| Backend unit `tests/unit/task*`, `tests/unit/tasks*` and the supertest tripwire | RAN — 40 files, 1618 passed, 0 failed (new `task-status-filter.test.ts`: 37 passed) |
| Backend unit, full default config (`vitest run`) | RAN — 1308 files: 1132 passed, 4 failed, 172 skipped. Tests: 20415 passed, 43 failed, 1742 skipped. The 4 failing files are `multitable-recovery-*`. The same 4 files fail the same 43 tests on main `906840c74c` on the other machine (43 failed / 48 passed on both trees), so they are not from this change |
| Source-scanning guards (touchpoint census, coverage enumeration, auth CI wiring, gate-19 identities, route/closure scanners) | RAN — all passed, as part of the two rows above |
| Web specs `tests/App.spec.ts` + `tests/tasks-*.spec.ts` | RAN — 25 files, 1965 passed, 0 failed (new `tasks-status-filter.spec.ts`: 20 passed; `tasks-groups.spec.ts`: 177 passed, including the 3 G2-core board cells) |
| Board under the filter (design §4.1) | RAN — under 未完成 a placed completed task holds moves off with the notice and a forced control sends nothing; 全部 restores moves and the PUT counts the completed task (`{"groupId":null,"position":1}`); with no completed task placed, moves stay on |
| Required web token manifest `--check` | RAN — matches (587 tokens). Token-set diff from main: one token added, `tasks-status-filter.spec.ts` |

## 2. Other machine, real DB (RAN)

| Run | Lane (`tasks-realdb.yml` files) | Auth gate |
|---|---|---|
| Branch run 1 (`57b5347861`; differs from the head only in test names) | 22 files: 843 passed, 1 failed (844) | 86 passed (86) |
| Main control (`906840c74c`) | 21 files: 815 passed, 1 failed (816) | 85 passed, 1 failed (86) |
| Branch run 2 (head `a44b168260`) | 22 files: 843 passed, 1 failed (844) | 86 passed (86) |

The new file `task-g2-status-filter.db.test.ts` passed all 28 cells in both branch runs.

Each lane failure is a different cell outside this change, and each passes when its file is run
alone:

- Branch run 1: `task-m4-lists` gate 13, the unregistered sibling path answered 405 instead of 404.
  Rerun of that file alone: 66/66 on the branch and 66/66 on main.
- Main control: `task-m4-paging-settings` gate 13 negative control, child exited 1 after 94 s
  without printing. Auth gate: one cell hit the 30 s test timeout
  (`POST /api/task-lists/:id/groups`).
- Branch run 2: `task-m4-scheduler` leader-session timing cell (`expected 4145 to be greater than
  5000`). Rerun of `task-m4-scheduler` + `task-m4-paging-settings` alone: 102/102 on the branch and
  102/102 on main.

These failures are timing and loopback flakes of this machine under the full serial lane. Main shows
the same kind of failure. CI (`tasks-realdb` on a hosted runner) has not run this branch:
**NOT RUN**.

## 3. Real-DB cells (RAN, other machine, both branch runs)

- Fixture: 11 rows reached their intended status, with done rows reached through `completeTask`. The
  all-mode task only the viewer completed is still `open`. Each of the five views has at least one
  open row and one done row.
- `g2core|<view>|<status>` × 10: HTTP rows = `taskMatchesView` rows ∩ status. They also equal the
  unfiltered view rows ∩ status. `total` = set size, both unpaged and with `limit=1`.
  `countTasks` agrees, and every listed row has that status.
- `g2core|<view>|all` × 5: absent and `all` give identical bodies, the pre-G2 rows, and size =
  open + done.
- Self-completed all-mode task: listed under open, not under done, and not in `/pending`.
  `/pending` = the one open assignee row, and `countPendingList` = 1.
- Invalid status (unknown, empty, `OPEN`, repeated): same status and body as an unknown view. A bad
  page together with a bad status gives 422 `INVALID_LIMIT`.
- Another actor's done list: that actor's rows only.

## 4. Negative controls

In-file source mutants (`runSourceMutant`: backup, rewrite, child run, restore, byte-compare). They
RAN on the other machine in both branch runs. Each child prints its probe and exits 0 only when the
mutant makes the positive assertion fail.

| Id | Mutant | Child output (branch run 2) |
|---|---|---|
| nc1 | delete the status clause in `taskStatusClause` | `{"nc1":"red","listRed":true,"totalRed":true}` |
| nc2 | `countTasks` ignores the status (list keeps it) | `{"nc2":"red","listOk":true,"totalRed":true,"total":9}` |
| nc3 | the route passes the status to the list only | `{"nc3":"red","status":200,"listOk":true,"totalRed":true,"total":9}` |
| nc4 | the route passes no status to the list | `{"nc4":"red","status":200,"listRed":true}` |

Manual mutants against the positive real-DB cells. These RAN on the other machine on head
`a44b168260`, filtered to the 15 positive list/total cells. Each mutant was restored and the tree
checked clean after its run.

| Mutant | Result |
|---|---|
| none (control) | 15 passed |
| MA delete the clause | 10 failed, 5 passed (the 10 open/done cells; the 5 `all` cells have no clause) |
| MB count without status | 10 failed, 5 passed |
| MC route total without status | 10 failed, 5 passed |
| MD route list without status | 10 failed, 5 passed |

Backend unit mutants, RAN locally against `task-status-filter.test.ts` (37 cells), each restored and
byte-compared:

| Mutant | Failed / 37 |
|---|---|
| BU1 delete the clause | 12 |
| BU2 count without status | 21 |
| BU3 route total without status | 2 |
| BU4 `INVALID_STATUS` not on the predicate_error branch | 5 |
| BU5 repeated status defaulted instead of refused | 2 |
| BU6 no closed-set validation | 14 |

Frontend mutants, RAN locally against `tasks-status-filter` + `tasks-list-view` + `tasks-groups`
(229 cells, board cells included), each restored and byte-compared:

| Mutant | Failed / 229 |
|---|---|
| FM1 default `all` instead of `open` | 30 |
| FM2 the switch is not persisted | 2 |
| FM3 `getItem` not guarded | 1 |
| FM4 a stored value not checked against the closed set | 6 |
| FM5 `loadList` drops the status | 36 |
| FM6 `setItem` not guarded | 1 |
| FM7 the board's missing-row rule removed (existing `[fe-35]` guard) | 4 |

## 5. Not run / open

- GitHub CI on this branch: NOT RUN (not pushed, by instruction).
- Gate 19 extractor diff: NOT RUN as a separate step. The new test names start with `g2core|`, and
  neither new file contains the gate-19 prefix.
- Browser check of the switch on a running app: NOT RUN. The spec mounts the real `TasksView` with
  the API mocked.
- Owner question Q-G2-1 (server default for an absent status): open. See the design §5.
- Owner question Q-G2-2 (reordering on the assigned view's board under 未完成 while a completed task
  is placed): open. See the design §4.1 and §5.

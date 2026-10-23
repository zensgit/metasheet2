# Local Meta 6472 dependency merge — 2026-10-24

Private candidate `codex/plm-meta-integrated-window-20261024` in `/Users/chouhua/.codex/worktrees/plm-w23-meta-readonly-20261023/metasheet2`. One local `--no-ff` merge of open Draft #6472 head `a7710a4a71c4caa0fe47794963d3cf48660915a7` into ECO head `1da1786ba297f34999434dd7dd873a457f568cf7`. Merge-base `ed7b2945542346f52a1fc25b265b3f064b657aba`. `a7710a4` is not an ancestor of `1da1786`. This file is part of that merge commit. First parent is `1da1786ba297f34999434dd7dd873a457f568cf7`. Second parent is `a7710a4a71c4caa0fe47794963d3cf48660915a7`. Original branch `codex/plm-w23-snapshot-db-20261024` stays at `1da1786`. No push, pull-request update, GitHub merge, rebase, reset, or new worktree.

## Outside parent commits

Author and committer for all six are `zensgit <77236085+zensgit@users.noreply.github.com>`. Bodies are empty. Trailers are empty. Disposition is retain: source, assertions, and the historical HOLD documents and the 141-line artifact stay at the parent bytes.

| SHA | Author / committer time | Subject | Disposition |
| --- | --- | --- | --- |
| `1cee59fd63721c90ac2fd6cf480441d2798333bc` | 2026-10-21T03:11:16+08:00 / same | test(plm): prove personal listener owner transfer across processes | retain exact parent bytes |
| `bf1e708020fab48a8d2dbf4645c9942d4603fc17` | 2026-10-21T03:13:55+08:00 / 2026-10-21T03:14:09+08:00 | docs(plm): record owner transfer PostgreSQL verification | retain immutable HOLD doc and 141-line artifact |
| `ae6efd908848e60e836adea6524af20f09789297` | 2026-10-21T16:21:00+08:00 / same | ci(plm): align exact managed test counts with Visual cases | retain membership; unit integer reconciled below |
| `c88ca7caecec2103d58d2453a316bc500eabced9` | 2026-10-21T16:22:13+08:00 / same | docs(plm): record exact CI count repair and retained gates | retain immutable HOLD doc |
| `1c94a7ca501ab3334e1c23962950c90c6bc4d4bc` | 2026-10-21T16:42:59+08:00 / same | test(plm): pin unmanaged preview source arguments | retain the three `undefined` source-argument assertions |
| `a7710a4a71c4caa0fe47794963d3cf48660915a7` | 2026-10-21T16:43:57+08:00 / same | docs(plm): record Visual assertion repair evidence | retain immutable HOLD doc |

Trees, in the same order: `bed99b0994e683c1eae23f914dcb36a5a3e31239`, `717554ec0a9b7eaaa8fa310d6c971cf4130734e1`, `20d27cae7d17013188f6e639dc1203d11cfa0f37`, `4927ab30683ec109ee0ecb09b7c9a7d2a13ab456`, `9db9547bfd0e90cac4c36513619b4c55928d0d81`, `2dfd82ea389e311d9107fd3f72d524f4c00b36d8`.

## Conflict and counts

`git merge --no-ff --no-commit a7710a4a71c4caa0fe47794963d3cf48660915a7` auto-merged. The only path both sides changed is `.github/workflows/plm-managed-companion-consumer.yml`. There were no conflict markers.

Parent `ae6efd9` set the unit assert-report integer to 194 and the Discussion integer to 61. Those integers were true for the parent file set at `bf1e708` (consumer job `https://github.com/zensgit/metasheet2/actions/runs/39567543417/job/119113363234` passed 194, then the checker still required 175). They are not copied blindly onto this ECO head.

The ten-file unit cohort is the same list on `ed7b294`, `1da1786`, and `a7710a4`. Eight files are byte-identical across those three commits. `plm-managed-companion.test.ts` is identical on `ed7b294` and `a7710a4` and differs on `1da1786` by three new plain `it()` cases: continuity hint, Meta link revision, and inconsistent persisted continuity. Its six `it.each` argument lists are unchanged. `plm-managed-projection-envelope.test.ts` keeps 8 plain `it()` and 4 `it.each` calls, and those `it.each` arguments are byte-identical; the ECO diff only changes mock query behavior. `assert-report.mjs` requires `numPassedTests` and `numTotalTests` to equal the integer. The merged unit integer is therefore 194 + 3 = 197. The ten-file cohort was not rerun.

The five Discussion specs are byte-identical on `ed7b294`, `1da1786`, and `a7710a4`. The parent proof of 61 carries. They were not rerun. PostgreSQL stays 52 and was not rerun. The W10 web step stays the `1da1786` seventeen-file list, including `plmContinuousScheduling.spec.ts` and `plmContinuousExpiry.spec.ts`, and stays 222. It was not rerun. Membership, the strict checker, zero/skip rejection, Node 20, pnpm 10.16.1, PostgreSQL 16, timeout 30, and `cancel-in-progress: false` stay.

`apps/web/tests/plm-embed-visual-preview.spec.ts` is the exact `a7710a4` bytes, including the three trailing `undefined` managed-source arguments. `PlmEmbedVisualPreviewPanel.vue` blob `968505506e643af918d145f0acc1028544efd66f` and `apps/web/src/services/integration/plmEmbedVisualPreview.ts` blob `95f067e7ab714fc3610b05bfc2ebe683782573ae` are identical from `ed7b294` to `1da1786`. The parent focused run of that spec was 12 passed. A local rerun was not performed: `apps/web/node_modules` is absent in this sparse worktree, and install is forbidden. That is `NOT_RUN`, not a local requalification.

Owner-transfer `plm-personal-change-read-pg.realdb.ts` and `change-read-enroll-worker.ts` are exact parent bytes. The 2026-10-21 PostgreSQL artifact is 141 lines. Those passed PostgreSQL cases were not rerun.

## DB pins outside this merge

These six content SHA256 values stay the `1da1786` bytes. None of these paths is in the merge diff.

| Path | SHA256 |
| --- | --- |
| `packages/core-backend/src/db/migrations/zzzz20261024010000_create_plm_collaboration_snapshots.ts` | `dd55d2364baca595deaf3692ca99d75df9fb68a3f561a4083c4d197c5bacf3a4` |
| `packages/core-backend/tests/integration/plm-collaboration-snapshot-db-guards.realdb.test.ts` | `6fd0f3dbf0b0c14fada9bd9f7b3537d474c0dc06b62a318ac0751a773f5c682b` |
| `packages/core-backend/vitest.plm-collaboration-snapshot.config.ts` | `7d3523917852fb99fa069a6b47fe057c07b5b480a927dbc758cec4c1d41cbdc2` |
| `packages/core-backend/tests/plm-collaboration-snapshot/bootstrap.ts` | `a1cb4bb9d5017a63189f2bfbf157e7196dada4b56a91b23347ffe5cd6b0a7cf9` |
| `.github/workflows/plm-bom-listener.yml` | `73e9c26f274926ac1ae580941d635fa414e7ce5f602181e2bf9c3188603a282f` |
| `packages/core-backend/vitest.config.ts` | `7ca3bbdc14657543e5d54f04c26180eeb8d453c2d07d38fae566065c241dbbdb` |

## Not run

No new JUnit. No PostgreSQL, Docker, install, full typecheck, ten-file unit cohort, Discussion blanket, or W10 web 222 blanket. Disk floor `4563402752` was checked with `statvfs` on this worktree before any Node test was considered (`shutil.disk_usage` free `15038078976`). No Node test process was started. Root owns the standalone integration closeout. This document does not claim remote CI on the merge commit, a local Visual requalification, or publication acceptance.

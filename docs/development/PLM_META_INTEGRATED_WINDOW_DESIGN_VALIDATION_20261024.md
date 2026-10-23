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

The five Discussion specs are byte-identical on `ed7b294`, `1da1786`, and `a7710a4`. The parent proof of 61 carries. They were not rerun. Merge commit `ecc1f30a60c942c8cf0295a0f112e433b05ff912` still had PostgreSQL assert-report integer 52; that suite was not rerun for the merge. The W10 web step stays the `1da1786` seventeen-file list, including `plmContinuousScheduling.spec.ts` and `plmContinuousExpiry.spec.ts`, and stays 222. It was not rerun. Membership, the strict checker, zero/skip rejection, Node 20, pnpm 10.16.1, PostgreSQL 16, timeout 30, and `cancel-in-progress: false` stay. The later PostgreSQL integer repair is recorded below.

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

## PostgreSQL integer repair

On the same candidate, after `ecc1f30a60c942c8cf0295a0f112e433b05ff912`, the managed consumer workflow changes one integer: the PostgreSQL `assert-report.mjs` expectation moves from 52 to 133. Unit 197, Discussion 61, and web 222 stay. The test file list, `vitest.plm-managed-companion.config.ts`, the checker, environment, service, timeouts, Node, pnpm, and filters stay. This edit is not a new PostgreSQL run and not a remote CI result. The 2026-10-21 HOLD documents stay unchanged. Root owns commit and publication.

The config include list is the same four files on source `e5e7a0bc112d18662514831520f2f59469e06a51`, closed evidence `18acca1ec49920592644dbfb1eb994b12eac141f`, and `ecc1f30`. Their content SHA256 values match on all three:

| Path | SHA256 |
| --- | --- |
| `packages/core-backend/vitest.plm-managed-companion.config.ts` | `0e2083809d7fee21b8f583bc49df9df506c5e1ad006b87ad29bdf4ca1de87258` |
| `packages/core-backend/tests/integration/plm-managed-companion-pg.realdb.ts` | `d91d400be67dc7826304f1053f973bbc7aaaed3804b5c9508b4360916075cb73` |
| `packages/core-backend/tests/integration/plm-managed-continuous-completion-pg.realdb.ts` | `75248518f18bfa2b175bec569de058e138aac7b9b26edee6f6179937e36dee50` |
| `packages/core-backend/tests/integration/plm-managed-renewal-recovery-pg.realdb.ts` | `2e776596d430d16b5f56fef3e4b91104cf60518792f5ca92fe3761f205bf112d` |
| `packages/core-backend/tests/integration/plm-managed-embed-pg.realdb.ts` | `b6e597e2a262b804647787018e38cc4d098116de2a2d55feeb32bb9eee86c151` |

The immutable packet `w10-meta-c2b-root-green-20261023` records that historical run. Log SHA256 `317fa5f59680aefcf8c9ee699e14bd22bebad3dd4b50ee56a82a9cf6e2a1eab4` shows 4 files and 133 passed: companion 80, continuous completion 10, renewal recovery 29, embed 14. Results SHA256 `1de96425a6659935f074abe3c4ea74cebd2d5da207d8b162337c68febd2d2eac` records PostgreSQL exit 0 and the same config and embed hashes. Those bytes were not executed again for this integer change.

## Source input type repair

Root ran backend `tsc --noEmit` on `ecc1f30a60c942c8cf0295a0f112e433b05ff912` and it exited 2. The packet `meta-integrated-root-tsc-first-red-20261024` has manifest SHA256 `63cb4593d459f9e63216e94203d399428fb68eed10f24553c78b9abcf86b5258`. Log SHA256 `b0519d65cdfe29a794772af615a13cafca738596cf1aac05618503bae4a4872b` is one diagnostic:

`src/multitable/plm-collaboration-snapshot-wire.ts(187,3): error TS2322: Type '{ itemId?: string; ecoId?: string; currentVersionId?: string; }' is not assignable to type 'EcoCollaborationSourceInput'.`

That run recorded 1547 source pins, `source_stable` true, and wire content SHA256 `4f40028b44d1d675dd87cd85ea79e04e320ae5db74582c0eef22b0c4a792a559`, the same bytes as HEAD before this edit. The packet has no recovery typecheck. PostgreSQL 133 was not rerun.

`parseEcoCollaborationSourceInput` still calls the existing `inputSchema.safeParse` and still rejects failure with 422 `ECO_SOURCE_INPUT_INVALID`. The success path now returns an explicit object whose fields are `parsed.data.itemId`, `parsed.data.ecoId`, and `parsed.data.currentVersionId`. The interface, schema, tsconfig, and strictness are unchanged. This cut did not run `tsc`. Root still has to rerun the failed backend typecheck and run the first recovery typecheck.

## Not run

The merge closeout produced no new JUnit and did not run PostgreSQL, Docker, install, a full typecheck, the ten-file unit cohort, the Discussion blanket, or the W10 web 222 blanket. Disk floor `4563402752` was checked with `statvfs` before any Node test was considered. The later root backend typecheck is the RED above. This repair cut did not rerun that command, did not run recovery typecheck, and did not rerun PostgreSQL 133. Root owns verification, commit, and publication.


## Root verification after the two finite repairs

The current four-file PostgreSQL suite and its config are byte-identical to both source `e5e7a0bc112d18662514831520f2f59469e06a51` and closeout `18acca1ec49920592644dbfb1eb994b12eac141f`. Its immutable earlier run passed 80 + 10 + 29 + 14 = 133 tests in four files. The integrated workflow had retained the old single-file expectation 52; only that strict integer became 133. Expectations 197 (unit), 61 (Discussion), 133 (PostgreSQL), and 222 (web) now describe the current exact membership. These are source admissions; the old passing suites were not rerun and this is not current-head CI success.

Root ran the full backend `tsc --noEmit` and observed exit 2 / TS2322 at the ECO input parser's `return parsed.data`. The existing Zod validation and required interface remain intact; the repair returns exactly the three validated required fields. The same failed backend typecheck then returned 0, and the configured recovery archive typecheck ran for the first time and returned 0. All 1547 measured input files remained stable during those checks. Local runtime was Node 24.14.1 / TypeScript 5.8.3; CI's runtime remains a separate gate.

The red packet manifest is `63cb4593d459f9e63216e94203d399428fb68eed10f24553c78b9abcf86b5258`. The green packet manifest is `b34c6e6840a0cea20ebb283ddc56385c8cb0f616fde667ef6e5cfd478e8a4f93` at `private-acceptance-evidence-20261020/meta-integrated-root-tsc-green-20261024`. Root verified no open files and removed only each owned temporary compile-cache root. Six DB foundation pins and the five historical PostgreSQL suite pins remain unchanged. The incoming six parent commits and seven exact parent paths are preserved.

This cut supplies source integration and finite DB guards. The ECO persistent HTTP/service/retained-read lifecycle, readiness persistence, workspace UI, a genuine current-source browser hour, installation image/source proof, full installed acceptance, and exact final-head remote CI remain open. Historical HOLD and red evidence remain immutable. No merge, deployment, production enablement, real business notification, or issue closure is authorized by these local checks.

Root also accounted for all 21 commits outside current parent a771: 10 SOURCE/10 immediate ONE/one local merge, all 70 net paths, full author/committer/body/trailer metadata and merge combined/parent diffs. All 43 available historical receipt source hashes matched. The independent provenance JSON digest is `6c7954bee4436c26a203f98f9b230c25c98c9504afd519326003a1154b168778`; attribution and source mapping do not turn older bounded tests into current runtime acceptance.

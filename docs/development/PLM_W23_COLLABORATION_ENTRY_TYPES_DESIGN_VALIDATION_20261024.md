# Collaboration entry hint prop type

Draft 6531 web source types failed on ONE `37516a0b3cd002c3d416e8f29f4415c2d2b539fc`. `vue-tsc --noEmit -p tsconfig.app.json` reported one error:

`src/multitable/views/MultitableWorkbench.vue(293,12): error TS2322: Type '{ bindingId: string; sourceKind: "eco" | "readiness"; }' is not assignable to type 'null | undefined'.`

The public caller is `MultitableWorkbench.vue`. It passes `collaborationSnapshotHint`, which is the value returned by `readPlmCollaborationSnapshotHint`. The panel prop was `PropType<unknown>` with `default: null`. Under vue-tsc 3.1.4 that public prop type is only `null | undefined`, so the real object cannot be passed. An older narrow program that included only the panel did not include this caller. This check does not treat that narrow program as coverage of the Workbench.

## Repair

One prop line changed, at `PlmCollaborationSnapshotsPanel.vue` line 484. `hint` is now `PropType<{ bindingId: string; sourceKind: 'eco' | 'readiness' } | null>` and still defaults to null. `readPlmCollaborationSnapshotHint` still accepts `unknown` and still checks the two keys, the binding id, and the source kind before any read. The typed prop does not skip that validator. No other product, test, workflow, or tsconfig file changed. Workbench stays the caller and was not edited.

## What was executed

A private copy of the app compiler options typechecked the current `src` tree, including the real Workbench import. `tsBuildInfoFile` and `vueCompilerOptions.globalTypesPath` pointed into nonce fixture `/tmp/plm-w23-entry-types-e35acdb7353444adba12a9ab66832231`. The run used `vue-tsc --noEmit`, not `vue-tsc -b`. Strict, target, lib, and the other production flags were left as they are in `tsconfig.app.json` and `@vue/tsconfig`. Node was v24.19.0. vue-tsc was 3.1.4. TypeScript was 5.8.3.

Before the prop edit, that command exited 2 and printed the same TS2322. After the edit, the same command exited 0 with empty output. The shared `node_modules/.vue-global-types/vue_3.5_0.d.ts` and `node_modules/.tmp/tsconfig.app.tsbuildinfo` kept their sha256 and nanosecond mtimes. A write guard allowed only the fixture cache.

The permanent panel file has 27 tests. The unchanged host file has 10. Copied Root controls have 7, 3, 2, and 1. Together that is 50 passed, 0 failed. Two earlier fixture launches exited 1 before any test ran: the symlinked setup file was outside Vite's file allow list, then the worktree tsconfig could not resolve `@vue/tsconfig` because this worktree has no `node_modules`. The counted run used copies of the current sources inside the nonce. Those copies matched the worktree panel hash.

The 14099 binding pins were compared before and after the edit: 5134 matched, 8965 null paths absent, 0 missing, 0 mismatched. The panel is outside that pin map. Its mode stayed `644`. Commands, exits, and hashes are in `artifacts/plm-w23-collaboration-entry-types-20261024/verification.json`. The nonce fixture is removed after that record is written and before the owner lock is marked released.

## Still open

At author release, Root owned the pending Source/ONE and child Draft publication after parent #6531 valuable runs terminate. The author made no commit, push, or PR. New exact-head CI is required for acceptance after publication. Whole-app HTTP, browser, PostgreSQL, install, and the hour were not run. This file is not a Root acceptance.

## Final independent source qualification

Codex independently copied the complete current `apps/web/src` tree (949 entries) under its own private fixture, kept the production app compiler options, and redirected only generated globals and output paths. The old prop bytes reproduced the same Workbench TS2322 with exit 2. The repaired prop passed the same complete source typecheck with exit 0 and empty output. Source hashes/mtimes and both shared generated-cache hashes/nanosecond mtimes stayed unchanged. This is a full current source-program check, unlike the earlier panel-only check.

Codex independently reran the unchanged 50 controls against the repaired component: 50 passed, zero failures/errors/skips. Earlier overlapping cohorts are not added. The emitted ES2020 JavaScript, template and styles are byte-identical before/after the one type declaration; emitted-script SHA-256 is `a710170226a9b1c478a3ed23efceadd15c0b3fadb334db6169a1beef174885be`. An initial private equivalence-helper attempt could not resolve a transitive compiler package before running any product code; resolving that package through the installed Vue package produced the counted result without dependency installation.

Parent #6531 exact `37516a0b3cd002c3d416e8f29f4415c2d2b539fc` reached 22 terminal checks: 18 successful and four failures. Three failed web type steps report the same TS2322 (Visual, managed companion, personal approval); the fourth is the existing missing private-Native checkout token. The personal JUnit upload also failed because its PostgreSQL steps never ran after types failed. Its earlier 398 unit passes are separate; no personal PostgreSQL acceptance is inferred. New-head CI, real HTTP/browser/build/image/install/hour and the full master goal remain open. Draft and Claude ownership gates remain intact.

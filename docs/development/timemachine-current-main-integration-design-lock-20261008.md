# Time Machine current-main integration

This local integration advances the existing completion goal; it does not declare Time Machine complete, publish or merge candidates, enable flags, or execute staging. The full goal remains controlled staging acceptance with fixed source identity, isolated synthetic backup/restore and rollback evidence, Phase 5 attribution, and owner-gated execution.

Main baseline: `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074`. Source candidates: `ac1f03b6dadc772646ead49c7e42361deee490a6` (owned archive stack and attachment deletion), `2ed869f079b8a4a41df10f15215ea7eb0906c32c` (bounded view census), and `6b909e6a2d019454216bb03f1aeda87827f16a78` (unavailable percentile validation).

Port only the candidate's 124 changed paths and the nine independent census/Phase 5 paths. Preserve all 47 main-only paths and unchanged package, workspace, lockfile and feature-flag manifest. Workflow integration adds eleven lines and removes none, retaining main's Node 20 matrix and runner selection. This is local patch application in a new owned branch; original branches and SHA-bound reports remain intact.

Two archive CI roster scripts require a correction: source-deletion was wired into the actual workflow and no-DB exclusion but omitted from their exact roster and missing-connection sentinel enumeration. Add it after attachment admission in both scripts, retain every existing entry/negative, and require a matching omission-guard mutation to fail. This changes test wiring, not runtime or flags.

| Gate | Local result and scope |
| --- | --- |
| Source preservation | 121 nonworkflow paths match ac1 exactly; two explicit roster overlays; four census and five Phase 5 paths match their commits |
| Main preservation | All 47 main-only paths, package/workspace/lockfile and flag manifest remain byte-identical |
| Focused backend units | 28 unfiltered files, 794 passed, zero skipped; includes view census and Phase 5 child-test wrapper |
| Actual project type checks | `tsc --noEmit` and recovery-archive acceptance script configuration pass; earlier explicit CLI strict probe's 88 diagnostics are a different scope |
| OpenAPI | Build and guard pass after installing this worktree's SDK dependencies; initial missing-dependency failure retained |
| Exact archive CI roster | 24 checks pass; omission-guard mutation fails; exact restored bytes pass |
| Armed missing-connection behavior | Whole harness passes and exercises all 24 archived real-DB files without DATABASE_URL |
| Integrated-tree native acceptance | OPEN; prior ac1/ad0 APFS and same-archive evidence is not a run of this tree |
| Remaining writer families | OPEN; next finite family is actual REST create/patch/bulk/delete and actual host SDK create/patch/delete, including chain-sequence readback |
| Publication, required Node 20 CI and owner merge | OPEN |
| Phase 5 live target/activity attribution, durable provider/KMS and owner staging window | OPEN |

Evidence is append-only under `artifacts/tm-current-main-closeout-20261008/`. Historical native evidence keeps its original source identity. Local synthetic verification never supplies authorization for real tenants, production writes, flags, workflow dispatch or deployment.

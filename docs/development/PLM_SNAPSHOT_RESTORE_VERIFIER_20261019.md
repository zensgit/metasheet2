# Snapshot restore verification candidate

Status: incomplete, unpublished. Product/native source remains separately pinned; this branch develops the owned cross-system verifier rather than changing product authority. Source commit `d5f03948a68c2e181e8003dff61971b7abc263a0`, based on Meta `16381a8d39659e8f59b244d8b1051c2e80401b3b`. Original helpers and existing source/build evidence remain retained.

## Required final scenario

Start with a real independently confirmed native snapshot and target-permitted Meta publication. Prepare a second unfinished share, make native cancellation unavailable, unlink, and preserve its frozen cancellation identity. Quiesce both applications, dump Meta PostgreSQL and back up all three native fixture stores, make original stores unavailable, and restore into new locations. Fresh processes must retain published snapshot data under current target ACL, refuse new operations while disabled/unlinked, and acknowledge exactly the original pending cancellation with flags disabled; duplicate retry must be idempotent. Verify native authority state and generic pre-review boundaries remain unchanged. This source-process scenario must remain distinguished from full installed package/volume/host/customer acceptance.

## Completed native restart prerequisite

The native fixture now has an explicit owned `restore_existing` mode. It validates the nonce-owned parent, fixed restored directory and three existing ordinary database files, skips schema creation and fixture reseeding, and supports disabling snapshot sharing independently for the restored process. Normal fresh fixture behavior remains available. Missing or linked restored databases fail before application startup.

The new `verify_native_restore.py` exercised actual isolated native processes using source `f803ad31a4efb5a9eaab556a166eb2421078781f`. It gracefully stopped the original process, used SQLite backup for global/identity/tenant stores, renamed the original directory away, and started a fresh native process on only the restored files. Actual Settings reported sharing disabled, the health endpoint returned 200, native source items remained unchanged and write audits stayed zero. Logical database hashes matched before/after the restart. Two additional processes refused missing and symbolic-link identity files with the precise expected guard; hashes remained unchanged. All owned children stopped and resources were removed.

Command: `/Users/chouhua/.codex/tmp/yuantus-bom-ui-20261015/bin/python scripts/verification/plm-managed-companion-paired/verify_native_restore.py --native-checkout /tmp/codex-plm-bom-share-provider-20261019 --python /Users/chouhua/.codex/tmp/yuantus-bom-ui-20261015/bin/python --output /tmp/plm-native-restored-fixture-v2-20261019.json`. Compact receipt: `artifacts/plm-snapshot-restore-20261019/native-restore-proof.json`. Syntax compilation and diff checks passed.

## Still open

The native prerequisite does not exercise the final Meta restore, a pending snapshot cancellation or installed runtime. Those phases and their exact-head CI must be implemented before this verification slice is accepted. No original data, running customer service, dependency gate or 4 GiB installed-profile floor changed. Native/Meta grant purposes, audience confirmation and target ACL remain product checks, not fixture overrides. No merge/deploy/production enablement is authorized.

## Completed source-process dual-system scenario

Source implementation `e7d122a6fa66461a7f0780c6aa0a2c5d54b065a0`, explicit browser-module follow-up `98bed2cca03700c7d776adab4b0baf7ef00938fd`, assertion-safety follow-up `2a43a64016b1f2af4ea501cf34188c7f4f8b80e5`. Actual full scenario v5 passed against native `4f5d2f4964b6b781ab059fe1696597912e0e36de` and Meta product `16381a8d39659e8f59b244d8b1051c2e80401b3b`. Seven executed verifier files remained unchanged during the run and matched the functional source commit's Git blobs.

The browser performed native audience confirmation, actual Meta publication and a generic pre-review with a separate Meta reviewer. A second native intent remained unconfirmed. Native transport was deliberately made unavailable before unlink, producing one persisted frozen cancellation. The known paused fixture process was terminated before resuming so timed-out requests could not commit late. The restored native listener used a fresh backend port behind the same registered TLS origin; no registration identity was changed.

With applications stopped, actual PostgreSQL dump/restore copied 86 tables to a new database; all table-row fingerprints matched before startup. All three native SQLite databases were backed up and restored to a new directory with matching logical fingerprints. The original native directory was renamed away and original Meta database retired by rename, preventing stale source locations from masking restoration errors. Fresh native and Meta processes used only restored stores.

With managed/snapshot issuance disabled, the existing target-authorized CSV export returned C-001 and the outsider without target read permission received 403. New sharing was refused. A changed registration secret could not cancel and triggered no shared-account fallback. Restoring the original registration acknowledged the original native intent; duplicate cancellation left its acknowledgement unchanged, frozen identity bytes remained identical, and the separate pending managed revoke was acknowledged through actual HTTP. The native pending intent ended revoked without authorization/export, published Meta records stayed unchanged, and native PLM business data / source-item fingerprint remained unchanged with zero writeback audits.

The fixture now applies the unchanged audit-schema migration and asserts the generic pre-review submission audit is persisted; no silent missing-audit-table result is treated as complete evidence. Existing approval completion was replayed twice and yielded one notification, with no native PLM state mutation. Raw final report/log: `/tmp/plm-snapshot-dual-restore-v5-20261019.json` and `.log`. Compact receipt: `artifacts/plm-snapshot-restore-20261019/paired-restore-proof.json`. All owned children stopped, the postmaster's stopped status was proved, proxy closed and directory removed.

## Preserved failures and safety checks

The first attempt completed browser publication but the parent requested an IPC report from the deliberately paused native child, blocking the verifier. Only that known fixture child was terminated after PID/parent/command validation to allow owned cleanup; no CI job was cancelled. `/tmp/plm-snapshot-dual-restore-v1-20261019.json` remains failed with cleanup true and the failure log retained. Reporting now occurs before the outage and after fresh restoration, with cross-phase source-item hashes compared.

A real controlled child/TCP-listener failure reproduction exposed an open owned listener while an exception retained the frame. The socket is now context-managed. The reproduction first failed and then passed, proving the controlled failure propagates, the owned child exits and listener closes. Proof: `failed-restore-cleanup-proof.json`. Assertion checks cannot be disabled: eight CLI checks plus two callable checks refused both `-O` and `PYTHONOPTIMIZE=1` before resources/output. The initial callable probe used 14 rather than 13 arguments; only those two failed harness probes were corrected and rerun. Proof: `optimization-refusal-proof.json`. No product vulnerability is attributed to that harness typo.

## CI and remaining installed acceptance

The verifier accepts an explicit Playwright 1.57.0 module and uses the full Chromium channel, matching the existing package installer's no-shell browser installation. Wrong version/name metadata is refused before runtime startup. This avoids adding browser downloads or a fallback dependency graph.

Because Yuantus is private and MetaSheet public, the source restore gate is added in the private Yuantus package workflow: it checks out this public verifier at fixed source `2a43a64016b1f2af4ea501cf34188c7f4f8b80e5` and uses the workflow's own native checkout plus separately pinned Meta product. No new private cross-repository secret is requested. Native package candidate source `faf719be572b456fcae30d8463cb3478bcac5e42` retains all existing gates and adds the native prerequisite, failure cleanup and complete paired scenario. Its actual Python proof gate passed the real final reports locally. Remote exact-head CI has not yet run; publication remains queued behind useful parent jobs and all PRs remain Draft.

This closes the owned source-process snapshot restore scenario only. Installed package/PM2/Nginx/volume lifecycle, host recovery, real customer acceptance and the full master goal remain incomplete. The 4 GiB installation floor is unchanged. No production service was enabled, deployed or merged.

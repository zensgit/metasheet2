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

# W23 ECO collaboration snapshot database guards

Status: bounded local database foundation accepted; persistence HTTP/service, readiness admission and workspace UI are not implemented by this slice. All publication stays Draft. No merge, deployment, production enablement or real business notification is authorized.

## Approved contract and reuse

The owner chose read-only persistent collaboration. This slice adds four finite control tables (previews, bindings, rows and accepted sync receipts); actual business cells continue using existing sheets, fields, views and records, with the existing record writer, history, operation ledger, comments and ACL engines. It does not change the BOM family or create another management engine.

ECO keys are typed four-element JSON arrays: datasource, Native tenant, Native organization and ECO id. The collection fixes Item and required-nullable version, creator and target. Exactly eleven ECO source string fields are read-only; exactly three local fields remain editable: collaboration_owner/person, followup_due_at/dateTime and review_note/longText. Readiness is reserved but explicitly unadmitted until its separate mapping is implemented and qualified.

## Database behavior

Bindings and row identity are immutable; disable is irreversible. Field/container/record CRUD and TRUNCATE paths are guarded. Accepted source writes require the exact record, binding, typed key, full source postimage, actor/version and same transaction receipt. A nonempty family sync intent is checked even when source values are unchanged. An old BOM GUC is not a new-family capability. Real local changes require version+1; exact native lock/unlock retains the existing version-marker behavior without inventing content revisions.

Initial admission locks base/sheet/view with NO KEY UPDATE and mapped fields with UPDATE in deterministic order before qualification. This blocks the demonstrated concurrent field-unreadonly race while preserving child foreign-key KEY SHARE. Downgrade locks control tables before checking persistent evidence and refuses destructive reversal. Functions use SECURITY INVOKER and the admitted physical serving schema.

A direct privileged INSERT into the accepted-sync control table is outside ordinary record CRUD authorization. SQL does not recompute the wire business hash or prove live source ownership. The forthcoming service must recheck persistent datasource owner/config, current Meta permissions and independently authenticated Native scope before and after source I/O and inside the final transaction. This migration alone is not that product authorization proof.

## Verification and retained failures

Root used fresh nonce-owned Unix-only PostgreSQL16.15 runtime copies with genuine pgcrypto1.3 metadata from official PostgreSQL REL_16_15 commit7d3e000c5961a544302072058a1184e9a588837b. Real extension loading, digest and random bytes were checked; the original portable prefix was unchanged. Every owned cluster/copy was stopped and removed only after status3, PID absence, no open files and zero owned catalog/connection checks.

The original migration runtime defects were retained: nested Kysely transaction entry and invalid schema-qualified POSITION syntax. The actual Migrator predecessor guard then passed once; its unchanged helper was not rerun. Four further actual guard defects were reproduced, repaired and independently rerun as 3+2+1 PASS: native lock/marker, receipt-to-row-key consistency, local version/history and the two-backend field race. Commit probes verified persisted refusal, not only statement errors. The race observed a real transactionid wait and blocker PID, then binder success/editor23514; timeout/deadlock is not success.

The first product cohort was 14 executed, 10 PASS and 4 FAIL, zero skipped. Three failures were exact fixture mistakes: collection race reused the seeded unique tuple, an unbound soft-deleted view still held its FK, and PostgreSQL rejected no-CASCADE TRUNCATE before the family trigger. Fixtures were corrected without dropping constraints or weakening source protection; native0A000 refusal and direct CASCADE23514 guard assertions remain distinct. The fourth failure exposed a genuine unchanged-source sync-intent bypass. A new independent probe committed a valid unchanged-source refresh, then proved a wrong-record receipt incorrectly committed version3; after the minimal fix it refused COMMIT and retained version2 with no wrong receipt.

At final migration dd55d236/test6fd0f3db, only the four failed product nodes plus the new permanent same_source_sync_intent node ran: 5 PASS, 10 intentionally nonselected. The independent previously failed same-source COMMIT control reran 1 PASS. Earlier passing nodes were preserved; there is no claim of one final local 15-test all-green run. Normal Vitest1.6.1 used existing Node24.14.1/TypeScript5.8.3; CI Node20 remains separately required. Static transpile is syntax checking, not a full typecheck.

The existing best-effort missing meta_record_subscriptions fixture warning was not muted. No notification delivery is claimed. The dedicated new DB suite with DATABASE_URL absent failed with the exact required-URL error and zero tests, rather than skip-green.

## CI wiring and evidence

The existing PLM listener workflow retains its private PostgreSQL16 service, dynamic port, Node/pnpm pins, 25-minute budget, prior steps and full tsc. One separate snapshot DB suite step and three exact filters were added. Default Vitest excludes only this explicit realDB file. Parsed workflow comparison proved prior job semantics unchanged; no old passed BOM cohort was rerun.

Compact verification is in artifacts/plm-w23-eco-snapshot-db-guards-20261024/verification.json. Final immutable local packet: /Users/chouhua/.codex/worktrees/plm-listener-review-20261015/Yuantus/artifacts/plm-listener-review-20261015/private-acceptance-evidence-20261020/w23-meta-db-final-local-20261024; manifest SHA256 8c05b2a38e3366d3c3d610a5536edc021d18472c068ca8093a20ead354587167. Earlier RED/HOLD packets remain referenced by that manifest. Source and one closeout commit are separate. No HTTP/service/UI, full install migration, current image, browser, elapsed hour, installed acceptance or current-head remote CI success is asserted.

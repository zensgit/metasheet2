# Ordinary approval saved-binding cleanup

As of 2026-11-01T19:17:52.492224+00:00, this is a local static source delivery. Execution qualification remains open.

- Source: `ee49714fbc0f3e13d2db59a883acd453c1d9b902`; parent: `76e862eb16aa13d34f4d0a60c4f54367d4d77f2e`.
- Branch: `codex/plm-approval-owned-cleanup-list-20261102`.
- Six source/test files changed: the existing binding service, web client, panel and their three existing test files.
- No push, new PR, new CI, service startup or database action occurred. The published 6684 head observed before commit remains `8d237dac8ef6f168353d7cf8806a878e026bd0e5`.
- Main observed before commit: `b28538e328f754abba38553766537af2c4651894`. This local stack has not been rebased to main; future integration gates remain.

## Problem and resulting behavior

The normal settings list previously selected only the current connection ID and required the provider management URL. A provider failure hid the panel; a connection ID change hid older saved rows. The preceding owned-unlink service fix was therefore inaccessible through this ordinary UI path.

The list now returns all saved rows belonging to the active Meta owner. A narrow provider getter/URL/effective-scope failure yields explicit `grantManagementUrl: null` and unusable rows. Database, owner, metadata and feature/config gate errors still propagate. The feature gate is checked again after awaited reads. Listing performs no personal provider request, login, verification or fetch.

GET list rows add required boolean `canUse`. It is advisory local eligibility: current connection/tenant/org match, a saved credential exists and its expiry is future. It does not prove Native permission, online grant validity, revocation, licensing or origin continuity. Existing operation guards remain authoritative. The basic POST bind DTO and service metadata projection are unchanged.

The client accepts explicit null or its existing strictly validated management URL. It rejects missing/nonboolean `canUse`, and true for a foreign connection, unbound row or null management URL. Old connection rows with false remain visible; unexpected credential fields are projected out. The panel displays the saved connection and retains owned cleanup independently of usability. Sync/reconcile have disabled controls and handler guards. A missing URL hides the grant link/form and prevents bind. Every admitted action/refresh clears the unsent grant before awaiting, preventing an old draft from following a changed connection. Account-switch, generation, abort and fixed request-body protections are preserved.

This requires coordinated backend/web DTO deployment. An old client rejects the new null/old-connection list, while a new client rejects the old GET shape lacking `canUse`. There is no permissive compatibility fallback. No migration or origin pinning was added. Local unlink is separate from Native remote revoke.

## Static evidence

Grok session `gbt-5e78-1a1986ad51d-5` performed the bounded implementation and corrected two rounds of independent findings in the same handle. Requested model/effort: Grok4.7/high; observed new-session CLI TUI: Grok4.7/xhigh; backend deployment ID UNKNOWN. Author-reported actual model UNKNOWN is retained in the original report. Independent Sol high was requested; actual model/effort UNKNOWN.

The final capsule archive is 31,705 bytes, SHA256 `8926f816a7e1b661f4e48e6c3966bced2486731dca258cee9a6b1418ea5e49c6`. All ten member hashes/lengths were checked; three read-only inputs are unchanged. Six editable source/test members plus the report are retained alongside the immutable initial snapshots. The complete terminal command history was not captured; no global filesystem/process audit is claimed.

Only `list()` changes in the service prefix. The excluded 13,981-byte service tail is byte-exact, SHA256 `771168b2fcf40ce584712d58bb696a6c0da103d9d224da7915f062fbabe895e9`. The original 1,746-byte backend test prefix and six earlier test blocks are preserved. Root adds one separately reviewed `as const` test-table annotation after author STOP; the Grok candidate/report remain immutable. This removes inference ambiguity without claiming an established or reproduced TypeScript error.

Authored cases cover owned/foreign/old-connection rows, independent tenant/org drift, expired/unbound credentials, provider unavailability, SQL/owner/metadata/module failures, post-await gate closure, strict client DTO projection, cleanup with unavailable/current-changed provider, action-handler refusal and refresh draft clearing. The consumed-Response test defect and disabled-click coverage gap found during review were corrected. SQL mocks establish call contracts only, not real PostgreSQL mutation or locking behavior.

| Check | Result |
| --- | --- |
| Independent final source/test review plus Root one-line delta review | No known static blocker |
| Source/tail/input SHA and byte comparisons | PASS within the stated scope |
| `git diff --check` | PASS |
| New/unchanged tests, tsc, lint, build, imports | NOT_RUN |
| HTTP, PostgreSQL, browser, installed/runtime/business qualification | NOT_RUN |
| Push, new PR, new CI | NOT_RUN |

The coding model was closed after idle/done and all ten file hashes/lengths were rechecked. Bridge 24184 remains ready with zero model sessions; its retained parent is not a claim of global host idleness. The original N2 lease was not touched.

Private control/review records are under the existing artifact directory `unattended-12h-20261101/grok-tool-restore-20261101/approval-owned-cleanup-list-20261102/`: `Root-final-v1-export-acceptance.json`, `Sol-final-v1-independent-static-review.json`, `Root-one-line-tuple-inference-delta.json`, `Sol-Root-one-line-tuple-delta-review.json`, `Root-final-v1-reassembly-static-guards.json` and `Root-model-close-acceptance.json`.

## Remaining delivery boundaries

All seven packages remain OPEN. This local stack is absent from the earlier compiled/c24/runtime qualifications and original published Native/Meta source heads. It does not complete ordinary two-system Source/grant/write/revocation integration, full N08, controlled BOM T2/T3/full T4, signed three-SKU entitlement, install/upgrade/mirror/backup/restore, browser or business acceptance. Existing Source23, W2, Claude/H3/Stage A/RG/#249/perf, P16 and Work-browser HOLDs remain. The owner's uncoordinated-namespace decision retains the exact N2 lease; no close/permit/new runtime or replay follows from this static delivery.

This slice uses one source commit and one closeout document commit. Subsequent qualification results belong in state/PR-body records, without recurring source/document commits. Draft and separate merge/deploy authorization gates remain.

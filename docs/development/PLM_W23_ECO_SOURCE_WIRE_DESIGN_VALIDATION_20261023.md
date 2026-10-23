# W23 ECO collaboration source wire — design and validation

Status: finite wire and explicit adapter method verified locally. Persistent collaboration, publication and whole-window acceptance remain open.

## Authorized scope

The owner accepted the W23 proposal: retain the workspace/BOM entry and first deliver read-only persistent collaboration. This slice supplies the ECO source boundary needed by that work. Its Native dependency is source `ef026b22f691c270854373c306e4cc0938a053cc`, separate closeout `e84cf8866af94be6a9db897e9f8873d9103cd02e`. The Meta parent is `18acca1ec49920592644dbfb1eb994b12eac141f`. Actual Grok 4.7 (xhigh) implemented this slice; Codex independently reviewed it and reproduced the counterexamples below.

`plm-collaboration-snapshot-wire.ts` accepts only `eco_collaboration_source.v1` / `collaboration_source_read`. The response must match the captured Native tenant, organization, Item, required-but-nullable current version and ECO. `product_id` must equal the selected Item. The eleven ECO fields are `id`, `name`, `eco_type`, `product_id`, `source_version_id`, `target_version_id`, `stage_id`, `state`, `kanban_state`, `priority`, and `updated_at`; extra fields fail closed. An unlicensed response returns a values-free refusal, never a snapshot.

The typed row key is `[dataSourceId, nativeTenant, nativeOrg, ecoId]`. Its SHA-256 business material includes the fixed Item/version and ECO whitelist, including business `updated_at`. It excludes the volatile snapshot clock. This is one row's business hash, not a collection CAS. Snapshot capture time remains available separately. Native string bounds count Unicode code points without normalization; timestamps use a real Gregorian year 0001–9999, six fractional digits and `Z`.

Exactly three future local collaboration fields are declared: `collaboration_owner` (person), `followup_due_at` (dateTime), and `review_note` (longText). This slice creates no sheets, records, fields or database tables. It supplies no readiness DTO or empty readiness success.

## Explicit transport

`PLMAdapter.getEcoCollaborationSource(input, freshSourceConfig)` captures the caller-supplied source ID, connection, credentials, Native scope, request and expected anchor before its first await. It uses the exact Native ECO-context POST; it does not reuse the adapter's cached config, shared Axios state, BOM query path or approval grant. A configured token is used as supplied; denial or malformed credentials cannot switch to another identity. Without a token it uses only that source's own login credentials. HTTPS is required outside an owned test loopback; userinfo, conflicting scope aliases, redirects, query and fragment are refused.

The existing classifier must positively admit the captured source ID as unbound. Managed, stale, unavailable or missing-schema classification refuses under either managed flag value. Admission is rechecked after login headers, after the parsed login token immediately before the ECO POST, after ECO headers, and after parsed ECO validation before return. Owned response bodies are cancelled on admission refusal.

These reads do not create a lock across SQL and HTTP. The method does not itself prove current Meta source ownership or re-read persistent configuration. Future routes must enforce the current Meta owner/ACL, retain separate Native identity and both scope axes, and perform final persistent fingerprint/CAS checks. No public route is mounted by this slice.

## Counterexamples and verification

All commands used the existing `packages/core-backend/vitest.config.ts`, Vitest 1.6.1, Node 24.14.1, `--retry=0 --maxWorkers=1 --minWorkers=1 --no-file-parallelism`, verbose output and JUnit. The evidence groups overlap and must not be added into a coverage total.

| Evidence group | Actual result and limit |
| --- | --- |
| First implementation, two committed unit files | Historical 33 passed, zero failed/skipped. The shell subsequently exited 1 because it assigned zsh's read-only `status`; the Vitest log/JUnit are retained, not relabelled as a successful wrapper command. |
| Root delayed-body controls | Two real owned-loopback failures: binding changed after headers but before JSON completion. Login still emitted the ECO POST; the ECO response still returned an accepted DTO. Each case retained its unbound positive control. |
| Transport repair | 15 selected tests passed; 13 unselected tests were skipped by name selection. This is not a full current-head or zero-skip suite. |
| Root original delayed-body failures after repair | Two passed, zero failed/errors/skipped. Changed login admission prevented the ECO POST; changed ECO admission prevented acceptance. |
| Root Native compatibility controls | Three failures: legal 65-code-point astral IDs, legal 51-code-point ECO names, and Native year 0001. The Python string/datetime oracle was a language check, not a product import or business-row inventory. |
| Wire compatibility repair | Six selected tests passed; three unselected tests skipped. Bounds include 128/129 code-point IDs, 100/101 code-point names, years 0001/0099/0100, year-zero refusal, and Gregorian leap-date checks. Text is not normalized. |
| Root original three compatibility failures after repair | Three passed, zero failed/errors/skipped; all four final source hashes remained unchanged. The already-passing transport/body groups were not rerun. |

Receipt: `artifacts/plm-w23-eco-source-wire-20261023/verification.json`. The private evidence index retains the original red packets and final source/test bytes, command logs and JUnit files. Source and one closeout document commit are recorded separately. `git diff --check` passed. Existing default Vitest discovery already includes both unit files; no CI workflow or frozen baseline was changed.

The real HTTP loopback uses a classifier double. It proves the asynchronous response-body ordering above, not real PostgreSQL classification, current Meta ownership, distributed locking or consent. Header Unicode byte-string compatibility was not tested. Free space exceeded the unchanged 4,563,402,752-byte small-test floor and remained below the 8,589,934,592-byte heavy-work floor; package typecheck, PostgreSQL, Docker, browser, build and install acceptance were not started.

## Remaining work

Implement the approved persistent ECO collaboration with existing Meta sheet/record/view/ACL/comment/history engines, current owner checks, frozen anchors, collection CAS, guarded source columns, refresh preserving local fields and history, and non-destructive disable. Readiness requires its own qualified Native read closure and consistent business read view before exposing the second sheet. CAD and unratified actions remain unavailable.

This source boundary is not completed W23 collaboration, current-head remote CI, installed-package acceptance or whole-goal completion. Publication remains subject to the dependency queue and must stay Draft. No merge, deployment, production enablement or real business notification is authorized by these local results.

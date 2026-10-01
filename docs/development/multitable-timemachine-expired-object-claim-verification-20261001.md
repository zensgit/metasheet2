# Expired archive object claim verification — 2026-10-01

Bounded local development on `codex/tm-archive-expiry-claim-20261001`, based on
`336f8eecf044da8292f7e293e74b33aa4dadbe3e` (fresh main plus corrected admission).
Root authorized merging the admission census correction
`146e495e28af46f939e0eaa155ac51ac3bbeb0c3`; the resulting base is
`950dcb748cc412d75b1ea89bc412d61457cab09a`. That merge changed only the inherited
census guard and admission verification report. Eleven owned runtime/test/wiring
source hashes remained identical; the claim source remains uncommitted.
Draft/HOLD; runtime remains OFF and unwired. This implements the claim/takeover
increment of the [claim lock](multitable-timemachine-expired-object-claim-design-lock-20261001.md),
not full original D1 D-L acceptance.

The additive migration and separate TypeScript wrapper freeze durable store,
staging, key, provider version, ciphertext digest, size and expiry correspondence
before `ready|failed_retryable -> deleting`. Missing legacy binding refuses.
`failed_retryable` is tested using privileged synthetic state; this increment
creates no transition into that state. Claim and expired-lease takeover require
READ COMMITTED, the complete admission prefix before intent CAS, exact identities,
operation key and previous worker/version/lease correspondence. The database
assigns a 60-second lease and greater fence; references remain retained.

The split row guards preserve the original admission function and closed immutable
shape. PUBLIC table mutation and function execution are revoked. Production
migration creates no role or grants. Future invocation requires an approved
non-owner, non-superuser role without direct or inherited base mutation or authority
DDL privileges; owner/superuser arbitrary DDL is outside this boundary. The owned
cluster's restricted role could not forge DML, a GUC, a nested trigger or authority
replacement. Actual blocking races covered hold-first cancellation and claim-first
late-hold rollback. No external deletion took place.

| Final check | Actual result |
| --- | --- |
| New claim unit + admission neighbor | 33 + 23 = **56 PASS**, two whole files, zero skipped |
| New claim real DB + admission + legal hold + key registry | 30 + 22 + 19 + 10 = **81 PASS**, four whole files, zero skipped |
| Fresh migration apply and down/up replay | **36 migrations, 1071 catalog objects**, exit 0 |
| Claim and pre-existing writer-state down-failure injections | Each exit 1 with `injected_down_failure`; recovery completed |
| Exact-anchor and archive CI source guards | **52 PASS**, exact replay UNION 36 and archive roster 16; sibling omission negatives retained |
| Schema-fence structural census and schema neighbor | **169 PASS**: 49 + 120 whole-file tests, zero skipped; both archive SQL holders classified and all eight SQL acquirers pinned |
| Changed migration/wrapper ESLint and acceptance TypeScript | Each exit 0 |
| Hermetic sealed-export provenance and S5 neighbor | Each exit 0 after final pin |
| Owned synthetic native PostgreSQL cleanup | Connections 0, temporary roles 0, database dropped, server stopped, status exit 3, cluster removed |

The initial three-file DB attempt had 69 PASS and two fixture failures out of 71;
explicit UTC fixture leases fixed the timezone assumption. The corrected initial
three-file run passed 71. The final **81** result adds the whole key-registry file
and was run after all mutations and a fresh database reset. Both the initial
failure and final logs remain in the evidence directory. Final replay fingerprint:
`6d95ee19c7dfba919df1efeec5661de65695cd3f440bb5a6bc15afbd7585946a`.

Eleven load-bearing mutations each exited 1: lease expiry, exact fence, row version,
operation key, durable binding source, binding immutability, admission prefix,
READ COMMITTED, split update guard, restricted ACL and hold irreversible point.
Nine independently mutated copies of the new migration used the same original
buffer; after the driver, its byte-exact restored SHA-256 was
`8b1a146de917819348141f53fcdec70fa7bab9f145c6e2a8ab67ef4898c45d91`.
This is the measured final restoration, not eleven separately measured source
restorations. The two database-only mutations were restored and then discarded
by the fresh reset. The final PostgreSQL hold function matched the saved original
bytes, SHA-256 `c41adbae5616dfcddba7ea59c27d6613da8cec046876f1d7793e51d7e009f45e`;
the restored PUBLIC ACL posture hash was
`f229006ec9ab31153b6b58cd3d5b0f37b383a265a590505c49facba85c69b8c3`.
The old admission migration, wrapper and unit/DB files remain byte-identical to
the corrected baseline; its command/check/guard functions were not replaced.

The final workflow selector was wired in both the real-DB workflow and the no-DB
exclusion roster. Recomputing all 66 provenance leaves changed only
`evidenceFiles.pluginTestsWorkflow`; the other 65, including `pluginHttpRoutes`,
were preserved. Final workflow SHA-256:
`57e1bacec2b99869ee7d3f8df7021f94cb2dd6a13485692e17deeb311af0020c`.
Final pin manifest SHA-256:
`9ab3efc8c731019105c3d6a7b65881260ae185dd1912a826931e47bd38893861`.
The stale-pin failure was retained.

The first full schema census reproduced **7 FAIL / 42 PASS** before its ledger
contained the admission and claim module constants and their SQL acquirers. The
root correction supplies the admission classifications; this slice adds only the
claim holder and claim acquirer. The analyzer and every existing assertion remain
unchanged. After the complete UNION, both whole files passed 169 tests and the
hermetic provenance/S5 pair passed again. This classification-only correction
changed no database source and required no new database run.

All local commands used this worktree's offline, frozen-lockfile, ignore-scripts
dependencies with Node 24.14.1 and PNPM 10.33.0. No donor node_modules, lockfile
edit, public/shared database or workspace-wide test run was used. Command handles
completed; cleanup and execution-completion receipts are included in
`artifacts/tm-expiry-claim-20261001/manifest.json`, alongside exact source and
sanitized log hashes. Fixture identifiers in logs were redacted; no customer data
or credentials were used.

| Remaining original gate | Status |
| --- | --- |
| Exact-head Node 20 CI and owner D1 ratification/merge | OPEN; root owns review/publication |
| Actual provider profile, crash/retry/idempotent receipt reconciliation | OPEN; no provider worker or calls |
| Operation-bound receipt, object/reference release and recovery census | OPEN; no receipt or release transition |
| LC retained keys / retirement or destruction | Unchanged; no KMS or key lifecycle operation |
| Full D-L, D-H2 capture protocol and controlled staging acceptance | **OPEN** |

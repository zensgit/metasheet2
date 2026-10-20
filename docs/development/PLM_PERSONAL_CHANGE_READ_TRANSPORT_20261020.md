# Personal BOM change-read provider transport — 2026-10-20

This is the provider component of the pending Meta enrollment/listener integration.
It adds an independent `yue_` transport to the existing PLMAdapter and reuses the
persisted-source resolver, existing SnapshotTarget model, and committed fact/page
parsers. It leaves the managed-bound shared-transport refusal unchanged. It does
not create an approval, management, or authorization engine.

`PLM_PERSONAL_BOM_CHANGE_READ_ENABLED` is default-off and accepts only exact `true`.
Approval and write flags cannot enable it. Exact personal self-revoke remains
available with the new flag off. Credentials from other purposes fail before any
provider request. The adapter's cached URL, configured shared bearer, API key and
service password are never used by the new method.

A caller supplies a frozen authority resolved from actual persisted source and
managed identity context: Native origin/connection/tenant/org/Auth subject/root,
exact Meta target, and review binding UUID/version. Management links additionally
compare origin and Native tenant/org with the explicit persisted source config.
The native link uses the existing grant page's frozen fragment request contract.
Target shape restricts a credential; it does not prove actual Meta target ACL.
The subsequent enrollment must lock and revalidate those authorities before and
after the provider await and persist the encrypted grant using the existing
listener engine. Those requirements remain open.

The transport only admits verify, exact self-revoke, baseline/paged change reads,
and one committed fact. It uses direct fetch with one personal bearer, explicit
Native scope headers, fixed endpoint paths, timeout and redirect refusal, and no
retry. Verify sends only the Native connection ID; page requests contain only an
optional cursor. Root, target, review binding and Native source are frozen in the
expected authority. Caller-supplied generic query/path overrides are refused.
Response parsing checks the actual grant public ID, independent purpose and
confirmation, current expiry, Native subject/tenant/org/connection/root, exact
Meta target and review binding. Existing fact/page validators check monotonic
cursor, no-history baseline, source and event binding. Errors expose static codes
and never relay provider response bodies or credentials.

Cross-checking the shared SnapshotTarget parser found JavaScript UTF-16 length
bounds narrower than Native Pydantic code-point bounds. Its existing parser now
uses code points for target IDs (128) and audience (1000), with lone surrogate
refusal. No authority rule or permission test was weakened. This matches the
independently corrected Native consent UI and actual Native bounds.

## Evidence

- New unit transport module:10 passed,0 skips,0.607s. Tests cover exact management
  target, independent flag values, yue-only requests/no shared credentials,
  every critical verify identity/scope field, expiry, baseline/page/fact cursor
  checks, self-revoke with flags off, sanitized errors and Unicode boundaries.
- Affected existing managed snapshot-share wire tests:29 passed,0 skips,0.298s.
  This module was rerun because its target text parser changed. Other accepted
  backend/PG/browser profiles were not repeated.
- `scripts/verify-plm-personal-change-read-native.py --native-root <isolated Native tree>
  --output <private receipt.json>` ran actual Node20.20.2/tsx Meta adapter code
  against real loopback Native HTTP in a different process, with three owned
  Native SQLite authority DBs and real Auth42→RBAC900/decoy42 fixtures.
  No provider or authority response was intercepted or replaced.
- The Native JWT API actually issued yue. A real committed BOM write supplied
  the event. Seven real calls proved verify, empty current baseline, explicit
  cursor page, exact fact, refusal of changed expected Native subject and Meta
  target, and current Native tenant refusal. Cross-purpose swaps produced no
  network request. All observed requests used only the personal bearer and
  explicit Native authority, despite deliberately poisoned cached/shared config.
- A separate Node process, with consumer read flag off, successfully self-revoked
  the grant. One fresh verify after re-enabling read returned Native401. The
  runner independently checked the stored Native purpose, Auth42 owner, exact
  Meta target and final revocation. All successful owned resources terminated
  and the disposable DB directory was removed.
- Actual receipt:`/tmp/plm-personal-change-read-native-20261020/attempt2.json`.
  The first run's harness failed parsing stdout because module startup output
  accompanied its JSON proof. The failed receipt/fixture is retained. A unique
  owned proof-line marker fixes only harness framing; provider JSON remains
  strict. Only the failed live phase reran; the39 passed unit cases did not.
- The initial unit command had a wrong working directory and found no test file;
  it is not counted as a product failure or a passing run.

This proves source-process provider transport, not actual Meta ACL enrollment,
encrypted persistence, an active managed listener or PostgreSQL durable recovery.
Those remain the next implementation work. No installed image or whole-goal
completion is claimed. All publication remains held behind #363's valuable queued
performance job; all PRs remain Draft, with no merge/deploy/production enablement.


Backend project TypeScript validation also passed: Node20.20.2 ran
`tsc --noEmit --pretty false -p packages/core-backend/tsconfig.json`, exit0 with
no diagnostics, using the unchanged project options. This checks the new public
adapter method and parser types without emitting or installing a runtime.

Source commit: `7b83aabd7341a60cf1ebd2e9b665a5f8c8c08711`. Compact receipt:
`artifacts/plm-personal-change-read-20261020/verification.json`. This is the single
closeout document commit; exact remote head CI remains pending held publication.

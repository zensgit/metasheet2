# Managed BOM snapshot sharing: design and verification

Implementation `505f1abe3dde175f047264eaefe28c3e2fc0f732`; exact concurrent record-count assertions `9be2eb7757576b035602e49f899bbab729e730ca`; accepted base `218d7bd82a259d7ca8db88d509fc7371c2d3b51f`. Native counterpart is Draft Yuantus #363. This isolated Meta candidate is not published yet.

## Owner decision and authority

The owner selected a one-time authorized snapshot: a native object reader may share only after separate native confirmation of the target audience and current Meta target authorization. Native revoke/unlink stops new source reads, refresh and writeback; existing copies remain under target permissions. Read, approval and write grants do not authorize sharing. Native Auth identity, Meta actor, tenant and organization are checked separately; no MetaID or shared credential fallback.

## Implementation

A durable five-minute Meta intent freezes operation, actor, separate tenant/organization, source/link/session generations and fingerprint, target base/name, native registration, PKCE and nonce. Callback GET only hands off to a fixed return page; purpose-specific POST exports the independently confirmed native snapshot. Strict receipt validation hashes the original snapshot bytes and verifies frozen source, target, operation and expiry.

Publication reuses the existing BOM engine, record/history writer and base/sheet permission locks. Link-first locking follows existing unlink writer order; current source/session/memberships/target are rechecked after export. Final database-clock checks after record writes roll back expired sessions/intents/receipts. A database trigger forbids retargeting and terminal-state reversal. Concurrent callbacks and lost acknowledgements resolve to one binding, three fixture records and three revisions; fresh-process retry does not fetch native data again.

Existing stop, revoke, transfer and unlink paths enqueue frozen native cancellation in the same transaction. Cancellation retries use the original registration/operation and remain pending honestly on unavailable acknowledgement. Published snapshots are retained and do not use the legacy refresh adapter. Browser start/return components use the existing origin-wide authentication Web Lock, exact current managed identity and a frozen operation; native grants and secrets are never persisted in browser storage.

## Actual verification

- Exact additive workflow commands: **93 backend unit and 198 web tests passed**, zero skipped/pending/todo; original gates retained.
- Existing managed PostgreSQL suite: **34 passed**, zero skipped.
- New actual PostgreSQL 15.17 suite: **14 passed**, zero skipped. Covers real record/history publication, concurrent idempotency, exact cardinality, fresh Node process retry, separate tenant/organization checks, target revoke, in-flight unlink and flags-off cancellation, retained target ACL, forced-password changes, actual PostgreSQL membership lock wait, and session expiry during the existing writer. Owned nonce `b555de9295720a0f` stopped and directory removed; proof/report preserved outside it.
- Backend TypeScript, app Vue types, affected workflow actionlint and diff check passed. Changed frontend sources lint passed using the installed offline parser. Backend lint retains four pre-existing control-regex errors in unchanged legacy lines; baseline comparison found no introduced errors. This is not a whole-backend lint pass.

Compact evidence: `artifacts/plm-managed-snapshot-share-20261019/proof.json`.

## Open acceptance

Native RPC is a controlled fixture in the PostgreSQL suite. Actual native confirmation/export over HTTP plus the rendered Meta target-share/return route, generic export permissions, and reused collaboration/pre-review consumers still require connected verification. Local PG15 does not replace CI PG16. Minimal test predecessor catalogs are not complete fresh-install migration evidence. Installed images, runtime package lifecycle, real customer/device and production acceptance remain separate. All PRs stay Draft; no merge or deployment.

## Connected browser, HTTP and retained export follow-up

Verification source `607444d3d3088f0c685bb4c7cfce7d9ea384bc8a` with native `d87a73143778f90d7a5e381237b17950d1e0fa40` now exercises the actual native workspace launch, managed bridge, rendered Meta share panel, native explicit audience confirmation and callback/POST publication over real HTTP. PostgreSQL confirms zero records before native confirmation and one published binding afterward. No transport mock, embed token, dev token, shared authorization, or production service was used. The TLS fixture now supplies the true HTTPS scheme through a loopback-only trusted proxy; the native same-origin check remains unchanged.

The existing generic CSV export endpoint returns the imported child row for an independently authorized Meta reader. Before granting the fixture owner the existing Meta read/export permission, export returns 403; native sharing does not grant that permission. A separate user without target read authority is denied. Actual HTTP unlink returns acknowledged, fresh sharing is refused, and the existing CSV remains exportable under current Meta permissions. The existing global `multitable:read` permission is broad read/export authority, so its holder cannot truthfully be described as an unauthorized target outsider. No production permission implementation changed.

Connected proof nonce `jhr7vswh`: native child stopped, TLS proxy closed, PostgreSQL stopped and owned directory removed, all cleanup assertions true. Original workspace/entry regression also passed after the harness changes, nonce `ho3fjeuk`, with the same cleanup proof. Compact evidence: `artifacts/plm-managed-snapshot-share-20261019/paired-proof.json`. Earlier failed synthetic runs are retained with their refusal causes; they are not counted as passes.

This closes the earlier controlled-RPC-only limitation for the sharing/confirmation/return and CSV path. It remains source-process proof using native SQLite fixtures and Meta PostgreSQL 15.17, server-issued synthetic Meta JWTs and cached Chromium. Full destination grid rendering, generic pre-review collaboration, actual CI16, installed images and runtime package lifecycle remain open; no whole-goal completion claim.

## Rendered destination and reused generic pre-review

Verification source `b16f00a4d95fc53592178a456dedc0aa89be5daf`, with native `606eb7e517a2ad85e9fb97a44aa467a197f6ea20`, additionally waits for the actual destination `.mt-workbench` and visible imported `C-001` cell after native confirmation and publication. The previously open destination-grid rendering check now passes.

The optional `--snapshot-pre-review` fixture reuses the existing record submit-for-approval HTTP route, actual `ApprovalProductService` template/publication/action engine and record-approval completion sink. Missing submit capability returns 403. An explicitly authorized Meta actor submits the imported record; a distinct Meta reviewer approves it through the real engine. Its actual persisted `approval.approved` outbox payload is delivered twice to the existing sink: one approved submission and exactly one completion notification remain. The imported record data/version remain unchanged.

The separate native process compares all fixture item ids, states, generations and properties with its pre-run snapshot and reports them unchanged, with zero native BOM write audits. Meta generic pre-review completion is therefore not treated as a PLM object mutation or native approval vote. No third approval engine or production source permission change was introduced.

Final real browser/HTTP proof nonce `vw20066t`: all sharing, rendered-grid, CSV permission/retention, unlink and pre-review assertions passed. PostgreSQL stopped, owned directory removed, native child stopped, proxy closed and Node cleanup all true. Two earlier synthetic runs exposed missing predecessor namespace-admission and directory/base columns; the actual admission migration and matching fixture columns resolved them without changing any gate. Failed proof/logs remain retained. Compact evidence: `artifacts/plm-managed-snapshot-share-20261019/pre-review-proof.json`.

This is source-process evidence with native SQLite and Meta PostgreSQL 15.17. Template setup and reviewer action call the real existing service; submission is authenticated HTTP; completion uses the real stored event and sink, not a deployed background worker. Existing fresh-Node publication retry proof remains separate. Actual CI16, installed images, complete migration chains, service-package lifecycle and customer/production acceptance are still open. Entire master goal remains incomplete; all PRs stay Draft.

## Exact-head CI fence census repair

Draft #6455 source16381a8d39659e8f59b244d8b1051c2e80401b3b completed its valuable jobs before this follow-up. Its record-ingress guard found12 failures. Source `9df4f21b2172b4176d47f85a66dd9f391dc4926e` repairs the exact call graph ledger left stale by extracting publishSnapshot. The independently executed unchanged census identified create/fenceWriterEntry through publishSnapshot, create/publishSnapshot through writeSnapshot, and managed complete/publishConsentedSnapshotOnQuery through publishSnapshot. Five former create-local call sites no longer exist at that scope.

Both publications match source/target identity, take the canonical sheet fence on the transaction query, install the fixed source field descriptors and pass that same query to writeSnapshot. Existing field type protection and target permission checks remain enforced. This follow-up records those concrete holders and their precise nested writers; it does not edit the analyzer, exclude a source, lower the holder floor, change mandatory helper rows or waive synthetic counterexamples. The anti-vacuity list now explicitly pins all three real entry-body writers including the original recovery entry.

Local RED:37 passed /12 failed. After the ledger correction:49 passed, zero failed/skipped. Original JSON reports and CI log are retained outside the checkout; compact receipt `artifacts/plm-managed-snapshot-share-20261019/fence-census-repair.json`. No product code changed in this repair and prior snapshot/target/PostgreSQL evidence is preserved. New remote exact-head CI is still required; local49 does not constitute overall CI or installed acceptance.

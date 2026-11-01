# Explicit user actors in audit messages

Source: `f2c0ce54a8b0ef60aabc379e46c27badf487fa34`. Parent local static increment: `7ddeab7129916ac7d8a0407790f51859a14a78d9`; its source is `25e0559c3e51cf3915cfe112add84bc98304a8ae`. The underlying remote Draft #6684 remains at `8d237dac8ef6f168353d7cf8806a878e026bd0e5`.

## Behavior

A UUID actor passed through `auditLog` previously became an undefined numeric `userId`. `AuditService` consequently published `who.actorType=system` and `who.actorId=system`. The parent data-source fix retains the authenticated UUID in that route's JSON audit metadata; this child fixes the independent in-memory message envelope.

`AuditLogData` now has optional typed `actorId` and `actorType` fields for publication. The wrapper supplies them only for an explicitly declared user with a nonblank actor string. It preserves the original string, the existing numeric conversion, the explicit `userId` property, metadata reference and nonblocking audit-failure handling. The publisher uses the explicit user actor for those two `who` fields; otherwise it retains its previous numeric/system expressions. Identity is never promoted from action metadata.

The normal string `42` keeps its existing user identity. Explicit `042` and `0` retain their original strings and user classification. A direct numeric `userId=0` without a valid typed user retains the older system/`0` fallback. Existing context fields, SQL, parameter arrays, row/schema types, topics, publication arguments and permission decisions are unchanged.

## Implementation and static evidence

Grok4.7 produced the three source changes and two unit-test changes in one persistent coding session. The first request was high effort; Root observed a Grok4.7 xhigh TUI footer. The test-simplification follow-up requested medium; its actual effort was not independently exposed in the retained final tail and remains UNKNOWN. The author's own report also records UNKNOWN effort. Backend deployment identity is UNKNOWN.

The first candidate was retained. Independent Sol high-requested static review found no source blocker; actual reviewer model/effort were not returned. The same Grok handle simplified repeated tests from 227 added wrapper lines and a 333-line bus spec to about 63 added wrapper lines and a 139-line spec, adding the metadata-only identity-spoof negative. The three source files remained byte-identical to the first reviewed candidate. Root added one independently reviewed assertion that disabled message publication still attempts exactly one repository audit write; the final bus spec is 140 lines.

The authored matrix adds 28 cases for UUID/raw strings, numeric compatibility, invalid typed identity, metadata spoofing and reference preservation, context overwrite/clear, and disabled publication. Old wrapper failure tests are byte-preserved except the declared standard-42 typed fields. The new files reside in the existing tests/unit path; actual discovery has not been run. No workflow or policy registration was changed.

Root verified the six private candidate members by SHA256 and byte length, matching the author's final idle/done state. Candidate ZIP `5fee405ecda9200fb1a404100753bf7aed880df6b82f07c294e2969191a995cc` plus the declared Root assertion identify the integration. The V2 author's report retains a stale snapshot-v1 label; Root's SHA-bound records explicitly distinguish it. `git diff --check` passed. Tests, type checking, build, HTTP/PG, installation and new CI are **NOT_RUN**. Static review is not execution acceptance.

The CLI retained only a bounded terminal-history tail. An oversized export failed, and a cursor-zero export correctly detected a lost prefix; both failures are preserved. The complete Grok command history is therefore not independently archived. Root ran no product checks and the author reports static-only work; no full runtime, no-side-effect or business qualification is claimed from this code task.

## Delivery boundary

This source and one closeout document are local commits only, with no push or new PR/CI execution under the current static-only instruction. The parent source/document commits and original Native425/Meta6425/Meta6684 heads are unchanged. Future results belong in state and PR bodies, without result-only commit loops. Main was observed as `b0fc545ce696d2edbfbbd9c0bc3a21bc04bcdb2b`; these local increments are stacked and not rebased-main claims.

The added fields do not become database columns. UUID `audit_logs.user_id` may remain NULL; the parent's ordinary data-source metadata retains that string. UUID database query/aggregation, generic context concurrency and a complete audit identity model are outside this patch. The prior compiled/migration artifacts do not include either new local actor increment.

The existing lease and every HOLD remain. Product services, DB/test/build/install environments, browser, grants/BOM operations, merge, deployment and production actions are not authorized by Grok tool restoration. All seven delivery packages remain open.

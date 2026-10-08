# Attendance Issue #4556 W6-1 Development Report

> Status: **RECORD / PRE-MERGE GATE**. This report describes the W6-1 backend
> aggregate implemented in PR #4849. It is not runtime, flag, staging,
> deployment, soak, production-data, customer-data, or issue-close authority.
>
> Date: 2026-08-12
>
> Ratified contract:
> `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`
>
> Fresh base: `origin/main@24794811b1c800402006b30d6e4fa9df670e124e`
> (the owner-authorized catch-up baseline after PR #4804)
>
> Implementation and test evidence head before this record-only report delta:
> `d951b9e3da27a2b07615c5139c7e64edf656d104`

## 0. Scope delivered

W6-1 delivers the backend-only, GET-only group effective-policy aggregate
authorized by the ratified W6 lock. It does not deliver W6-2 OpenAPI wiring,
W6-3 UI, W6-4 whole-W6 closeout, W7 calculation cutover, or W8 closure.

| Surface | Delivered behavior |
| --- | --- |
| Route | `GET /api/attendance/groups/:groupId/effective-policy` under `attendance:admin` |
| Principal scope | Organization comes from the authenticated principal; query/body/header org selectors are byte-equality assertions only and cannot replace it |
| Delegated admin | Active target-org membership is required after the route RBAC guard |
| Transaction | The handler's post-guard platform-admin lookup, delegated membership check, aggregate reads, and FSER reads share one PostgreSQL `READ ONLY` transaction-bound query handle; `rbacGuard` performs its permitted middleware reads before that transaction |
| Response | Exact-key, values-free aggregate with closed labels, domains, conflict codes, reason codes, and editor references |
| FSER | Existing fixed-schedule effectiveness service is composed; W6 does not rederive or persist a second status |
| Conflict handling | Membership overlap is reported as a count and `conflict_action_required`; no winner is selected |
| Runtime loading | Three plugin attendance libraries resolve through one closed-set, repo-root-anchored, symlink-rejecting resolver |
| Compatibility | A fixed strict shift with zero persisted segment rows keeps the W3 legacy-envelope single-segment reading |
| CI | All three W6 real-DB suites are in the attendance database run list and no-DB exclusion; the workflow provenance pin was mechanically recomputed after adding the fixture matrix |

## 1. Implementation surfaces

| Layer | Files |
| --- | --- |
| Aggregate | `packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts` |
| Runtime contract | `packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts` and `w6-group-effective-policy-response-contract.ts` |
| Route and transaction binding | `packages/core-backend/src/routes/attendance-admin.ts` |
| Transaction-aware RBAC helper | `packages/core-backend/src/rbac/service.ts` |
| Plugin library resolver | `packages/core-backend/src/util/resolve-plugin-attendance-lib.ts` |
| Existing FSER composition | `plugins/plugin-attendance/index.cjs` plus the producer-key helper |
| Contract draft | `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` |
| Required CI | `.github/workflows/plugin-tests.yml`, `packages/core-backend/vitest.config.ts`, `scripts/ops/attendance-w4c2-ci-wiring.test.mjs`, and the sealed-export provenance pin |

The OpenAPI file remains under `drafts/`; moving it into the generated API is
W6-2 and is intentionally absent from this slice.

## 2. Red-line implementation map

| Lock rule | Implementation mechanism |
| --- | --- |
| W6-R1 | The route is GET-only. The service is constructed per request with the transaction query handle. PostgreSQL `SET TRANSACTION READ ONLY` is the mechanism of record; a derived static call-path sweep is a secondary guard. |
| W6-R2 | The response validator enforces exact recursive key sets and values-free fields. Membership overlap leaves the service as a count, never a member list. |
| W6-R3 | `rbacGuard` is attached at route registration and may perform its permitted RBAC reads before the handler transaction. Principal org resolution and selector mismatch checks precede aggregate SQL. The handler's post-guard platform-admin lookup and delegated membership checks use the same read-only query handle as the aggregate. |
| W6-R4 | The aggregate receives the existing FSER service. Caller and producer-key inventories reject a second derivation or producer-key spelling. |
| W6-R5 | Import-graph and call-path guards reject calculation-writer consumption. Overlap fixtures require conflict reporting instead of choose-first/choose-latest behavior. |
| W6-R6 | Runtime validators reject unknown labels, domains, conflict codes, reason codes, group types, rollout states, and editor-reference members. |
| W6-R7 | State-selecting query parameters and state-bearing body fields are rejected before aggregate SQL. An optional single query/body/header `orgId` is accepted only when it byte-equals the authenticated principal; mismatch or duplicate-query ambiguity is 403. Labels use persisted facts plus rollout posture. |
| W6-R8 | Editor references use the ratified two-kind closed union and existing route/stage spellings. |
| W6-R9 | The pre-anchor procedural violation remains recorded in the ratified lock. A separate owner instruction authorizes only this PR's Ready/squash merge after fresh checks and an exact-head 0 P1/P2 gate; it does not authorize W6-2/3/4 or runtime action. |

## 3. Model allocation by difficulty

The model calls are advisory or independent gates. Codex retains scope,
integration, evidence, and final-verdict ownership.

| Model | Assigned work |
| --- | --- |
| Kimi K3 | Attack test and CI evidence intake: skipped tests, stale pins, unreachable or duplicate invocations, path/glob variants, and guards that read a different input than production executes |
| Grok 4.5 | Review the highest-risk runtime boundaries: shared transaction ownership, auth/org ordering, values-free output, FSER composition, and resolver containment |
| GPT-5.6 Sol | Final code-focused adversarial gate on the exact PR head; findings are blocking at P1/P2 |
| GPT-5.6 Terra | Final evidence/claim/scope gate on the exact PR head, including these reports and PR-body accuracy |
| Codex | Fresh-main integration, mechanical pin regeneration, real-DB execution, independent source review, fixes, GitHub checks, and the final Draft/HOLD disposition |

An analysis made against an older head is discovery evidence only. It cannot
approve the post-#4804 head and must be reproduced or refuted on the exact
final head before it affects the verdict.

## 4. Fresh-main integration

PR #4849 was caught up after PR #4804 landed and again after the temporary main
freeze was renewed. The final integration merge used
`24794811b1c800402006b30d6e4fa9df670e124e` as the owner-authorized fresh base.
The intervening main commit and the PR had zero changed-file overlap. The
workflow file, no-DB exclusion, and attendance run list merged without semantic
conflict. Adding the third real-DB suite then changed the workflow bytes, so the
complete sealed-export provenance JSON was mechanically recomputed from the
resulting tree and now carries
`evidenceFiles.pluginTestsWorkflow = b689c385336cdc7c05d77086f9b6b147f7f40b5d2d9c3c48a1593e6c561585d6`.

The runtime/test implementation delta before the two report files is 33 files;
the exact base-to-report-head delta is 35 files. No migration, feature flag,
rollout-state mutation, staging action, deployment action, or customer data is
part of that delta.

The final discovery gates on the pre-report implementation head found four
material gaps. The evidence head closes them without widening the slice:

- the plugin-library closed-set guard now derives every tracked backend source
  file and parses resolver calls through the TypeScript AST, including nested
  arrow-function generics and non-literal fail-closed behavior;
- production files that may name FSER without composing it are occurrence
  pinned to zero factory calls;
- `RULE_SOURCE_MISSING` is now emitted through the ratified conflict channel;
- the runtime response validator now matches the OpenAPI UUID and positive
  managed-row-count constraints, and the platform-admin positive leg uses the
  real transaction-bound PostgreSQL role lookup rather than a legacy claim.

A later independent review round against report head
`89b3fff8cdd8d8b53a37277f6142ae83fb648fb4` found two additional P2 gaps. That
older-head review is discovery evidence only. Evidence head
`c9005abe8c7d8efcabe0fdadd327635c3b4e121b` closes the implementation gaps:

- a delegated caller without active target-organization membership now receives
  the same exact values-free `404 NOT_FOUND` shape as a missing or inaccessible
  group, while selector mismatch remains a distinct pre-SQL `403`;
- fifteen named indirect or computed DB-seam spellings now fail closed as
  static findings instead of disappearing from all classification buckets.
  PostgreSQL `READ ONLY` remains the structural mechanism of record.

Because those changes modify the reviewed head, no review result bound to
`89b3fff8cdd8d8b53a37277f6142ae83fb648fb4` transfers to the final gate.

The first independent gate against later report head
`a5738017edd2698db5fbda6a2aa73011ad5ba461` found two further technical P2s and
one governance P2. Evidence head `413271e2d7a14aa21a9c5be48001d9c15c432b5d`
closes the technical pair:

- query/body/header organization selectors now share one byte-equal-or-403
  rule, while unrelated state selectors retain typed 400 rejection;
- a dedicated disposable PostgreSQL suite reproduces all eight §4.3 fixtures
  from seeded rows with the canonical FSER and exact-key `toStrictEqual`.
  That exercise also corrected the unpublished-only fixture to canonical FSER
  semantics: `unpublishedManagedRows` carries the count while configured-group
  `managedSets` remains limited to published different-key rows.

The governance P2 is the ratified §7.2 delegated-non-member `403` text described
below. This PR does not silently self-amend that lock.

The next exact-head evidence gate at
`4d2a9b217880290d33a92b9508e14ba469fca3f0` found that the newly added
real-DB fixture suite legitimately loaded the canonical FSER but was absent
from the exact test-caller inventory. That made two inventory assertions fail
and invalidated the reported `300 / 300` result at that head. Evidence head
`d951b9e3da27a2b07615c5139c7e64edf656d104` adds that one exact test-file
identity to the existing closed set; it adds no directory exemption and does
not change either production composition-site pin. The inventory then passed
`8 / 8`, and the complete 12-file matrix passed `300 / 300`.

## 5. Explicit residuals

These are not represented as W6-1 guarantees:

1. PostgreSQL `READ ONLY` structurally rejects writes but uses the repository's
   existing default isolation level. W6-1 does not claim repeatable-read
   snapshot semantics across separate SELECT statements.
2. The aggregate may load member identities internally to compute the ratified
   count-only result. The response contract, not zero internal IDs, is the
   W6-R2 guarantee.
3. The plugin resolver is deliberately closed to three files. Adding another
   plugin attendance library requires an explicit closed-set edit and tests.
4. W6-2 contract publication, W6-3 UI, and W6-4 whole-W6 verification remain
   separate gated slices.
5. Date-only response fields are checked for the closed `YYYY-MM-DD` lexical
   shape. Calendar-valid production values remain a producer/database
   invariant; W6-1 does not claim that its response validator rejects every
   lexically valid but impossible calendar date.
6. The secondary DML seam detector is a bounded AST grammar, not a complete
   JavaScript data-flow proof. Opaque higher-order returns, arbitrary identity
   functions, and object-spread propagation are outside that grammar. The
   report makes no static-proof claim for those forms; PostgreSQL `READ ONLY`
   is the W6-R1 mechanism of record.
7. The ratified lock contains an unresolved textual contradiction: normative
   W6-R3 and endpoint §4.1 require one values-free `404` for missing and
   inaccessible groups, while completion-skeleton §7.2 still says delegated
   non-member `403`. The implementation follows W6-R3/§4.1. This report does
   not amend the ratified lock or claim the stale checklist text is resolved.

## 6. Stop condition

The owner-authorized end state for this landing is:

- PR #4849 remains Draft/HOLD until fresh exact-head checks and independent
  gates are recorded;
- only after those gates report zero P1/P2, PR #4849 may become Ready and
  squash-merge;
- the lane stops after presenting the exact merge SHA;
- no runtime, flag, deployment, staging, soak, production/customer data, or
  issue #4556 close action is performed.

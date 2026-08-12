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
> `39d9a969e4d36f6600a51b8cb7a527d39fce34cd`

## 0. Scope delivered

W6-1 delivers the backend-only, GET-only group effective-policy aggregate
authorized by the ratified W6 lock. It does not deliver W6-2 OpenAPI wiring,
W6-3 UI, W6-4 whole-W6 closeout, W7 calculation cutover, or W8 closure.

| Surface | Delivered behavior |
| --- | --- |
| Route | `GET /api/attendance/groups/:groupId/effective-policy` under `attendance:admin` |
| Principal scope | Organization comes from the authenticated principal; client selectors cannot replace it |
| Delegated admin | Active target-org membership is required after the route RBAC guard |
| Transaction | The handler's post-guard platform-admin lookup, delegated membership check, aggregate reads, and FSER reads share one PostgreSQL `READ ONLY` transaction-bound query handle; `rbacGuard` performs its permitted middleware reads before that transaction |
| Response | Exact-key, values-free aggregate with closed labels, domains, conflict codes, reason codes, and editor references |
| FSER | Existing fixed-schedule effectiveness service is composed; W6 does not rederive or persist a second status |
| Conflict handling | Membership overlap is reported as a count and `conflict_action_required`; no winner is selected |
| Runtime loading | Three plugin attendance libraries resolve through one closed-set, repo-root-anchored, symlink-rejecting resolver |
| Compatibility | A fixed strict shift with zero persisted segment rows keeps the W3 legacy-envelope single-segment reading |
| CI | Both W6 real-DB suites are in the attendance database run list and no-DB exclusion; the workflow provenance pin was mechanically recomputed after fresh-main catch-up and remained byte-identical |

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
| W6-R7 | Query parameters and state-bearing body fields are rejected before aggregate SQL. Labels use persisted facts plus rollout posture. |
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
conflict. The complete sealed-export provenance JSON was mechanically
recomputed from the resulting tree; it was byte-identical to the pinned file,
including `evidenceFiles.pluginTestsWorkflow = be00b174108df71c67bdfd971af2098b00b0149cf6a08be45770d2f3b981e461`, so no
pin-only diff was manufactured.

The runtime implementation delta before the two report files is 31 files; the
exact base-to-report-head delta is 33 files. No migration, feature flag,
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

## 6. Stop condition

The owner-authorized end state for this landing is:

- PR #4849 remains Draft/HOLD until fresh exact-head checks and independent
  gates are recorded;
- only after those gates report zero P1/P2, PR #4849 may become Ready and
  squash-merge;
- the lane stops after presenting the exact merge SHA;
- no runtime, flag, deployment, staging, soak, production/customer data, or
  issue #4556 close action is performed.

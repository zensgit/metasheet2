# CI execution ledger P0 design lock

## Authorized scope

Frozen baseline: `42984091d7fe0e4f81ac026243200840c314bb79` (fresh origin/main at task start and publication preflight). P0 adds offline execution-ledger and failure-propagation tools/tests only. Existing workflows, runner scripts, package scripts, test configurations, tests and required gates stay byte-identical. On 2026-10-15 the owner separately authorized committing, publishing this branch, creating a Draft PR and running existing CI. This does not authorize activation as a CI gate. No scheduling changes, DB jobs, installs on this disk-constrained host, merge, deployment, real data/CI variables/protection writes.

This is preparatory source-contract evidence, not proof that GitHub executed tests, not an active CI gate, and not an acceleration claim. Later activation or P1/P2 scheduling is separate scope. Existing test entry points must not be edited or weakening guards introduced to integrate P0 now.

## Inputs and exact preservation

Freeze the Plugin/Web workflow and complete required-web runner inputs independently of any proposed worker list. Use the existing fail-closed YAML parser, not a new regex YAML reader. Record source SHA/digests, workflow trigger/concurrency/environment semantics, every job's identity/name/matrix/needs/conditions/runner/services/environment/defaults and ordered steps, including command/uses/condition/environment/shell/cwd/error handling. Retain complete shell command blocks and the entire Web runner bytes/digest rather than claim a hand-written shell parser proves collected test cases. Preserve invocation grouping, args, order and multiplicity; repeated invocations are not deduplicated. Input/config drift must fail exact comparison and require explicit reviewed baseline renewal, never auto-ratify from the candidate under test.

Store a values-free frozen baseline ledger or digest manifest for this exact commit, independent of candidate generation. Do not copy hosts, literal database URLs, credentials or business values into public ledgers/errors. Structural hashes may bind secret-bearing blocks without exposing their contents. Baseline generation must be explicit; checks cannot silently overwrite it. Missing files, malformed schema, malformed YAML and unsupported/unknown statuses fail closed with stable codes, not raw input echo.

No claim of actual case collection: the source ledger binds commands/configuration, not Vitest runtime titles, browser behavior, dynamic shell expansion or DB fixture independence. Future runtime case/invocation multiset evidence remains required before scheduling changes.

## Offline worker and receipt contract

An independently supplied, nonempty expected worker identity/dependency inventory binds required checks. Reject missing/duplicate identities or dependency edges, orphan workers, cycles, ambiguous required-name producers and unsupported conditions where semantics cannot be established. All expected results must be exact success; failure, skipped, cancelled, missing or unknown cannot produce acceptance. Whole-workflow cancellation is never accepted even when no aggregator runs.

Execution receipts must be exactly one per expected worker, nonempty and bound to the expected current SHA, run, attempt and configuration/ledger digest. Reject stale, missing, duplicate, extra or empty evidence and incompatible schemas/statuses. Receipt presence is not authentication or proof of actual GitHub execution. Offline fixtures represent possible future aggregation; they do not replace current required gates or authorize accepting arbitrary uploaded receipts in production.

Freeze expected identities independently of observed results, so deleting a worker from both observed results and receipts cannot self-ratify. Invocation execution multisets must retain each identity/config/flags/group/occurrence; missing, repeated or altered invocation evidence fails, not just a changed set of filenames.

## Acceptance gates

| Gate | Required evidence |
|---|---|
| Baseline identity | Generated once from frozen Git objects; independent candidate check passes; source/config mutation fails |
| Command preservation | Complete workflow/Web-runner source binding; no claim of a general shell parser or runtime collection |
| Failure contract | Positive control plus removed worker/edge, failure, skip, cancellation, unknown, missing/stale/duplicate/extra receipt, empty worker/invocation and changed config negatives |
| Mutation | At least two actual load-bearing guard mutations turn matching assertions red; original bytes restored and positive control rerun |
| Independent review | Sol 6.1 medium refute-first review; concrete findings fixed or explicitly HOLD |
| Target runtime | Focused Node20 checks and existing parser neighbor on dedicated Mac mini source; quality where feasible; exact results documented |
| No scheduling drift | Existing `.github/workflows`, required runner, package scripts, test/config trees unchanged against baseline |
| Documentation | Development/verification MD with commands/counts/model evidence and limits; no publication/deployment claims |

Prefer one small module and focused node:test files. No dependencies or generic orchestration framework. Validation errors and reports are values-free. Implementation via Grok 4.7 medium, independent review via Sol 6.1 medium, verified per-session rather than changing global model settings.

# Approval T3-3 node signature/compliance — declared-inert first rung — Verification 2026-07-05

## Task vs. reality

The task assigned to this agent was: build the T3-3 declared-inert first rung (persist/round-trip
`signaturePolicy`, no enforcement) as a **new** runtime PR against a fresh `origin/main`, branch
`claude/build-t3-3-signature-declared-inert-20260705`.

On checking out the fresh grounding SHA (`origin/main@4640f366217ed793a07116eaa26c60edfb6c6642`),
the runtime already existed: it was built and merged in PR
[`#3512`](https://github.com/zensgit/metasheet2/pull/3512) ("feat(approval): T3-3 node
signaturePolicy (declared-inert slice 1)", merged commit `b6947a481`, 2026-07-03T05:42:31Z) — two
days before the owner's formal T3-3 vote landed on `main` (commit `16461152f` / PR `#3590`,
2026-07-05). The ratified ballot defaults match what `#3512` shipped line-for-line (Q1-Q9 all
adopt-default; PR body independently describes the same declared-inert, no-enforcement,
no-new-audit-action floor).

**This PR does not re-build the runtime.** Duplicating already-merged code would conflict with and
shadow the existing implementation for no benefit. Instead, this PR:

1. Independently re-verifies the already-shipped rung against the build contract (below), since no
   design/verification doc pair existed for it.
2. Adds the two docs the repo's convention calls for
   (`docs/development/approval-node-signature-declared-inert-{design,verification}-20260705.md`),
   which were missing.
3. Flags one governance gap in `#3512` for human attention (see [Process note](#process-note)).

No source files under `packages/core-backend/src` were touched by this PR.

## What already exists (re-verified, not re-built)

Files from `#3512` (unchanged by this PR):

- `packages/core-backend/src/types/approval-product.ts` — `SignaturePolicy` interface;
  `signaturePolicy?: SignaturePolicy` added to `ApprovalNodeConfig`.
- `packages/core-backend/src/services/ApprovalProductService.ts`:
  - `normalizeNodeSignaturePolicy` (~line 983) — shape-only normalizer: `required` must be
    boolean; `kind` contract-open non-empty string; `appliesTo` ∈ `{approve, approve_reject}`;
    unknown keys rejected; fails closed via `failValidation` (never coerces/drops silently).
  - Wired into the node-config whitelist inside `normalizeApprovalGraph` (~line 1367):
    `...(signaturePolicy ? { signaturePolicy } : {})` — same pattern as the existing
    `fieldPermissions` / `timeout` fields.
  - Confirmed by code trace that the round-trip crosses all four stages the build contract names:
    - **normalize**: `normalizeApprovalGraph` on template create/update.
    - **publish**: `publishApprovalTemplateVersion` re-reads the stored version via
      `asApprovalGraph` (which calls `normalizeApprovalGraph` again with `STORED_GRAPH_CONTEXT`)
      before calling `buildRuntimeGraph`, which deep-copies the full node config (including
      `signaturePolicy`) into `approval_published_definitions.runtime_graph`.
    - **reload**: `GET /api/approval-templates/:id` returns the normalized stored graph.
    - **dispatch re-normalize**: every read of `runtime_graph` (instance creation, admin-jump,
      resume) goes through `asRuntimeGraph`, which calls `assertApprovalGraph` →
      `normalizeApprovalGraph` again — i.e. the signature policy is re-validated/re-normalized on
      every dispatch-time load, not just cached from publish time.
- `packages/core-backend/tests/integration/approval-node-signature-policy.api.test.ts` — the
  fail-first golden (see below).
- `packages/core-backend/vitest.config.ts` — test file added to the no-DB-job exclude list (with a
  comment explaining why), so it can't silently skip-green.
- `.github/workflows/plugin-tests.yml` (line ~352) — the test file is wired as a **whole-file** run
  inside the existing "Run approval real-DB integration" step, alongside the other
  `describeIfDatabase`-gated approval real-DB tests. Already on `main`; no CI change needed.

## The fail-first golden

**Test file:** `packages/core-backend/tests/integration/approval-node-signature-policy.api.test.ts`
**Suite:** `T3-3 node signaturePolicy (declared-inert) API` (`describeIfDatabase`-gated on
`DATABASE_URL`, real HTTP against a real `MetaSheetServer` + real Postgres — mirrors the sibling
`approval-node-sla-remind.test.ts` / `approval-nofm-threshold.test.ts` harness pattern).

6 tests:

1. `sentinel: DATABASE_URL is set` — fail-loud guard so the suite cannot silently skip-green.
2. **`persists + round-trips signaturePolicy through create → publish → reload byte-identically`**
   — this is the build-contract discriminator. Creates a template with
   `signaturePolicy: { required: true, kind: 'typed', appliesTo: 'approve_reject' }` on an
   `approval` node, asserts it survives create, publishes, then re-`GET`s the template and asserts
   the reloaded graph's node config still has the exact same `signaturePolicy` object.
3. `leaves a node with NO signaturePolicy byte-identical (default-absent, key omitted)` — asserts
   `signaturePolicy` is entirely absent (`not.toHaveProperty`), not `null`/`undefined`-valued.
4. `preserves required:false as an explicit policy value (not omitted as default-absent)` — guards
   against a falsy-coalescing bug that would conflate `{required:false}` with "no policy".
5. **`is DECLARED-INERT: a required signaturePolicy does NOT block approve (no signature
   supplied)`** — the Q2 discriminator. Publishes a template whose node has
   `signaturePolicy: { required: true, kind: 'typed' }`, starts an instance, and approves with
   **no** signature payload at all — asserts `200`/`approved`. This is the test that would need to
   change (and only via a separately-ratified rung) if enforcement were ever added.
6. `rejects a malformed signaturePolicy at publish (non-boolean required / bad appliesTo / unknown
   key)` — three fail-closed cases (`required: 'yes'`, `appliesTo: 'always'`,
   `captureMode: 'typed'` unknown key), each asserts `400`.

### RED-condition — independently reproduced in this task

I reverted the single whitelist-emit line in `normalizeApprovalGraph`
(`...(signaturePolicy ? { signaturePolicy } : {}),`) in a scratch copy, leaving everything else
(the type, the normalizer function, the test) untouched, and reran the suite against a real
Postgres instance:

```
DATABASE_URL=postgres://metasheet:metasheet@localhost:5435/metasheet_test \
  pnpm exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-node-signature-policy.api.test.ts --reporter=dot
```

Result: **2 of 6 tests failed** (the round-trip test and the `required:false` explicit-value
test), both with `expected undefined to deeply equal {...}` — i.e. the policy is silently dropped
by normalize when the whitelist emit is removed, which is exactly the sound discriminator the
build contract calls for (round-trip breaks → test goes RED, not skipped, not falsely green). I
then restored the file exactly (`git status` on the file is clean).

### Green re-run (unmodified `origin/main`)

Same command against the unmodified code: **6/6 passed** in 408ms. `tsc --noEmit` on the whole
`core-backend` package: **0 errors**.

Local harness used: Postgres 15 (via the repo's `docker-compose.dev.yml` dev container, port
5435), a scratch `metasheet_test` database, migrated with
`MIGRATION_EXCLUDE` matching `.github/workflows/plugin-tests.yml`'s CI value.

## Declared-inert proof

- `grep`-level: no call site anywhere in `src/` reads `signaturePolicy` except
  `normalizeNodeSignaturePolicy` itself (the normalizer) and the type declaration. There is no
  `if (signaturePolicy...)` gate anywhere near the approve/reject action handlers.
- Test 5 above exercises exactly this: `required: true` + zero signature payload on the actual
  `POST /api/approvals/:id/actions` approve path still returns `200`.
- This is inert **by construction**, not by a flag: there is no enforcement code path to disable.
  A later rung would need to *add* new gating logic (and presumably flip test 5's expectation, or
  add a new enforcement-mode test) — nothing here can be "switched on" by an operator today.

## What is explicitly NOT built (unchanged from `#3512`, confirmed still true on grounding SHA)

- Enforcement / blocking of approve or reject on signature policy (Q2 — separately ratified rung).
- Image/handwritten signature capture, `StorageService` wiring (Q3).
- sha256 integrity binding (Q4).
- Retention/legal-hold semantics (Q5).
- PII-redacted reader view / compliance-export gate (Q6).
- New audit action or CHECK migration (Q8) — nothing is captured yet, so there is nothing to log.
- Authoring UI of any kind (Q9) — backend-only floor.

## Process note

`#3512`'s PR body does not carry an adversarial-review warning banner and is already merged
(2026-07-03), predating both the ballot's formal T3-3 vote and this documentation task. A human
reviewer should be aware that runtime for this rung reached `main` without that disclaimer — this
task cannot retroactively unmerge or re-review it, only flag it. Independent re-verification in
this document (RED-condition reproduction, dispatch-path code trace, fresh local 6/6 run, `tsc`
clean) is offered as after-the-fact adversarial-style scrutiny of what shipped.

## What I could not verify

- I did not run the full CI matrix (lint, full `core-backend test`, full multitable/approval
  real-DB batteries, web build, plugin smoke) — only the single golden test file plus `tsc
  --noEmit`, both green. CI on the eventual PR will exercise the rest.
- I did not attempt to reconstruct whatever local/CI state existed at the time `#3512` merged; my
  verification is against the current `origin/main` tip (`4640f366217ed793a07116eaa26c60edfb6c6642`)
  only.

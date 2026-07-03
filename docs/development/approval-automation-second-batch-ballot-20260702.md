# Approval & Process-Automation — second-batch per-rung decision ballot (2026-07-02)

> **Status: EXECUTED / CLOSED DECISION RECORD (as-built reconcile 2026-07-03).** All four second-batch
> rungs were voted GO on their recorded defaults or owner-steered amendments and are **SHIPPED**:
> T1-2 signed inbound webhook `#3489` (`fadf1695e`), T2-1+2 scoped admins + handover `#3490`
> (`2ebb8dd81`), T1-4 field-permissions authoring `#3505` (`df8d43bf9`), and T3-5 W7 cross-base
> resultWriteback `#3506` (`e80f622e5`). The tables below are now historical decision records, not
> open votes.
>
> Source of truth for the defaults is `approval-automation-decision-register-20260629.md`, with reviewer
> notes folded into the "build contract" blocks below so implementation does not repeat known blind spots.
> This is **per-rung**, not blanket approval: these four items mix unauthenticated ingress, cross-base writes,
> permission migrations, and approval field-visibility semantics.
>
> The product/governance-heavy tail is intentionally not mixed into this implementation batch. It lives in
> `approval-automation-third-batch-ballot-20260702.md` (A3 destination authorization, business-calendar SLA,
> signature/compliance, mobile approval surface, and S-band approval-as-records).

## Recommended lane order

| Lane | Order | Why |
|---|---|---|
| C — automation engine (`automation-service.ts`) | ~~`T1-2 inbound webhook`~~ **done #3489** → ~~`T3-5 W7 cross-base backwrite`~~ **done #3506** | Both touched automation runtime and security gates; shipped sequentially to avoid hot-file collisions. |
| B — approval engine / authoring | ~~`T2-1+2 scoped admins + handover`~~ **done #3490** → ~~`T1-4 field permissions`~~ **done #3505** | Permission/handover was the larger admin model slice; field-permission authoring stayed bounded and did not unlock edit-form-at-node. |

## T1-2 — inbound webhook endpoint (signed, audited) · M · Lane C first

> **SHIPPED `#3489` (`fadf1695e`)** on the defaults below — closed decision record, not an open vote.

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | Signature scheme | HMAC-SHA256 over `"${unixSeconds}.${rawBody}"`; header `X-MS-Webhook-Signature: sha256=<hex>` plus `X-MS-Webhook-Timestamp`; compare with `timingSafeEqual`. This intentionally differs from outbound body-only signing so timestamp replay is bound. | ✅ SHIPPED #3489 |
| Q2 | Secret-less rules | Fail-closed: unsigned / secret-less inbound rules are not ingestable; enforce non-empty secret at create/update for `webhook.received`. Existing secret-less rules are blocked on edit and return uniform reject at ingest. | ✅ SHIPPED #3489 |
| Q3 | Reject oracle | Uniform `401 { ok: false }` for unknown rule, wrong trigger type, disabled rule, missing secret, stale timestamp, and bad signature. No existence/enabled-state oracle. | ✅ SHIPPED #3489 |
| Q4 | Replay defense | Signed timestamp with ±300s freshness window. No nonce/dedup table in v1; residual in-window replay risk documented. | ✅ SHIPPED #3489 |
| Q5 | Dispatch authority | Execute userless under `rule.created_by`, same as scheduled triggers. The rule author's authority is the authority for side effects. | ✅ SHIPPED #3489 |
| Q6 | Secret at rest | Plaintext parity with outbound webhook secret in `trigger_config` for v1; any read API that exposes trigger config must redact the secret. Encryption-at-rest deferred. | ✅ SHIPPED #3489 |
| Q7 | Rejected-attempt observability | Accepted requests use existing redacted `AutomationExecution`; rejected attempts get structured security logs + `automation_webhook_rejected_total{reason}` metric. No new audit table. | ✅ SHIPPED #3489 |
| Q8 | Dispatch timing | Synchronous inline dispatch, returning 202 after executor completion. No queue in v1. | ✅ SHIPPED #3489 |
| Q9 | Rate/body limits | Per-rule rate limit via existing `RateLimitStore` (default 60/min/rule) and 1 MB body cap on the inbound path. | ✅ SHIPPED #3489 |

**Build contract / reviewer-note must-fixes**

- Save-boundary test: `createRule` and `updateRule` reject `webhook.received` with empty secret.
- Mounted route rejects non-object top-level JSON, arrays, primitives, and empty body.
- Signature verifier strips the `sha256=` prefix before constant-time comparison.
- Caller-controlled `recordId` / `sheetId` / actor fields in the body cannot target records or impersonate users.
- Uniform-reject tests cover unknown rule, disabled rule, wrong trigger, bad signature, stale timestamp, missing secret.
- Accepted request test uses the real mounted route + real DB execution row, not a hand-built service call.

## T3-5 — W7 cross-base resultWriteback · L · Lane C after T1-2

> **SHIPPED `#3506` (`e80f622e5`)** on the defaults below, plus the review hardening that a target triple
> resolving back to the source base fails closed instead of becoming a same-base arbitrary-record write. Closed
> decision record, not an open vote.

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | Effective actor for cross-base gate | Use the original trigger actor from `bridge.triggerEvent`, matching executor cross-base writes. Null/system approvals fail closed for cross-base backwrite. Same actor is used for target-record lock checks. | ✅ SHIPPED #3506 |
| Q2 | Target record addressing | Literal target triple only: `targetBaseId` + `targetSheetId` + `targetRecordId` on `resultWriteback`. Dynamic link-field target resolution is a named follow-up, not v1. | ✅ SHIPPED #3506 |
| Q3 | Audit/provenance | No new audit table in v1. Extend the `start_approval` step output with target base/sheet/record ids; omit actor from target-base realtime fan-out, matching cross-base privacy posture. | ✅ SHIPPED #3506 |
| Q4 | Save validation | If any target id is present, require the full triple at save. Defer target field-type/read validation to runtime; do not block save on author's target-base write authority. Runtime re-checks trigger actor authority every run. | ✅ SHIPPED #3506 |
| Q5 | Quota | Share the singleton per-target-base cross-base write quota with update/create/delete/lock. A blocked/not-found attempt still consumes a slot, matching existing executor posture. | ✅ SHIPPED #3506 |

**Build contract / reviewer-note must-fixes**

- Anti-misroute test: same-base source record is not mutated when cross-base target is configured.
- Authority fail-closed test uses real DB and trigger actor, not request actor or approval actor.
- Tail context test asserts cross-base patch is **not** merged into source `recordData` unless explicitly designed later.
- Re-run existing cross-base write-gate suites after extracting/reusing gate helpers.
- Document resume retry behavior: quota may be re-consumed on retry unless a separate idempotent cross-base backwrite ledger is introduced.

## T2-1+2 — scoped approval admins + handover/bulk reassign · L · Lane B first

> **SHIPPED `#3490` (`2ebb8dd81`)** on the defaults below — closed decision record, not an open vote.

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | Meaning of "scoped" | Capability split only. Add global capability codes for template admin, process/recovery admin, and data-recovery admin. Department/category/template-set data scoping is deferred. | ✅ SHIPPED #3490 |
| Q2 | Who may reassign and to whom | Process/recovery scope (`approvals:admin`) may reassign active user-typed assignments. Target must not be requester and must not already be an active assignee at the node. Full audit required. | ✅ SHIPPED #3490 |
| Q3 | Permission-code naming | Keep codes under non-namespaced `approvals`: `approvals:admin`, `approvals:admin-templates`, `approvals:admin-data`. Accept `approvals:*` wildcard granting all three. Fix `APPROVAL_PRODUCT_PERMISSIONS` drift in the same change. | ✅ SHIPPED #3490 |
| Q4 | Batch atomicity | Per-instance transactions, best-effort manifest `{ succeeded, skipped }`. Re-run skips no-longer-assigned instances; no batch dedup table. | ✅ SHIPPED #3490 |
| Q5 | Source set and cap | Caller may pass explicit `instanceIds`; if omitted, enumerate active user assignments for `fromUserId`, tenant/platform-scoped, excluding role-typed assignments, capped at 200. | ✅ SHIPPED #3490 |
| Q6 | Audit action + version | Add new `reassign` audit action via CHECK migration; bump `approval_instances.version` per affected instance. Do not reuse `transfer` because revoke-window semantics count transfer as handled. | ✅ SHIPPED #3490 |
| Q7 | Multi-node / parallel handling | Reassign all active user-typed assignments for the source user across every node/branch in each selected instance; one audit row per `(instance,node)`. | ✅ SHIPPED #3490 |
| Q8 | Literal swap vs re-resolution | Literal swap to a static user assignment. Drop dynamic/delegation metadata intentionally; stamp `metadata.reassignedFrom` and `metadata.adminReassign=true`. | ✅ SHIPPED #3490 |
| Q9 | Notifications/events | Refresh counts for source user, target user, and affected requesters; emit `approval.bulk_reassigned` with the manifest. | ✅ SHIPPED #3490 |
| Q10 | Grants and down migration | Grant new codes to `admin` role in `up()`. `down()` removes role grants/permissions and restores the action CHECK using the established NOT VALID pattern. | ✅ SHIPPED #3490 |

**Build contract / reviewer-note must-fixes**

- Do not include a `version-conflict` skip reason unless the endpoint actually accepts and checks a version.
- The reassign helper must handle third-party handover; do not misuse a helper that only deactivates the acting user.
- Tests must include target account validity, requester/self guard, role/dynamic source behavior, and role-reachable handover.
- Route guards must prove the split has an enforcement surface, not just new permission rows.

## T1-4 — node field-permissions authoring · M · Lane B after T2-1+2

> **SHIPPED `#3505` (`df8d43bf9`)** with the owner-steered hidden/readonly configurable authoring
> surface. Runtime redaction for hidden fields already existed; this slice shipped the authoring UI and
> preservation/anti-flatten contract. Readonly remains persisted but runtime-inert until a later edit-form-at-node
> slice. Closed decision record, not an open vote.

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | edit-form-at-node | Defer. This rung does not build mid-flow form editing or write-back to `form_snapshot`; readonly/editable remain runtime-inert. Create a later T1-4b for edit-form-at-node + readonly/editable enforcement. | ✅ SHIPPED #3505 |
| Q2 | What UI exposes | Owner-steered amendment: expose `hidden`, `readonly`, and `editable` as configurable authoring states while keeping readonly/editable runtime-inert in this slice. | ✅ SHIPPED #3505 |
| Q3 | Authoring surface | Linear steps editor only. Complex-graph fieldPermissions remain preserved/read-only; complex authoring is a later G-6-style slice. | ✅ SHIPPED #3505 |
| Q4 | Hiding routing-driver fields | Allow it. Redaction is echo-only and does not affect assignee resolution or condition routing; show a non-blocking hint when a hidden field also drives routing. | ✅ SHIPPED #3505 |

**Build contract / reviewer-note must-fixes**

- Runtime/user-facing leak test must exercise the action-dispatch response path, not only the already-redacted GET detail path.
- Round-trip test must prove existing fieldPermissions are preserved and hidden selections do not flatten unknown preserved config.
- Document and test that readonly/editable remain API-preserved but UI-inert; no silent no-op UI.
- Note the existing backend asymmetry: fieldPermissions are validated/normalized for approval nodes; raw non-approval node configs carrying fieldPermissions are out of scope for this FE slice and should stay fail-closed/preserved per existing shape checks.

## Voting examples

- `T1-2 all ✅; T3-5 hold; T2-1+2 Q6 ✏️ reuse transfer instead of reassign; T1-4 all ✅`
- Historical: `Lane C all ✅` meant T1-2 then T3-5 could be implemented sequentially; both are now shipped.
- Historical: `Lane B all ✅` meant T2-1+2 then T1-4 could be implemented sequentially; both are now shipped.
- Strategic/product votes belong in `approval-automation-third-batch-ballot-20260702.md`, not this hot-file
  implementation batch.

No additional runtime begins from this second-batch ballot; it is closed. Strategic/product votes remain in
`approval-automation-third-batch-ballot-20260702.md`.

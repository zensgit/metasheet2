# Approval & Process-Automation — third-batch strategic/governance ballot (2026-07-02)

> **Status: PROPOSED — awaiting per-rung owner votes.** This ballot authorizes nothing by itself.
> It turns the remaining governance/product-heavy tail into explicit, reviewable decisions after the
> first-batch runtime shipped (`#3467`/`#3468`/`#3474`/`#3477`) and the second-batch implementation
> queue was separated (`approval-automation-second-batch-ballot-20260702.md`).
>
> Vote per line: ✅ adopt default · ✏️ override (state the change) · ⏸ hold. A rung with every line
> ✅/✏️ becomes GO for its next step; unvoted rungs remain gated. This is **per-rung**, not blanket
> approval: these items mix live egress governance, attendance-domain calendar coupling, compliance
> capture/retention, mobile UX/privacy, and strategic approval-as-records modeling.

## Recommended order

| Group | Order | Why |
|---|---|---|
| Governance | `A3 destination authorization` | No code remains, but the first live HTTP-task destination must be explicitly authorized before default-deny egress becomes useful. |
| Product-heavy | `T3-2 business-calendar SLA` → `T3-3 signature` → `T3-1 mobile` → `T3-6 approval-as-records` | T3-2 builds on shipped node-SLA; T3-3 can lock a low-risk attestation floor before image capture; mobile is UX-heavy; S-band is the broadest data-model decision. |

## A3 — BPMN HTTP-task egress destination authorization · governance-only

Runtime policy plumbing is already shipped by `#3455`/`#3457`/`#3460`. The default remains deny-all until an
operator configures `BPMN_HTTP_TASK_EGRESS_POLICY`. This rung is not a code build; it is the first live destination
authorization decision.

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| A1 | First destination scope | Authorize exactly one named staging destination first; production destination requires a separate follow-up approval after staging evidence. | ⬜ |
| A2 | Host entry shape | Exact ASCII DNS host only, no scheme/path/port/wildcard/CIDR/IP literal; values supplied through `BPMN_HTTP_TASK_EGRESS_POLICY`, never request/BPMN variables. | ⬜ |
| A3 | Evidence and smoke | Values-free smoke proving allowed host reaches mocked/approved transport and disallowed/private/redirect cases still deny; no full URL, headers, body, response, or secrets in evidence. | ⬜ |
| A4 | Rollback | Removing or blanking the env policy returns the engine to deny-all with no DB migration or tenant data rewrite. | ⬜ |

**Build/ops contract**

- No runtime PR starts from this rung unless a named destination is supplied.
- If the first destination is real staging/prod, the proof must use the already-shipped normalized policy path, not a local bypass.
- The default-deny behavior remains the acceptance fallback.

## T3-2 — business/work-day calendar wired to approval SLA · L

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | Cross-domain boundary | Add a `WorkdayCalendarPort` in core-backend; the attendance plugin registers a provider wrapping `resolveEffectiveCalendar`. Approval never reads `attendance_*` tables directly. | ⬜ |
| Q2 | Org mapping | Persist `sla_calendar_org_id` resolved from the requester/org at instance start; fall back to literal `default` only when no explicit org mapping exists. | ⬜ |
| Q3 | Calendar change semantics | Snapshot at start. Later holiday/calendar edits do not move already-started approval deadlines. | ⬜ |
| Q4 | Provider failure | Fail-open to natural elapsed arithmetic, log, and never block approval creation or silently disable SLA tracking. | ⬜ |
| Q5 | Timezone authority | Use the provider-returned timezone; fallback to `APP_TIMEZONE`, then UTC; persist resolved timezone on metrics for audit. | ⬜ |
| Q6 | Non-counting windows | A minute counts only when it is on a working day and outside all configured non-counting windows; v1 supports recurring windows/day masks, not absolute ranges. | ⬜ |
| Q7 | Migration/backfill | Add nullable SLA unit/due-at columns and a new partial index; keep legacy `sla_hours` branch; no backfill for historical rows. | ⬜ |
| Q8 | Backward compatibility | Templates with only `sla_hours` remain byte-identical to today's UTC wall-clock SLA. Calendar logic is explicit opt-in. | ⬜ |
| Q9 | Breach wording | Rebase overdue calculations on actual `sla_due_at`; business-time-formatted strings are a follow-up. | ⬜ |
| Q10 | Search horizon | Cap workday deadline search at 366 days; if no deadline found, clamp to cap and log. | ⬜ |

**Build contract / reviewer-note must-fixes**

- The fail-first integration must assert through the real approval start + metrics SQL path, not a hand-built deadline.
- Add tests for provider absence/error, foreign org rejection/guarding, and legacy `sla_hours` fallback.
- The new index must still serve the legacy fallback predicate; do not drop the current scan index until cutover is proven.

## T3-3 — node signature / compliance · M-L

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | Signature kind | Contract supports an open `kind`, but v1 ships typed/click attestation only; handwritten image capture is separate. | ⬜ |
| Q2 | Enforcement timing | First rung is declared-inert: persist/round-trip `signaturePolicy`, but do not block approve/reject until enforcement is ratified. | ⬜ |
| Q3 | Image storage | When image capture is later approved, store bytes through `StorageService`; persist only opaque ref + sha256, never inline base64 JSONB. | ⬜ |
| Q4 | Integrity binding | Compute/store sha256 bound to actorId, instanceId, version, nodeKey, capturedAt; `to_version` is the audit anchor. | ⬜ |
| Q5 | Retention/legal hold | Retain artifacts for instance lifetime plus configurable compliance horizon; exclude from generic erasure as legal record. | ⬜ |
| Q6 | PII echo | Ordinary readers see only redacted descriptor; raw artifact/ref requires compliance-export permission. | ⬜ |
| Q7 | Applies-to and exemptions | Default applies to approve only; approve+reject available. System auto records/add-sign system records are exempt. | ⬜ |
| Q8 | Audit shape | Store signature reference in existing approve/reject record metadata; no new audit action or CHECK migration in the floor. | ⬜ |
| Q9 | Authoring UI | Add a thin checkbox only if clearly labelled enforcement-pending until runtime enforcement ships. | ⬜ |

**Build contract / reviewer-note must-fixes**

- First PR must prove `signaturePolicy` survives normalize → publish → reload → dispatch re-normalize.
- Default-absent nodes must remain byte-identical.
- If UI is included before enforcement, tests must prove it cannot imply runtime enforcement.

## T3-1 — mobile approval surface · L

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | Surface type | v0 is responsive web, not native and not PWA. PWA is a later opt-in when out-of-app push is approved. | ⬜ |
| Q2 | Out-of-app push | No out-of-app push in v0; reuse existing in-app socket badge only. | ⬜ |
| Q3 | Push producer | Future push waits for Notification Hub; no one-off push emitter. | ⬜ |
| Q4 | Push subscription storage | Deferred. If approved later, use tenant/user-scoped encrypted subscription storage with unsubscribe and stale pruning. | ⬜ |
| Q5 | Lock-screen privacy | Future push payloads are opaque by default; no form data, requester, amount, or sensitive field values. | ⬜ |
| Q6 | Offline behavior | v0 allows best-effort cached/read-only list; no queued offline approve/reject mutations. | ⬜ |
| Q7 | Action concurrency | v0 uses the same version-less unified `/actions` endpoint as desktop plus refresh-on-4xx; version-guarded mobile actions are a follow-up. | ⬜ |
| Q8 | Action set | v0 exposes approve/reject/comment/initiate only. Transfer/return/add-sign/reduce-sign/revoke/remind/admin-jump are later slices. | ⬜ |
| Q9 | Initiate field support | Support leaf fields and detail rows as stacked cards; attachment upload on mobile is capped/deferred per product decision. | ⬜ |
| Q10 | Route structure | Prefer responsive adaptation with dedicated mobile list components where desktop Element Plus widgets block touch usability; full `/m/*` tree deferred. | ⬜ |
| Q11 | Rollout gate | Feature-flag/tenant-gate mobile approval surface, default off. | ⬜ |

**Build contract / reviewer-note must-fixes**

- Mounted tests must disable approval mock mode before importing API modules, or they will pass against fixtures instead of real wire.
- All user-facing labels must go through i18n, including mobile-only empty/error/action states.
- No new backend contract in v0 unless a decision above explicitly changes.

## T3-6 — S-band approval data as first-class multitable records · L

| # | Decision | Proposed default | Vote |
|---|---|---|---|
| Q1 | System-of-record | Approval engine stays authoritative; multitable receives one-way materialized read-model projection. | ⬜ |
| Q2 | Projection trigger | Project create + terminal events only. In-flight node progress waits for a separate intermediate event. | ⬜ |
| Q3 | Visibility precedence | First slice creates admin/owner-scoped system-managed sheet; per-row approval visibility inheritance is separate. | ⬜ |
| Q4 | PII/form data | Project allowlisted system/value-constrained columns only; full `form_snapshot` projection is a separate redaction review. | ⬜ |
| Q5 | Instance-record link | Use side mapping table keyed unique approval instance id -> meta record id; do not add a column to all `meta_records`. | ⬜ |
| Q6 | User representation | Store raw requester/approver id strings in first slice; person/link cells are follow-up. | ⬜ |
| Q7 | Deletion/erasure | Retain terminal rows as audit/analytics read-model, but PII erasure/legal-hold policy must be decided before any full-form projection. | ⬜ |
| Q8 | Approval form record-reference fields | Defer. Projection does not add a new record-reference `FormFieldType`. | ⬜ |
| Q9 | Non-approved outcomes | Project all terminal outcomes to the neutral read-model; source-record W7 semantics stay separate. | ⬜ |
| Q10 | Base placement | One system-owned base/sheet per template family, provisioned lazily; cross-base projection is a non-goal in the first slice. | ⬜ |

**Build contract / reviewer-note must-fixes**

- A pending-create projection needs an explicit create hook; do not rely on completion events that only fire for terminal outcomes.
- Auto-approve-at-create must map to the same projected row as ordinary create-then-terminal.
- The projection cannot claim "no approval-side coupling" if it must project in-flight creation; name the coupling explicitly.
- PII erasure must be reconciled before projecting anything beyond the allowlisted system columns.

## Voting examples

- `A3 all ✅; T3-2 hold; T3-3 Q2 ✏️ enforce immediately; T3-1 all ✅`
- `T3-2 all ✅` means the business-calendar SLA design-lock/runtime may start from these defaults.
- `T3-6 ⏸` means approval-as-records stays strategic and no implementation begins.

No runtime begins until the relevant rung's votes are complete.

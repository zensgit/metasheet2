# Approval & Process-Automation — un-completed items, parallel-development plan & verification (2026-07-01)

> **As-built coordination plan** (updated to main after `#3451`/`#3452`/`#3450`/`#3453`, the A3-a/b slices
> `#3455`/`#3457`/`#3460`, and the first-batch runtime `#3467`/`#3468`/`#3474`/`#3477` merged). Deep review of what
> remains on the line, classified by gating and **sequenced into parallel lanes** so work distributes across
> sessions without hot-file collision. **Shipped since the first cut:** T2-4 re-entry quorum-bypass (`#3446`,
> `to_version >= cutoff`) + same-version cascade regression (`#3453`), R1-A/R1-B egress closure (`#3437`/`#3443`/
> `#3447`/`#3451`), A3 rollout design-lock + **runtime policy plumbing** (`#3452` + `#3455`/`#3457`/`#3460`),
> T2-6 event dedup ledger (`#3450`), approval.completed trigger (`#3467`), timeout transfer/jump effects
> (`#3468`), W7 non-approved result writeback (`#3474`), and delete_record editor exposure (`#3477`).
> **Honest framing:** the
> remainder is owner-gated (design-lock-first) — so "complete all development" is realized by
> *ratifying defaults **per lane/rung** (not blanket — it mixes SSRF / destructive-delete / permission-migration
> / cross-base-writeback risk) + distributing the lanes*, not one session building everything.

## 1. Current state (shipped on main)
- **Tier-1:** T2-3 analytics, T1-1 node-SLA slice-1 (remind-only), T2-4 threshold mode, T2-5 timezone,
  date_field floating-day fix. **Cycle hardenings:** offsetDays save-cap + runtime clamp, analytics Top-N
  tie-break. **W7** approved-path resultWriteback (backend).
- **R1-A/R1-B (SSRF) — DEFAULT-CLOSED COMPLETE:** `validateEgressUrl` egress guard + `isBlockedEgressIp` classifier
  (mapped / NAT64 / 6to4 / Teredo / **ISATAP both u/l forms `0000:5efe`+`0200:5efe` via `(bytes[8] & 0xfd)`** /
  IPv4-compatible `::/96`), the IP-pinned dispatcher, and `BPMNWorkflowEngine.executeHttpTask` wiring are merged.
  Default policy remains deny-all, so the original raw `fetch(url)` full-read SSRF path is closed by default; live
  destination enablement remains the separate A3 rollout/governance gate.
- **T2-4 threshold re-entry quorum-bypass — FIXED (`#3446`):** the tally is scoped to the current node-entry
  round via `to_version >= <re-entry cutoff>` (schema-free, uses existing data); no re-entry -> exact old query.
  The `#3453` follow-up locks the same-version requester auto-approval cascade boundary that requires `>=`.
- **T2-6 event dedup ledger — SHIPPED (`#3450`):** automation record-change/form-submit dispatch now has a
  database-backed event-fire ledger (7-day TTL retention sweep only — no count cap), real-DB coverage, and CI
  wiring. This removed the substrate blocker for approval-trigger and inbound-webhook work.
- **First-batch runtime — SHIPPED:** `approval.completed` automation trigger (`#3467`), T1-1 slice-2 timeout
  transfer/jump effects (`#3468`), W7 non-approved result writeback (`#3474`), and safe delete_record editor
  exposure (`#3477`) are all on main on the ballot defaults.

## 2. Un-completed items — gating

| Item | Subsystem | Status | Gating |
|---|---|---|---|
| ~~T2-4 threshold re-entry quorum-bypass~~ | approval engine | **SHIPPED (#3446)** | done — `to_version >= re-entry cutoff`, schema-free; CI green |
| ~~T2-4 same-version cascade regression~~ | approval engine | **SHIPPED (#3453)** | done — locks that same-version auto-approval at re-entry counts under `>=` |
| ~~ISATAP `0200:5efe` u/l-bit + IPv4-compat~~ | BPMN (guard) | **SHIPPED (#3437/#3443)** | done — classifier folds both ISATAP u/l forms + `::/96` |
| ~~R1-B DNS-pinned dispatcher + wiring + redirect re-validation~~ | BPMN/workflow | **SHIPPED (#3447/#3451)** | done — raw BPMN HTTP-task fetch path replaced; default policy deny-all |
| **R1-A3** configured destination enablement | BPMN/workflow | **runtime SHIPPED** (#3455/#3457/#3460), destinations not yet authorized | governance-only remainder: `#3460` injects the server-owned `BPMN_HTTP_TASK_EGRESS_POLICY` env policy at both BPMN route construction points; `#3455` normalizer + `#3457` route-provenance locks are in. **No core runtime code left** — what remains is authorizing/configuring the first live destination (ops/governance per `#3452`), default stays deny-all |
| ~~T1-1 slice-2 transfer/jump timeout effects~~ | approval engine | **SHIPPED (#3468)** | done — transfer/jump wired; auto_* terminal effects remain env-gated/inert |
| T2-1+2 scoped admins + handover | approval engine | unshipped | owner-gated (permission model + migration) |
| T1-4 node field-perms runtime | approval engine | unshipped | owner-gated (edit-form-at-node prerequisite) |
| ~~T3-4 W7 rejection backwrite~~ | automation/approval | **SHIPPED (#3474)** | done — opt-in non-approved writeback, write-back-then-fail |
| T3-5 W7 cross-base backwrite | automation/approval | unshipped | owner-gated (cross-base write-gate re-lock) |
| ~~T0-3 delete_record editor~~ | automation engine | **SHIPPED (#3477)** | done — same-base trigger-record only, ack-gated editor, save-gate hardening |
| T1-2 inbound webhook | automation engine | unshipped | owner-gated (signature/replay/audit, 9 decisions) |
| ~~T1-3 approval.* trigger~~ | automation engine | **SHIPPED (#3467)** | done — template-routed, record-less v1, T2-6 ledger reuse, permission recheck |
| ~~T2-6 event-driven dedup ledger~~ | automation engine | **SHIPPED (#3450)** | done — database-backed event fire ledger, sweep, real-DB CI wiring |
| T3-2 business-calendar SLA · T3-3 signature · T3-1 mobile · T3-6 S-band | product/heavy | unshipped | owner-gated, L (T3-2 dep T1-1) |

## 3. Parallel-development lanes (the sequencing)

The line is **three largely-independent subsystems** — they can run **concurrently** in separate sessions.
The constraint is **hot files**: items sharing one runtime file must be **sequential within a lane** (parallel
edits to `ApprovalProductService.ts` / `automation-service.ts` collide).

- **Lane A — BPMN/workflow** (`BPMNWorkflowEngine.ts`, `routes/workflow*`, `guards/egress-guard.ts`):
  R1-A guard/classifier **done** (#3437/#3443), dispatcher **done** (#3447), engine wiring **done** (#3451),
  **A3 policy plumbing done** (#3455 normalizer / #3457 route-provenance locks / #3460 server-owned
  `BPMN_HTTP_TASK_EGRESS_POLICY` env injection at both route construction points). The ONLY remaining egress work
  is **destination authorization** — a config/ops governance act per `#3452`, not code. Default stays deny-all
  until a first named destination is explicitly authorized.
- **Lane B — approval engine** (`ApprovalProductService.ts` — HOT, so sequential): ~~`T2-4 fix`~~ **done (#3446)**
  + cascade regression **done (#3453)** + `T1-1 slice-2` **done (#3468)** → next `T2-1+2` → `T1-4`. (`T3-5`
  W7 cross-base backwrite touches
  `automation-service.ts`, see Lane C.)
- **Lane C — automation engine** (`automation-service.ts` — HOT, so sequential): ~~`T2-6 dedup`~~ **done (#3450)** →
  `T1-3 approval-trigger` **done (#3467)** → `T3-4` **done (#3474)** → `T0-3 delete_record` **done (#3477)** →
  next `T1-2 inbound webhook` / `T3-5` W7 cross-base backwrite.
- **Lane D — product/heavy** (separate surfaces): `T3-1 mobile`, `T3-6 S-band`, `T3-2 business-calendar`
  (dep T1-1), `T3-3 signature`.

**Hard deps:** R1-B→#3437 (met and shipped) · A3→R1-B (met, but A3 remains governance-gated) · T2-2→T2-1
(permission model) · T3-2→T1-1 (node-SLA) · T1-2/T1-3→T2-6 (met and shipped). **Cross-lane collision risk:** Lane B and the W7 items in Lane C both eventually touch
approval-completion code — keep W7-backwrite in Lane C to avoid `ApprovalProductService`/`automation-service`
double-editing.

## 4. What's ready to build vs needs a decision
- **Shipped:** T2-4 fix (#3446) + same-version cascade regression (#3453) · R1-A/R1-B default-closed egress closure
  (#3437/#3443/#3447/#3451) · T2-6 event dedup ledger (#3450) · approval.completed trigger (#3467) ·
  T1-1 timeout transfer/jump effects (#3468) · W7 non-approved writeback (#3474) · delete_record editor (#3477).
- **Owner-gated:** the remaining rungs — including A3 configured destination enablement, T1-2 inbound webhook,
  T3-5 W7 cross-base, T2-1+2 scoped admins/handover, T1-4 field-perms, and product/heavy items. The register (#3385) and the
  follow-up design-locks hold each rung's open decisions + proposed defaults.
  **Approve per lane/rung, not blanket** — the remainder mixes distinct risk surfaces (SSRF wiring, destructive
  delete, permission migration, cross-base write-back), so a single blanket "build on defaults" is unsafe.
  The next executable implementation decision surface is `approval-automation-second-batch-ballot-20260702.md`
  (T1-2, T3-5, T2-1+2, T1-4). The product/governance-heavy tail is separated into
  `approval-automation-third-batch-ballot-20260702.md` (A3 destination authorization, T3-2, T3-3,
  T3-1, T3-6) so strategic decisions do not get mistaken for ready implementation queue.

## 5. T2-4 quorum-bypass fix — AS-BUILT (`#3446`, shipped)

**Bug:** the threshold tally (`ApprovalProductService.ts` threshold dispatch) counted `COUNT(DISTINCT actor_id)
… action='approve' AND metadata->>'nodeKey'=$2` with no round scoping. The 退回/return path admits any
previously-visited approval node — including an already-resolved `threshold` node — and approve records are
append-only, so on re-entry the prior-round votes counted toward N: a 2-of-3 that A+B already approved re-resolved
on a single fresh vote (self-verified reachable).

**Shipped implementation — schema-free `to_version >= cutoff` (NOT the register's Option-B `nodeEntryEpoch`
proposal):** the current round begins at the `to_version` of the most recent return/jump that re-entered the node;
approve records carry `to_version` (bumped), so the tally is scoped to `to_version >= <re-entry cutoff>`. `>=`
(not `>`) is deliberate — a return/jump can fire an auto-approval cascade at the re-entered node in the same
transaction (`insertAutoApprovalEvents` writes those approve records at `to_version = cutoff`), so they're
current-round votes that must count; prior-round approves are strictly `< cutoff`. **No re-entry → cutoff null →
exact old whole-node query (zero regression).** The graph is validated acyclic, so return/jump is the only
re-entry path (marker complete). This is **simpler than the epoch proposal** — no new metadata field, no per-node
counter, no migration.

**Verification (real-DB):** `approval-nofm-threshold` **5/5** incl. a fail-first re-entry test (2-of-3 -> A+B
approve -> advance -> RETURN -> one fresh vote must NOT re-resolve; RED-before confirmed) · N>M fail-closed +
single-reject unchanged · `#3453` same-version requester auto-approval cascade regression (locks the `>=` boundary
so a future `>` change fails).

## 6. T2-6 event dedup ledger — AS-BUILT (`#3450`, shipped)

**Bug class / substrate gap:** record-change and form-submit automation events are at-least-once sources; without
a database-backed fire ledger, redelivery/replay can execute side effects more than once. T1-2 inbound webhook and
T1-3 approval-trigger both need the same substrate before they can safely expose higher-frequency event sources.

**Shipped implementation (exact shape):** `meta_automation_event_fires(rule_id, dedup_key, fired_at)` with
**PRIMARY KEY `(rule_id, dedup_key)`** (+ `fired_at` index; `rule_id` FK → `automation_rules` ON DELETE CASCADE).
`dedup_key = ${eventType}:${_eventId}` — a transport `_eventId` is stamped at every emit site for the shipped
sources (record.created/updated/deleted, form.submitted, field.value_changed via record.updated); a missing
`_eventId` stays **fail-open during rollout** (the ledger only gates stamped events). Claim-then-fire:
`INSERT … ON CONFLICT DO NOTHING RETURNING` — the rule executes only if it won the insert (at-most-once), and a
lost claim is a skipped duplicate, not a rule failure. Retention: **7-day TTL sweep only** (`fired_at < cutoff`,
kicked at most once per 24h, best-effort) — there is NO `base_id` column, NO `event_key` column, and NO per-rule
count cap. T1-3 will reuse this ledger with `dedup_key = approval.completed:${event.eventId}` (the approval
completion event's own unique id — no `_eventId` stamping needed) and **no new migration** (ballot Q5).

**Verification:** pure dedup-key tests, automation-service unit coverage, real-DB `multitable-event-dedup-trigger`
coverage wired into `plugin-tests.yml`, plus regression updates for record-service/write-service callers.

## 7. Recommendation
1. **Done:** T2-4 fix + cascade regression (#3446/#3453) · R1-A/R1-B default-closed egress closure
   (#3437/#3443/#3447/#3451) · T2-6 dedup ledger (#3450) · first-batch runtime (#3467/#3468/#3474/#3477).
2. **A3 is now governance-only:** the egress policy runtime is fully shipped (`#3452` design-lock +
   `#3455`/`#3457`/`#3460` normalizer / provenance locks / server-owned env injection). Default remains deny-all;
   the remaining act is **authorizing the first live destination** (config/ops), which happens when a named
   integration needs it — no code slice to schedule.
3. **Next feature lanes after owner ratification:** Lane C `T1-2 inbound webhook` or `T3-5` W7 cross-base
   writeback; Lane B `T2-1+2` scoped admins/handover or `T1-4` field-perms. Continue to ratify
   register defaults **per lane/rung**, not blanket — the first-batch per-rung ballot now lives as the shipped
   decision record in `approval-automation-first-batch-ballot-20260701.md`; the second-batch ballot is
   `approval-automation-second-batch-ballot-20260702.md`; the third-batch strategic/governance ballot is
   `approval-automation-third-batch-ballot-20260702.md`. Sizing note: per-rung person-day estimates are
   optimistic build-effort figures, NOT calendar commitments — on the security/permission/migration rungs
   (T1-2, T2-1+2, T3-5) review rounds can cost more calendar than the build itself.

# Multitable Benchmark-Surpass Track — Development Goal + TODO (2026-06-15)

Type: development goal + gated TODO ledger (trackable). Not a schedule.

Driver: the owner-set standing goal — multitable driven by **对标并超越** the
leading 多维表格 product. Each refresh audit re-ranks the gap ladder; each arc and
each slice within an arc is a **separate named opt-in** — never auto-advance.

Rationale + the benchmark evidence (external-product comparison, citations) live
in the research companion, NOT here: `docs/research/multitable-feishu-refresh-audit-20260615.md`
(PR #2641). This committed plan uses MetaSheet's own capability names only.

Markers: ✅ done · ⬜ ready / in progress (current opt-in) · 🔒 gated (needs its
own named opt-in / a prereq).

## 0. Current arc — B1: button / action field

A value-less `button` field type whose cell, on click, runs **one** bound action
on its row's record by reusing the existing single-action execution path. Inherits
all record permission / lock / cross-base / redaction / observability gates — no
new automation-engine code (prereq verified: synthetic `btn_` rule_id has no FK;
the C1 runs read path is sheet-scoped).

Scope gate (the contract): `multitable-button-action-field-scope-gate-20260615.md`
(PR #2644, ready for review).

| Slice | State | What | Acceptance |
|---|---|---|---|
| B1-a field-type + codec | ⬜ in progress (PR pending) | register the value-less `button` type; codec accepts `{label, exactly-one existing action}`, rejects empty label / 0 or 2+ actions / unknown action / the 4 suspending-branching actions; `validate` rejects any stored value | sanitizeProperty accept/reject unit tests + value-PATCH rejected; tsc clean |
| B1-b run endpoint | 🔒 after B1-a + owner go | authenticated, record-scoped POST that runs the bound action via the existing single-action engine (synthetic non-persisted single-action `workflow_job_v1` envelope); explicit record-write capability check; lock / cross-base / redaction inherited; one C1 job + execution-log row | real-DB: action runs + writes; 401/403/lock/404 fail-closed; one C1 job (`resolved`) + log whose `btn_` rule_id resolves to no rule; wire round-trip; double-run = two executions |
| B1-c FE cell | 🔒 after B1-b | render label + clickable control (not editable, no editor on dblclick); invoke the endpoint; in-flight disable + result toast; disabled when locked / no write capability | renders + invokes; never writes a value; disabled states |

**Definition of done (B1):** all three slices landed + the real-DB B1-b E2E green;
out-of-scope items below stay rejected.

**B1 hard out-of-scope (each = its own future opt-in):** no new action types; no
multi-action / conditional / triggered / scheduled runs; no suspending-branching
bound actions (`wait_for_callback` / `start_approval` / `condition_branch` /
`parallel_branch`); no new RBAC tier; no bypass of locks / permission / redaction;
no public/unauthenticated endpoint; no persisted synthetic rule.

## 1. Post-B1 ladder (demand-gated, ranked by the 2026-06-15 refresh audit)

Each is a separate arc; open only on a named demand + when its gate clears. The
ranking is the audit's; it re-ranks on the next refresh.

| Arc | State | Capability | Gate |
|---|---|---|---|
| A1 | 🔒 | grid row virtualization / windowing (large tables) | L; ops — needs the perf baseline first |
| B4 | 🔒 | dashboard non-chart widgets (metrics, pivot, filter linkage) | small chain → L; named demand |
| A5 | 🔒 | conditional-format depth (data bars / color scales / icon sets) | M; named demand |
| A4 | 🔒 | form-logic depth (required-if / multi-page / prefill / redirect) | M; named demand |
| B2 | 🔒 | AI field rings + AI-automation node | L per ring; product charter |
| B7 | 🔒 | row-level rule-engine permissions (value-based) | L; owner + adversarial review |
| B3 | 🔒 | native synced / external-source tables | XL; owner — parked |

**Already at parity-or-ahead (the "surpass" wins, keep, don't rebuild):** governed
cross-base writes + rate quota + claim==truth; security-grade masked export + leak
canary + sanitize/AI-taint chokepoints; formula-over-lookup with in-memory
hydration; the just-landed branch-local wait + condition-branch + parallel join-all
automation engine. Honest reverse-gap: the benchmark leads on AI / scale / BI
richness — surpass concentrates in governance / security / workflow orchestration.

## 2. Execution discipline

- **One opt-in at a time.** B1-a is the only ⬜ now; B1-b/B1-c and every §1 arc are
  🔒 until separately named. "Continue the arc" is enough to advance the next B1
  slice; opening a §1 arc needs naming that capability + its gate clearing.
- **Contract-first per arc:** scope-gate (docs) → owner review → runtime slices.
- **Each runtime slice proves out** with the tests its scope-gate pins (real-DB for
  any write/endpoint), and is reviewed before merge — nothing auto-merges.
- **Refresh re-ranks:** before picking the arc after B1, re-run the audit (the
  ladder above is a snapshot, not a queue).

## 3. Re-entry

After B1 closes: re-run the refresh audit → re-rank §1 → pick the next arc by
value × reachability (A1 is highest-value but ops-gated; B4 is the likely next
buildable). Update this ledger's markers as slices land.

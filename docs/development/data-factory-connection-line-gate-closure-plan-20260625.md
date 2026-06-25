# Database / system-connection line — gate-closure plan (2026-06-25)

> Purpose: the connection line's remaining work is **gated, not under-developed**. This plan operationalizes the **gate closures** that unlock the most, separates "we can build" from "owner/customer must decide/supply," and is values-free (the customer-input section is a template — no real credentials/ids/values here).

## 1. Where the line actually is (current main)

- **Done + production-ready (read/import half):** external-system registry + credential store (AES-256-GCM, host-backed/env-key); Data Factory pipeline define→run→**monitor** (DF-N0, DF-N1 read-only UI, DF-N2-2 per-row provenance + by-row lineage); **dead-letter store + manual replay (DF-N1.5, shipped #1857)**; connectors — SQL read-only, K3 WISE SQL-Server read (Windows on-prem verified), HTTP, PLM/Yuantus read, bridge legacy-SQL, multitable staging source + import-hub target.
- **Built but dormant:** FOS-4b-3 production canonical write (P1–P3 on main, config-only, no default).
- **Gated / not built:** external-write apply (C6), deeper K3 (read/list, Submit/Audit, multi-record), DF-N3/N4 platform tier.

There is **no clean "just build it" backlog item** outstanding — DF-N1.5 (the one candidate) is already shipped. The remaining items each sit behind one of the three gates below.

## 2. Gate A — conclude the K3 PoC (unlocks the per-capability K3 decisions)

**Proven:** single-record K3 WISE Save (material preset, reference-mapping, save-body composition, failure evidence); SQL-Server read channel; staging import; the sandbox-validation discipline.

**To declare the PoC concluded (evidence bar — values-free):**
```text
☐ a documented Save round-trip with failure-path evidence (counts / status / errorType only)
☐ the read/list runtime DECISION recorded (build #1709 now vs keep deferred) with its rationale
☐ a written "lessons → Stage-2 design questions answered" note (the PoC's job is evidence, not just success)
☐ the per-capability gate posture restated: which K3 capabilities unlock, which stay frozen, each with a reason
```
**Unblocks (each a separate per-capability opt-in, not a blanket unlock):** K3 read/list runtime (#1709) · the basis for Submit/Audit + multi-record decisions · the evidence input for the DF-N3/N4 platform-tier decision.

## 3. Gate B — customer GATE packet (unlocks anything *live*)

The dev side for live K3 is largely design-locked; the blocker is customer-supplied inputs. **Actionable checklist to send the customer (template — do not fill real values in this doc):**
```text
☐ K3 WebAPI endpoint + service credentials, provisioned via the credential store (never request/preset/browser)
☐ network allowlist / connectivity from the deploy host to K3 (and to SQL Server if the SQL channel is used)
☐ SQL-Server executor/proxy readiness (if the SQL read channel is used) — host-owned, not shipped by us
☐ PLM source system registered as an external-system (source role)
☐ field mapping + dictionary/option rules complete for the target preset
☐ rollback / evidence owner named and signed off for any write-back
```
**Unblocks:** live K3 read/Save on the entity machine; without it, only offline/deploy-smoke can proceed.

## 4. Gate C (FYI) — production-write owner gates (not a "drive it" item)

These are **owner authorizations when there is a real write demand**, not development goals — building/enabling them speculatively defeats the gate discipline:
- **FOS-4b-3 production write (P4)** — authorize a bounded run per the production runbook (`…prod-apply-runbook-20260625.md`): target/route/action/maxCleanRows/short-expiry + rollback/evidence.
- **C6 data-source external-write apply** — the analogous external-DB write; dry-run exists, apply frozen pending the same production-write discipline.
- **K3 SQL-Server write** — needs a customer-deployed executor; not shipped.

## 5. What each closure unlocks (value map)

```text
Gate A (PoC concluded)            → per-capability K3 unlocks (read/list decision) + Stage-2 evidence
Gate A + Gate B (PoC + customer)  → live K3 read/list + Save on the real environment
Gate C (owner authorizes a run)   → first production canonical write (FOS P4) / external write (C6)
Gate A evidence → Stage-2 decision → DF-N3 (bulk retry/back-pressure) + DF-N4 (connector catalog/CDC)
```

## 6. Ownership / sequence

```text
Gate A (PoC conclusion)   : owner/dev — assemble the evidence + record the read/list decision (we can draft)
Gate B (customer packet)  : owner → customer — send the §3 checklist; customer-paced
Gate C (production writes) : owner — authorize when a real write need exists (per the runbook)
DF-N3 / N4 platform tier  : deferred until Gate A evidence; each a separate gated opt-in afterwards
```

## 7. Honest framing

The bottleneck is **decision + customer + evidence, not engineering capacity.** Pointing dev effort at Gate-C/D items now produces dormant or speculative code. The highest-leverage moves are: **(1) close Gate A** (conclude the PoC evidence + record the read/list decision) and **(2) issue the Gate-B customer packet**. Those two unlock most of the rest; Gate C stays owner-paced; the platform tier stays post-PoC by design.

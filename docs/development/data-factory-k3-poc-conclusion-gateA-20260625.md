# Gate A — K3 PoC conclusion + read/list runtime decision (2026-06-25)

> Status: **PoC concluded (evidence closed) · read runtime ALREADY BUILT + verified (#1868), ratified · LIST half open**. First basis from the connection-line gate-closure plan (`data-factory-connection-line-gate-closure-plan-20260625.md`): turns the K3 PoC from "experiment done" into "evidence closed + decision recorded." Check-before-build finding: the read smallest-unlock is already shipped (#1868, `80c2f7bcd`) — this Gate A ratifies it as complete and records that the LIST half remains a separate decision. Authorizes **no write of any kind**; opens no customer GATE.

## 1. What the K3 PoC proved (values-free evidence)

```text
K3 WISE WebAPI Save (single-record material preset) : PROVEN — save-body composition (#1835), reference
                                                      mapping (#1826), failure-path evidence (counts/status/
                                                      errorType only); authenticity via stored token
K3 WISE SQL-Server read channel                     : PROVEN — SELECT TOP <limit>, table allowlist, no raw
                                                      SQL, TLS; Windows on-prem package verified
staging import → multitable hub                     : PROVEN — read-only reference harvest + import
sandbox-first write discipline                      : PROVEN — FOS sandbox validation COMPLETE (#3093):
                                                      gate / idempotency / human-field / route-gate, values-free
```

PoC purpose was **evidence, not just success** — the above closes the design questions needed to make the read/list decision and to feed the Stage-2 (DF-N3/N4) decision later.

## 2. Read/list runtime — FINDING: the read is ALREADY BUILT + verified; ratified

Check-before-build (2026-06-25): the read smallest-unlock is **already implemented, tested, and verified** — shipped as the K3 Material read-only smoke (**#1868, `80c2f7bcd`**): `Material/GetDetail` single-detail read + reference harvest, gated on the material object declaring `operations:['read']` (default template stays `['upsert']` → dormant / read-only / fail-closed), with a wire-vs-fixture test (`k3-wise-adapters.test.cjs` intercepts the real `/K3API/Material/GetDetail`, exercises READFAIL/HTTPFAIL negatives, asserts read-enabled vs default-upsert) plus design **+ verification** docs (2026-05-26). It already matches the ratified posture below. **DECISION: ratify the existing read runtime as complete; the LIST half remains a separate decision (see §4).** The smallest-unlock scope, as built:

```text
scope        : read-only Material/GetDetail (single, customer-approved detail) + reference-object harvest
NOT in scope : Save / Submit / Audit / BOM write / list reads / broad filters / pagination /
               server-side pipeline composition / any production write
posture      : dormant + fail-closed by default (no read happens without explicit server-config + a
               registered external system); read-only
tests        : wire-vs-fixture (assert the real wire round-trips the harvested fields, not a hand-built
               fixture) + negative controls
runbook      : operator steps + values-free evidence template
exit         : ACHIEVED for the read — dev complete (#1868); only entity-machine / customer testing remains (live)
```

Rationale: the read is the narrow, vendor-documented, low-risk capability — and it is **already built dormant/read-only** (#1868), matching the ratified posture, adding no write and requiring no customer GATE to exist. Live execution still needs the customer GATE (credentials/network/PLM source/mapping — Gate B). The LIST half was deliberately excluded from the smoke and is a separate larger slice.

## 3. Freeze held (high-risk writes stay closed)

```text
FOS-4b-3 production write (P4)        : FROZEN — owner-authorized bounded run only (dormant runtime built)
C6 data-source external-write apply   : FROZEN — dry-run only
K3 WISE Submit / Audit / BOM write    : FROZEN — customer approval policy + admin signoff, post-PoC
multi-record K3 push                  : FROZEN — DF-N3 back-pressure
```

These may exist as contract/runtime **dormant**, but the **first real write of any kind is a separate explicit owner authorization**. #1709 read/list is read-only → fully consistent with this freeze.

## 4. What this unlocks / next

```text
this Gate A          : closes the PoC evidence + ratifies the EXISTING read runtime (#1868) as complete
read (single detail) : DONE (#1868 80c2f7bcd) — dormant/read-only/fail-closed + wire-vs-fixture + design/verif
read LIST (open)      : multi-record list reads / pagination / broad filters — deliberately excluded from the
                       smoke; a SEPARATE larger slice + decision if wanted (NOT built)
live                  : gated on the customer GATE packet (Gate B) — for the existing read and any list slice
Stage-2 (DF-N3/N4)   : still deferred; this evidence is an input, each a separate gated opt-in later
```

## 5. Boundary

```text
authorizesNoWrite=true   readOnlyOnly=true   dormantByDefault=true   noCustomerGateOpened=true
noSubmitAuditBom=true    noProductionWrite=true   noServerSideComposition=true   valuesFreeEvidence=true
```

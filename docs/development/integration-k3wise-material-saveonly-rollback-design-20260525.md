# K3 WISE Material Save-only Rollback / Undo — Design - 2026-05-25

## Scope

- Rollback / undo flow for **exactly ONE** test Material record created by a Save-only GATE regression (S4).
- **NOT** BOM, **NOT** Submit/Audit, **NOT** multi-record, **NOT** production materials.
- **Docs-only**; no runtime change. Closes the rollback half of the owner-named "mapping path **AND** rollback" expansion gate (#1792: "confirm the rollback handling for that test record").

## Execution model (defined once; everything below references this)

Rollback is executed by the **K3 administrator (or a named delegate) through K3's native console / utilities, OUTSIDE the MetaSheet adapter.** No new adapter write operation is introduced; no pipeline / runtime / `plugin-integration-core` change. **This document defines the procedure, not a tool.** Every action below (delete / disable / mark / retain) is a K3-native operator action, not a MetaSheet feature.

## Rollback owner

- Named **rollback owner** per test = the operator running the S4 Save-only regression.
- **Executing authority** for any K3-side change = the K3 administrator (or delegate).
- Customer sign-off is required before the test and at rollback execution (see R2).

## Trigger conditions

Rollback is triggered when any of: (a) the test material is no longer needed post-verification; (b) the created material is wrong/incomplete; (c) an unintended or duplicate record was created; (d) the customer requests removal. **Time-box:** the rollback decision is made within an agreed window (e.g. same business day) so the test material does not linger in K3.

## Acceptable strategies (owner + customer choose ONE; ranked)

| # | Strategy | Preconditions / notes |
|---|---|---|
| **S-A** | delete / 作废 | Material is **unreferenced** — the unreferenced check is performed by **K3 admin via K3's native tools**, NOT MetaSheet (read/list runtime is deferred to S3) — AND customer approves. Cleanest when available. |
| **S-B** | disable / forbid (禁用) | Set the material's use-status to forbidden; the row is retained for audit. |
| **S-C** | mark-as-test (标记测试) | Rename / flag (e.g. a name/spec prefix) so it is unmistakably a test artifact; retained. |
| **S-D** | retain-with-audit | Keep as-is plus a sanitized audit note linking it to the test; only when S-A–S-C are not possible. |

Default preference: **S-A** if unreferenced and approved; else **S-B**; **S-C/S-D** as fallback. The chosen strategy and the reason are recorded in the evidence.

## Evidence collection (operator-recorded, sanitized)

Evidence is recorded **by the operator** (not by any system) as sanitized JSON — same discipline as the #1813 / #1817 GATE artifacts.

- Capture the rollback target's identifier (`FNumber`) from the Save-only response **before** rollback (sanitized per R6), the rollback action's HTTP/envelope status, the **post-rollback readback** outcome (not-found after delete / forbidden-status after disable / marked-name after mark), and the strategy applied.
- **Redaction:** NO token / authorityCode / password / connection string / raw `FNumber` values / raw K3 payload / private host. Presence-flags + status only.
- Artifact path pattern: `C:\metasheet\artifacts\integration-k3wise\customer-gate\saveonly-rollback-<date>-NN\summary-redacted.json`.

## Escalation path on failure

- Delete fails (referenced / permission denied) → fall back to **S-B** disable; disable fails → **S-C** mark + **S-D** retain-with-audit; record each failure.
- None possible (K3 rejects all) → **escalate to K3 admin + customer** with sanitized evidence; document the material as a known retained artifact pending K3-admin action.
- **Never loop destructive retries.** Any ambiguity about whether the material is referenced → **STOP, treat as referenced, escalate** — do not force delete.

## Prohibitions

- No BOM / Submit / Audit rollback (those operations were never executed).
- No multi-record / bulk rollback — exactly ONE test material.
- No automated / scripted destructive rollback via the MetaSheet adapter or pipeline — rollback is K3-native and operator-executed; **no new adapter write, no runtime change.**
- No touching any non-test / production material. No secrets or raw payloads in evidence.
- **Rollback (especially S-A delete) is irrevocable in this design** — once executed it cannot be reversed; the R2 customer sign-off MUST cover this.
- This flow does **not** authorize additional Save-only writes or any expansion.

## S4 pre-acceptance matrix (rollback-readiness gates — ALL must hold before the S4 Save-only test runs)

| # | Gate |
|---|---|
| **R1** | Named rollback owner + K3-admin executing authority recorded. |
| **R2** | Customer sign-off authorizing BOTH the 1-record Save-only test AND its **irrevocable** rollback. |
| **R3** | Primary strategy + fallback chain agreed in advance. |
| **R4** | Sanitized evidence template ready (operator-recorded; presence-flags only). |
| **R5** | Escalation contacts (K3 admin + customer) identified. |
| **R6** | The rollback target's identifier (`FNumber`) is captured from the Save-only response **before** rollback, sanitized for evidence, and the rollback is authorized **against that exact identifier — never a search / scan / wildcard** (guards against hitting a production material). |
| **R7** | Rollback confirmed **K3-native / manual** — no adapter or runtime change needed. |
| **R8** | Time-box for the rollback decision is set. |

S4 proceeds **only** when R1–R8 all hold.

## Boundary / non-goals

- Docs-only; no runtime / migration / adapter; nothing implemented.
- Rollback execution is K3-native + customer-approved; this defines the flow, not a tool.
- BOM / Submit / Audit / multi-record / expansion remain locked.
- The "unreferenced" determination depends on K3-admin native tooling; MetaSheet read/list is S3 (deferred).

## See also

- #1792 — Customer GATE (rollback handling for the test record); `PASS_SAVE_AND_READBACK`.
- #1828 — S2 reference completeness preview; #1826 — UI contract; #1817 — reference shape.
- #1813 — sanitized evidence discipline (presence-flags / status only).

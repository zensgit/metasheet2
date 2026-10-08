# Approval Canvas D0 — G0 Ratify Record (2026-08-15)

**Decision:** RATIFY  
**O3 layout engine:** DEFER (keep the shipped bespoke renderer; Vue Flow / ELK not authorized)  
**Owner:** zensgit, via explicit instruction to execute the recorded recommendation  
**Date:** 2026-08-15  
**Integration head at record:** `origin/main` `9b693a11d9bb09f4cb5225223d01d7bc554b9805` (`#4912` closeout on main)

This record is the G0 packet from `docs/development/approval-canvas-data-closure-owner-handoff-20260808.md` §2. It authorizes the D0 interaction contract. It does **not** enable runtime flags, run real-tenant UAT, or authorize product FINAL.

## 1. Decision block (handoff §2.1)

```text
G0 decision for approval-canvas-v2-interaction-design-lock-20260721.md
Date: 2026-08-15
Owner: zensgit
Decision: RATIFY
If RATIFY-WITH-DELTAS, list deltas: (none)
O3 layout engine (optional, independent): DEFER
Notes: Execute the recommended owner packet. Staging Canvas-only UAT (S1–S12) remains a separate gate. FWB and attachments stay default OFF this round. Do not claim product FINAL.
```

## 2. What this ratify does and does not do

| Action | Status |
|---|---|
| Flip D0 lock Status `PROPOSED` → `RATIFIED` | **YES** — this record |
| O3 Vue Flow / ELK | **DEFER** — current bespoke canvas stays |
| Real-tenant UAT (handoff §3.2 S1–S12) | **NOT DONE** — no tenant credentials; `docker/app.staging.env` absent on the recording machine |
| Staged Canvas ON (handoff §4 stage 2+) | **NOT APPLIED** — no staging env file; repo/production defaults untouched; remote example host not mutated |
| FWB / attachments enablement | **NOT THIS ROUND** |
| Repo / production flag defaults | **UNCHANGED, OFF** |
| Product FINAL | **NO** |

## 3. Staging preflight (values-free)

- Repo defaults on this head: `approvalCanvasV2: false`, `approvalFwbWriteback: false`, `approvalAttachments: false`.
- Managed staging env `docker/app.staging.env` is **not present** (only `docker/app.staging.env.example`).
- Example `PUBLIC_APP_URL` from that example file (`http://23.254.236.11:8082`) answered `/api/health` **ok** with build `12f1f8c466` (2026-08-12). That is **not** current `main` `9b693a11d9`, and this record did **not** set `APPROVAL_CANVAS_V2_ENABLED` there or log in.
- Local `:8899` / `:8900` were not running. Starting a personal stack is not a real-tenant UAT substitute.

S1–S12 therefore stay **NOT RUN**. FWB/attachments stay **DEFERRED**.

## 4. Remaining owner gates (unchanged)

1. Non-prod tenant on a build that includes `323d7e1afe` or later; Canvas-only `APPROVAL_CANVAS_V2_ENABLED=true` in **that** environment.  
2. Handoff §3.2 S1–S12 + §3.4 fail-closed.  
3. Only after that: canary / default-ON for Canvas, then separate FWB and attachments ladders.  
4. Sign product FINAL with handoff §5 only when G0 + UAT + staged enablement are all complete.

G0 is now complete. UAT and staged enablement are not.

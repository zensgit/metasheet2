# DingTalk Sync Hardening v1 — Runtime-Closeout Design & Verification

Date: 2026-07-13
Scope: the closeout of **DingTalk Sync Hardening v1** to a *runtime-closed* state (DT-CLOSE-01…05),
and the forward plan for the SECOND, separate milestone (Canonical Org & Provider Transfer v1).

## 0. Two milestones — do NOT conflate

Per the owner's judgment, the DingTalk line is **two milestones**, never one "钉钉线收官":

1. **DingTalk Sync Hardening v1** — code basically complete; this document takes it to **运行态收官**
   (runtime-closeout): observability restored, deploy reproducible, switches owned, UAT scaffolded.
2. **Canonical Org & Provider Transfer v1** — **design done** (#4215 / #3944 landed), core impl **not
   started**; its MVP sequencing is a separate plan (see §4). It starts only after milestone 1 closes.

## 1. What runtime-closeout means (why code-complete ≠ closed)

Hardening v1's *code* is on main, but three runtime facts kept it from being closed: the OAuth-stability
**monitor was blind** (401 on a now-token-gated metrics scrape), the deploy was **not reproducible**
from templates (the switches the code reads weren't in any `.env` template), and the **switch decisions
+ real UAT** weren't recorded. DT-CLOSE-01…05 close exactly those.

## 2. Deliverables (DT-CLOSE-01…05)

| Ticket | What | PR | State | Model |
| --- | --- | --- | --- | --- |
| **DT-CLOSE-01** | Authenticate the OAuth-stability `/metrics/prom` scrape — token resolved on the deploy host (backend-container runtime, secret-safe), `x-metrics-token` header, unauth fallback; contract test that reddens if auth is removed | **#4236** | ✅ **MERGED** `cd1a36428` | me (Opus care — auth) |
| **DT-CLOSE-02** | DingTalk env contract — every closeout key in `docker/app.env.example` + staging with code-accurate default + DANGER comment; contract test: missing-key → red, dangerous switch shipped ON → red | **#4240** | armed (squash) | Sonnet + Opus gate |
| **DT-CLOSE-03** | Real-enterprise UAT evidence-pack scaffold — default-off smoke, U1–U13, real-callback corp-anchor, values-free rules | **#4241** | armed (owner/ops executes) | Sonnet |
| **DT-CLOSE-04** | Switch-ruling ledger — every switch = explicitly-deferred or must-verify-enabled + rollback + owner; no unowned default-off | **#4241** | armed | Sonnet |
| **DT-CLOSE-05** | Consolidated-MD status errata — #159 CLOSED, #4218/#4228 MERGED, #4176 superseded; reaffirm two-milestone split | **#4241** | armed | Sonnet |

## 3. Verification — VERIFIED vs OWNER/OPS-GATED (kept separate)

### 3.1 VERIFIED (code, this session)

- **DT-CLOSE-01**: `bash -n` clean; contract test 4/4; **auth-mutation reddens** (reverting to the bare
  scrape fails the test); CI-wired.
- **DT-CLOSE-02**: contract test 6/6; **two mutations redden** (missing key; dangerous switch shipped
  `=true`); CI-wired alongside DT-CLOSE-01. Every template default was checked against the code default
  by the Opus gate.
- Both lanes passed an independent **Opus adversarial gate** — overall APPROVE, no P1/P2; the one P3
  (value-drift) is addressed for the dangerous-switch class.

### 3.2 OWNER/OPS-GATED (this environment cannot produce)

| Item | Why not here | Ticket |
| --- | --- | --- |
| OAuth-stability "immediate + next scheduled run consecutive success" | needs the live deploy host + secrets | DT-CLOSE-01 (ops step) |
| Real-enterprise UAT U1–U13 + real-callback corp-anchor (does the callback carry `eventCorpId`/`corpId`?) | needs a deployed SHA + a real DingTalk corp + real people | DT-CLOSE-03 |
| Each switch flipped to "verified-enabled" | needs the UAT evidence above | DT-CLOSE-04 |

**Switch posture (encoded conservatively, per owner):** deprovision + primary-dept inference + Stream
stay **OFF** (each with its exact flip-precondition in the ledger); OAuth shared-state **must be ON** on
multi-replica; retention window **> longest approval SLA**; interactive-card Stream only after U1–U13 all
green + the #4171 real-callback anchor proof.

## 4. Forward: milestone 2 (design landed, impl gated)

`docs/development/canonical-org-provider-transfer-v1-mvp-implementation-plan-20260713.md` (#4242)
sequences the landed #4215 / #3944 designs into gated MVP increments — Canonical Org MVP (bootstrap →
CRUD → normalized manager → binding FK chain → `(org,purpose)` routing → **approval-routing real-DB
parity first** → suggest-only reconciliation), then Transfer MVP (schema/API → source freeze → two-corp
proof → single-tx atomic rebind → group rebind/drop → workbench). Feishu/WeCom + full consumer migration
deferred. **Starts only after Hardening v1 closes.**

## 5. Definition of runtime-closeout DONE (Hardening v1)

- DT-CLOSE-01 merged + the live monitor shows consecutive successful runs (ops).
- DT-CLOSE-02 merged; a deploy is reproducible from the templates (contract-guarded).
- DT-CLOSE-03 evidence pack executed against the deployed SHA with U1–U13 + real-callback anchor (owner/ops).
- DT-CLOSE-04 ledger: every switch owned (verified-enabled or explicitly-deferred), never an unowned default-off.
- DT-CLOSE-05 docs accurate.

Items 1–2 + the docs are delivered here; items requiring the live host / a real corp are handed to
owner/ops with the scaffolding to execute them. **Hardening v1 is at runtime-closeout stage — not "all
done", and explicitly separate from milestone 2.**

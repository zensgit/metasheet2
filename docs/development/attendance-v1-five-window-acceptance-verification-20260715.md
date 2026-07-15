# Attendance v1 — Five-Window API/DB Helper Smokes: Verification Record (2026-07-15)

> **口径(owner 复审 2026-07-15,CHANGES applied): these are the five `*_API_DB_SMOKE_PASS` HELPER
> passes — NOT the final `*_STAGING_SMOKE_PASS` acceptances.** The final stamps require the §6
> manual-browser/owner-decision items below plus the §7 consolidated residue sweep.

> Executes owner steps 2-4 of the close-out sequence at the helper level. All five API/DB
> helper smokes PASSED serially on ONE deployed SHA, each helper-scoped residue=0.

## 1. The frozen window

- **DEPLOY_SHA (frozen): `d65a77c250d74143e6671cc424deb7319eadeb51`** — staging backend+web
  images pinned to this full-SHA tag; identity proven via the dual-channel verifier
  (health metadata is env-pinned stale on staging — L6 precedent — so identity = exact
  container image-tag match + health `ok:true`).
- Deployed with the RD window env (`ATTENDANCE_SCHEDULER_ENABLED=true`,
  `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED=true`, `ATTENDANCE_REPORT_DIGEST_ENABLED`
  UNSET) flipped together with the deploy per bundle §3.4. Deploy run: 29376418862
  (migrations `Pending: 0`, auth round-trip 200/200).
- No attendance feature changes rode into the window: every post-freeze merge was
  verify-tooling/harness or other-line work (each landed through head-scoped adversarial
  gates, review ledger `/tmp/pr4271-review-claude-20260714.md`, rounds 1-25).

## 2. Migration alignment (owner step 2 proofs)

Run **29376184845** (`action=migrate`, after two fail-closed attempts hardened the tooling):
- **Backup**: `pg_dump -Fc` retained ON-HOST at
  `/home/mainuser/window-runner-backups/staging-20260714T232731Z-pre-migrate.dump`
  (sha256 `386ec57a…`, 45,766,188 bytes; never uploaded — public-repo artifacts are
  world-readable).
- **Clone rehearsal**: restored into `window_runner_rehearsal` under DB-level
  `session_replication_role='replica'` (a partition-inherited row trigger fires during COPY
  otherwise; `pg_restore --disable-triggers` was empirically proven inert for full restores —
  run 29347058494), 0 restore errors, rehearsal migrate 240→264 applied, `Pending: 0`.
- **Isolation proven channel-independently**: real DB applied-count `240 → 240` (unchanged)
  across the rehearsal migrate; guard defends even against a silently-ignored DSN override
  under non-env secret providers.
- **Apply**: real staging DB → `Pending: 0`; health + auth round-trip green.

## 3. The five API/DB helper smokes — all HELPER-PASS, one SHA, serial per bundle §4

| # | Window | Run | Stamp (verbatim) |
|---|---|---|---|
| 1 | AE-4 result-edit | 29383379748 | `AE4_RESULT_EDIT_API_DB_SMOKE_PASS deploy=d65a77c250d74143e6671cc424deb7319eadeb51 stamp=ae4-smoke-gh29383379748a1 org=default notifyRecord=d8381e2d-ba11-4393-9b88-bfab580704e2 skipRecord=896ce383-45d6-47fa-a17f-9911a598bd62 residue=0` |
| 2 | RD-4/5 report digest | 29383448054 | `RD45_REPORT_DIGEST_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=rd45-smoke-gh29383448054a1 org=rd45-smoke-gh29383448054a1-org produced=1 dedupOk=1 residue=0` |
| 3 | OT-bank v1-8 | 29383549381 | `OTBANK_V18_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=otbank-v18-smoke-gh29383549381a1 org=default cycle=cb5e7b71-7093-476d-9f2e-05f3a9211b25 residue=0` |
| 4 | MP-6 makeup punch | 29391693975 | `MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=mp6-smoke-gh29391693975a1 org=default quota=1 approvals=1 residue=0` |
| 5 | HMR-5 missed-punch reminder | 29391755628 | `HMR5_API_DB_SMOKE_PASS deploy=d65a77c2… stamp=hmr5-smoke-gh29391755628a1 org=hmr5-smoke-gh29391755628a1-org sendPosture=worker-on:failed_recognized residue=0` |

Zero failed assertions in every passing run; each smoke snapshot+restored its own settings
keys (verified per-run in the artifacts: settings-before/after + in-log restore asserts).

## 4. Live-failure fixes made during the window (all verify-tooling/harness, gated, landed)

| Run that failed | Root cause | Fix |
|---|---|---|
| 29313154282 | staging repo dir unwritable by deploy user | #4275 override → per-run OUTPUT_DIR |
| 29314093729 | staging health metadata env-pinned stale (L6) | #4276 image-tag identity fallback (deploy) |
| 29340321213 | partition-inherited trigger fires during rehearsal COPY | #4284 (+#4291 after #4284's `--disable-triggers` was empirically falsified) → DB-level replica-role suppression |
| 29378042837 | smoke pre-check lacked the identity fallback | #4294 dual-channel smoke identity (exact-ref) |
| 29380129251 | AE-4 harness predates `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` | #4296 prepare→commitToken flow |
| 29383604023 | MP-6 harness sent attachment in body.metadata (server reads top-level) | #4301 top-level `attachmentUrl` |

Every failure was fail-closed (real staging DB untouched until proofs held); the owner's
"real acceptance = rerun the rehearsal" principle caught one plausible-but-wrong fix (#4284).

## 5. Consolidated close (owner step 7) — status

- Final-state capture: run 29391832015 (`action=status` — settings/env/containers archived).
  **NOT the §7 sweep** — the cross-smoke residue SQL is being added as `action=residue-sweep`
  and must run green (every §7 count = 0) before the final stamps can be issued.
- Strict-gate rerun (prod): run 29391835742 — **overall SUCCESS**, executed at main
  `91d924fb1`, a successor of the frozen `d65a77c25`. **Equivalence record for owner
  acceptance**: `git diff --stat d65a77c25..91d924fb1` over `plugins/plugin-attendance/`,
  `packages/core-backend/src/`, and the attendance web views is EMPTY — the 13 intervening
  commits are attendance harness/ops fixes (#4294/#4296/#4301, scripts/ops only), owner docs
  ratifications (#4196/#4203/#4195/#4239/#4287), and multitable/web work
  (#4285/#4290/#4295/#4298/#4300). Zero attendance-runtime change. If the owner does not
  accept equivalence, the alternative is an exact-SHA rerun.
- Tracker backfilled in the same PR (helper-PASS framing, real stamp names).

## 6. Remaining before the final `*_STAGING_SMOKE_PASS` stamps + 关闭 issue-3317 + tag

Per-window manual-browser / owner-decision items (owner review 2026-07-15):
1. **AE-4**: manual AE-3 modal browser evidence (:8082 logged-in session; harness refuses to
   claim the UI PASS). Sanitized screenshots → #3317.
2. **RD-4/5**: config-card browser verification + a real `sendProof` (the helper's digest
   production ≠ delivery proof).
3. **OT-bank v1-8**: OQ-1 / OQ-2 owner decisions per its runbook.
4. **MP-6**: OQ-1 / OQ-3 owner decisions per its runbook (single-tenant posture etc.).
5. **HMR-5**: confirm-snapshot browser step + a real notification channel + owner judgment —
   `sendPosture=worker-on:failed_recognized` only proves the worker correctly recognized a
   terminal failure, NOT that a notification was really delivered.
6. **§7 consolidated residue sweep** green (all counts 0) + env-flag rollback + settings
   baseline confirmation at window close.
7. **DingTalk S1-S8 / U1-U13** — esp. U11-a real corp-anchor callback; B1 NOT in v1.
8. Owner review → final stamps issued → 关闭 issue-3317 → release tag at full SHA
   `d65a77c250d74143e6671cc424deb7319eadeb51`.

After those: the owner's declaration per the 2026-07-14 ruling — attendance v1 development,
DingTalk E1-E4 integration, and production acceptance closed; B1/S7/飞书/native-hardware → vNext.

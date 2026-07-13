# DingTalk Sync & Org-Transfer Line — Consolidated Design and Verification

Date: 2026-07-12 (final: 2026-07-13, Wave 0 closed)
Baseline: `origin/main @ 66c7459a8` (post-#4181 / #3941+errata / #4215)
Scope: the whole "DingTalk directory sync → canonical org → provider transfer" line —
the development-order plan, the design of each increment, and honest verification of what
is built versus planned.

This is the roll-up deliverable, closing the **Wave 0 docs line**. The per-artifact detail
lives in (all now **on `main`**):

- `docs/development/dingtalk-org-transfer-phase1-development-and-verification-20260712.md`
  (Phase 1 corp_id-immutable guard — landed with #4181).
- `docs/development/provider-org-transfer-development-plan-20260709.md` **(Rev 3)** — the
  Wave 4 transfer engine (#3944).
- `docs/development/local-directory-provider-canonical-org-anchor-development-plan-20260709.md`
  — the Wave 3 local canonical-org substrate (#4215).
- `docs/research/dingtalk-corp-switch-assessment-20260708.md` **(Rev 5)** — the assessment
  (#3941 + post-#4181 errata #4221).

## 0. Honest headline

The DingTalk hardening tickets (17/17 H/OPS/PERF) and their follow-ups are already on
main. What remained on this line was: **one unfinished P1 guard**, an **un-executed
real-DingTalk UAT / switch-decision set**, and a **not-yet-started local-org + org-transfer
product line**. **Wave 0 is now closed**: the P1 guard is merged and every plan/assessment
doc is landed, accurate to post-#4181 main, with no dead refs or stale status. Everything
from real-env UAT onward is owner/ops-gated or depends on a staging proof this environment
cannot produce — it is sequenced here, not force-built. **The product line itself (Waves
1–5) is NOT done; what is done is Wave 0.**

## 1. Two milestones, six waves

Per owner review (2026-07-12), the line splits into two formal milestones:

- **DingTalk Sync Hardening v1** = Waves 0–2.
- **Canonical Org & Provider Transfer v1** = Waves 3–4. (Wave 5 = optional second provider.)

| Wave | Work | Done-gate | State |
| --- | --- | --- | --- |
| **0 — stop the bleeding** | fix/disarm **#4181** (corp_id immutable); rebase+merge **#4171** (corp-anchor UAT probe); refresh **#3941** to as-built; revise **#3944 → Rev 3**; commit the local-org plan | no OPEN P1/P2; docs have no dead refs / stale status | ✅ **CLOSED** — all landed with owner APPROVE at each step; real merge SHAs in §3 |
| 1 — real-env UAT | resolve deploy-host disk (#159); deploy the exact main SHA; run default-off smoke + interactive-card **U1–U13** | a real deploy of current main + evidence pack (time, SHA, result, rollback point) | **owner/ops** — sandbox cannot reach the deploy host |
| 2 — switch closeout | per-switch ruling for deprovision / primary-department / OAuth shared-state / retention / alert-webhook | each switch "verified-enabled" or "explicitly-deferred", never an unowned default-off | **owner** — see §6 |
| 3 — local org substrate | `provider='local'` integration; editable departments/memberships; external-department binding; explicit routing policy (by org+purpose, not array[0]); normalized manager relation | local department IDs are the stable anchor; DingTalk disappearing does not delete the local org | **design committed** this session; impl gated |
| 4 — org transfer | transfer/decision tables; source freeze; dry-run; two-corp proof; atomic user rebind; group rebind/drop; admin UI; never a direct corp_id edit | resumable, idempotent, auditable, reversible | **design Rev 3**; impl gated on design merge + staging proof |
| 5 — second provider | WeCom/Feishu directory driver | only on a named customer case; no premature plugin SPI | deferred (YAGNI) |

## 2. Development order (the recommended sequence)

1. **Wave 0 (✅ done).** Land the corp_id-immutable guard, merge the UAT probe, make the
   plans accurate + committed. This was the only step that changed runtime code, and it is
   a *defensive* change (a `throw` before an `UPDATE`).
2. **Wave 1 (owner/ops).** A real deploy + UAT is the precondition for turning any switch
   on. It cannot be simulated here.
3. **Wave 2 (owner).** Resolve each feature switch (§6) to an owned decision.
4. **Wave 3 (design ready).** Build the local canonical-org substrate — the foundation that
   makes an org transfer a *binding change* instead of a destructive rewrite. Phased:
   provider bootstrap → department-binding table → routing policy → consumer adoption →
   external reconciliation.
5. **Wave 4 (gated).** Build the transfer engine on top of Wave 3: schema + admin API +
   no-op adapter first, then the two-corp coexistence proof (staging), then the atomic
   user-identity rebind, then group-destination rebind/drop, then the admin UI.
6. **Wave 5 (YAGNI).** Only when a real second-provider customer case exists.

The ordering constraint that matters: **Wave 4 depends on Wave 3** (stable local anchors)
and on a **staging two-corp proof** (does `directory_accounts(provider, external_key)`
collide across corps? — analytically yes, because DingTalk `unionId` is union-scoped, so a
tenant-scoped key is almost certainly required). Neither can be short-circuited.

## 3. Delivered state — Wave 0 CLOSED (real merge SHAs)

Every Wave-0 artifact is now **merged to `main`**, each landed under an explicit owner
verdict (APPROVE / best-of-both ruling / CHANGES_REQUESTED→fix→land):

| Artifact | PR | Merge SHA | Notes |
| --- | --- | --- | --- |
| corp-anchor UAT probe | **#4171** | `663511527` | values-free presence + split refusal reasons; prerequisite for the interactive-card switch |
| corp_id-immutable guard (code) | **#4181** | `0e088d3b1` | absolute immutable-once-set (no probe, no env bypass, TOCTOU-closed); owner APPROVE at head `529244e72` + two P3 wording fixes; carries the Phase-1 dev/verification MD + real-DB regression (two-point CI-wired) |
| corp-switch assessment Rev 4 (best-of-both) | **#3941** | `00ec0d965` | owner-ruled merge of two parallel sessions' versions: DT-OPS-01 #3905 status + canonical-org_id conclusion (theirs) + full `file:line` re-anchoring and §6 "cannot run today" / §7 bind-writes-identity semantic fixes (this session) |
| assessment post-#4181 errata (Rev 5) | **#4221** | `8bc7bbfe4` | #4181's merge shifted every `directory-sync.ts` anchor ~+44 lines and made "corp_id editable / #4181 not merged" behaviorally false; narrow errata, no history rewrite |
| local canonical-org substrate plan (Wave 3 design) | **#4215** | `66c7459a8` | standalone doc (owner: not compressed into #3944); resolves the 3 design questions — immutable `local:<org_id>` corp_id, **at-most-one** active local integration (DB partial unique index; at-least-one = bootstrap service), and department-binding single-org integrity via a **buildable FK chain** (binding carries both integration ids; `(dept,integration)`+`(integration,org)` composite FKs — a direct `(dept,org)` FK is impossible, `directory_departments` has no `org_id`) |
| provider org-transfer plan Rev 3 (Wave 4 design) | **#3944** | `65ed5ef62` | permanent-immutable §12.1 (unreachable "clear" removed) + org_id-umbrella §4.1 pointing at the landed #4215 substrate; squash-merged after #4215 |
| this consolidated MD | (this PR) | — | closes the Wave 0 docs line |

**Process note (for the record):** two Claude sessions worked this line in parallel and
collided on #3941/#3944. Neither clobbered the other; the owner ruled best-of-both, which is
what merged. The one Wave-0-adjacent item still open is the **snapshot-protection CI wiring
(#4218)** — disarmed, blocked on an owner decision about the CI test-DB's
`MIGRATION_EXCLUDE` (the suite needs `snapshots.tags` / `protection_rules` /
`change_management` tables whose migrations that DB skips); it belongs to the security line,
not this one.

## 4. Design — the three-layer model

The line's architecture is one idea applied three times: **the local product entity is the
anchor; the external provider handle is a rebindable binding.**

1. **Local canonical-org substrate (Wave 3).** A `provider='local'` integration inside the
   existing `directory_*` tables — no second org tree. Local departments/accounts/
   memberships are editable product truth; the manager relationship is a normalized
   provider-neutral relation (owner ruling), not parsed out of DingTalk `raw.leader_in_dept`.
   A `directory_department_bindings` table maps external departments to local ones.
2. **External provider projections.** DingTalk (later WeCom/Feishu) integrations remain
   mirrored directories whose sync writes projection rows, not product truth. Which
   integration is canonical for each purpose is chosen by an explicit `(org, purpose)`
   routing policy — **never array[0]** (owner ruling), resolved fail-closed.
3. **Transfer engine (Wave 4).** Changing tenant is a first-class, resumable, auditable
   reconciliation over provider-scoped bindings (user identity, group webhook, notification
   credential, card target, department/member-group projection) with dry-run and rollback —
   **never an in-place `corp_id` edit**. The Wave 0 guard enforces that "never."

### 4.1 The #1 hazard and its Wave 0 fix (MERGED — #4181 `0e088d3b1`)

`updateDirectoryIntegration` runs `UPDATE directory_integrations SET corp_id = $4 …` in
place. Re-tagging a synced integration to a different corp is a tenant change disguised as
an edit: the next absence sweep marks every account/department of the **old** corp inactive
(no longer "seen" under the new corp), **silently mass-deactivating the organization**.

The landed rule (#4181, merged): **corp_id is immutable once set.** The guard sits in
`updateDirectoryIntegration` after the input is normalized and **before the UPDATE**, issues
**no record probe**, and has **no env bypass** — so it also closes the *first-sync TOCTOU
window* (corp_id set, zero rows synced yet, an interleaved PUT swapping corp under the
in-flight first sync) that a "block only if it has synced records" rule left open. Initial
set and same-corp resend pass; a genuine org change must go through the Wave 4 transfer.

## 5. Verification — VERIFIED vs PLANNED (kept separate deliberately)

### 5.1 VERIFIED — Phase 1 corp_id-immutable guard (code; MERGED `0e088d3b1`, required checks green)

- `tsc --noEmit`: **exit 0** (after rebase onto current main).
- Unit `tests/unit/directory-tenant-change-guard.test.ts`: **4/4** — a change to a set
  corp_id is blocked with **`query` called exactly once** (getIntegrationRow only: no
  probe, no UPDATE), proving the block is independent of synced state; the env flag set to
  `true` still blocks; same-corp resend and initial-set apply the UPDATE.
- Real-PG `tests/integration/directory-tenant-change-immutable.db.test.ts`: **5/5** — the
  first-sync window (corp set, zero records) → swap rejected, row unchanged; blocked with
  records present; same-corp + initial-set succeed. **Two-point CI-wired** (excluded from
  the no-DB default job so it cannot skip-green; added to the real-DB lane whitelist).
- **Load-bearing mutation proven**: neuter the `throw` → first-sync + records-exist tests
  redden; restore → green.
- **Independent adversarial re-gate (Opus)**: verdict **APPROVE** — `toctouClosed: true,
  bypassFound: false, mainRevertFound: false, overRestrictionFound: false`. Branch diff is
  **+477/−0** (additive-only).

### 5.2 PLANNED — not yet built or not verifiable here (do NOT read as done)

| Item | Why not verified now |
| --- | --- |
| Real-env UAT U1–U13 (Wave 1) | needs a real deploy of the exact main SHA on the deploy host; sandbox cannot reach it |
| Two-corp coexistence proof (Wave 4 gate) | needs a staging env + two real DingTalk corps; the DB-level collision *mechanism* can be shown, the production proof cannot |
| Local-org substrate tests (Wave 3) | substrate not built; test matrix specified in the local-org plan §13 |
| Transfer engine tests (Wave 4) | engine not built; test outlines in the transfer plan §9.4/§10.4 |
| Per-switch enable evidence (Wave 2) | each switch needs its own owner ruling + evidence (§6) |

The Wave 3/4 plans each carry a **verification matrix** enumerating the evidence each
increment must produce (real-DB parity, archive-not-delete, stale-binding-not-inactive,
atomic single-transaction rebind, etc.). Those are acceptance criteria, not results.

## 6. Switch decisions (owner guidance — all still owner-gated)

- `DIRECTORY_DEPROVISION_ENABLED` — stays **off** until audited reactivation/rollback +
  real-data preview + a small canary.
- `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` — verify against real `dept_order_list` + dry-run;
  prefer **per-integration** over a global env.
- `DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE` — must be **on** + Redis-verified for
  multi-replica; single-replica may defer.
- `DINGTALK_DELIVERY_RETENTION_DAYS` — set **before** enabling interactive cards; window
  must exceed the longest approval SLA.
- `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` — stays **OFF** until U1–U13 pass **and** the
  #4171 real-callback anchor proof lands.
- The user/list primary-source flip is deferred behind a **2,000-user-tenant benchmark** of
  the existing `externalUserDetailCalls` path.

## 7. Model selection by difficulty (per the goal)

- **Fable 5** — reserved for low-stakes drafting; not used on the security/sync-core guard.
- **Sonnet 5** — the well-specified backend impl (Phase 1 guard) and mechanical
  verification tasks (line-ref refresh).
- **Opus 4.8** — every adversarial gate and every design/synthesis doc (transfer Rev 3,
  local-org substrate, this MD), and the security/sync-core review. Rationale: cheapest
  model that meets the difficulty, but always gate a sync-core or security change with the
  strongest reviewer. (The one Sonnet doc sub-task that stalled was re-done directly rather
  than retried, and every doc was put through an Opus accuracy gate regardless.)

## 8. What remains + who owns it (Wave 0 closed; everything below is Waves 1–5)

- **Wave 1** — ops: deploy-host disk (#159) + a real deploy of the exact main SHA + the
  U1–U13 evidence pack.
- **Wave 2** — owner: resolve each switch in §6 to "verified-enabled" or
  "explicitly-deferred".
- **Wave 3** — a per-phase go to start the local-org substrate impl; the design (#4215) is
  landed and its three schema questions are resolved.
- **Wave 4** — gated on the Wave 3 substrate + the staging two-corp coexistence proof; the
  design (#3944 Rev 3) is landed.
- **Wave 5** — only on a named second-provider customer case.
- **#4218 (snapshot-protection CI wiring; security line)** — disarmed, awaiting the owner's
  ruling on the CI test-DB `MIGRATION_EXCLUDE` (un-exclude the 3 snapshot/protection/
  change-management migrations inside #4218, or land the un-exclusion as its own verified
  PR first).

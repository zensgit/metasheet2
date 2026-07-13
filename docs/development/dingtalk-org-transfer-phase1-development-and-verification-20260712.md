# DingTalk Sync (Org-Transfer) — Line Review, Remaining-Work Plan, and Phase 1 Development & Verification

Date: 2026-07-12
Scope: review the DingTalk directory-sync code + the org-transfer / canonical-org-anchor target
documents, identify what is undeveloped, plan the remaining development order, and deliver the safe,
unblocked first increment.

## 1. What this line is

Two target documents define the "DingTalk sync" architecture direction. **Both are still draft/open —
neither is merged into `main` yet**, so this MD does not treat them as stable in-repo references:

- The **organization-transfer development plan** (PR **#3944**, Rev 2, currently open) — a first-class
  **organization-transfer workflow** for when a customer moves to a different DingTalk corp (later WeCom /
  Feishu). Local product entities stay as stable anchors; only the external handles are rebound, item by
  item, with decisions + dry-run + audit. Owner ruling: do not merge as-is; it must be revised to **Rev 3**
  absorbing this PR's immutable-corp_id rule and the local canonical-org plan.
- A **local canonical-org-anchor plan** (draft, not yet committed) — make MetaSheet own a stable local org
  anchor (`provider = 'local'`) inside the existing `directory_*` model, treating DingTalk/WeCom/Feishu as
  external provider projections. Owner Wave 0 task: bring this into formal, committed docs.

The transfer plan is the concrete, phased one; the anchor plan is the foundational direction it builds
toward.

## 2. Gap analysis — what is undeveloped (as of origin/main this date)

- **The org-transfer line has ZERO implementation.** No `directory-transfer` module, no
  `provider_org_transfers` / `provider_org_transfer_decisions` tables, no corp-switch guard in
  `updateDirectoryIntegration`.
- The design is **not yet merged**: #3941 (assessment) and #3944 (dev plan) are still **open docs PRs**.
- All implementation phases (1–6) are undeveloped.

## 3. The #1 hazard (why Phase 1 comes first)

`packages/core-backend/src/directory/directory-sync.ts` → `updateDirectoryIntegration` runs
`UPDATE directory_integrations SET corp_id = $4 …` in place. Changing `corp_id` to a **different** corp on
an integration that already has synced accounts is a tenant change disguised as an ordinary edit: the very
next sync's absence sweep marks every account/department of the **old** corp inactive (they are no longer
"seen" under the new corp), **silently mass-deactivating the organization**. This is the highest-severity,
most self-contained risk, and closing it does not depend on any later phase.

## 4. Remaining development order (recommended)

| Phase | Deliverable | Autonomy this session | Gating reason if not |
| --- | --- | --- | --- |
| **1. Guardrail (§12.1)** | Block in-place `corp_id` tenant change on synced integrations; explicit test/dev escape hatch; admin-visible 409 | **DONE this session** (see §5) | — |
| 1b. Source-sync freeze (§12.2) | Freeze source sync while a transfer is active | Deferred to Phase 2 | Needs the transfer record (there is no "active transfer" to key off until Phase 2 exists) |
| 2. Schema + API skeleton | `provider_org_transfers` + `_decisions` migrations, repository/service lifecycle, admin-only create/read/scan/dry-run/apply/cancel routes, no-op adapter + contract tests | Planned next; NOT done here | Migrations on a live-synced schema + an admin API against an as-yet-unmerged design (#3944) — wants explicit per-phase go and design merge first |
| **2-Gate. Two-corp coexistence proof** | Stage two DingTalk corps with one overlapping person; prove whether `directory_accounts(provider, external_key)` collides; if so, migrate to tenant-scoped key `(provider, tenant_key, external_key)` | **Hard-gated — cannot be done autonomously** | Requires a staging environment + two real DingTalk corps (this sandbox cannot reach the deploy host and cannot create real corps). NOTE: DingTalk `unionId` is union-scoped, so the same person across two corps is **expected to collide** on a `unionId`-derived `external_key` — the tenant-scoped key strategy is almost certainly required. A DB-level integration test can demonstrate the collision mechanism, but the production proof needs staging. |
| 3. User-identity adapter | Scan source-bound users, decisions, **single-transaction rebind** of the one `user_external_identities` row, grant upsert, audit | Blocked | Depends on the 2-Gate key-strategy decision, and performs identity-layer writes — risk-sensitive; needs the gate resolved + explicit go |
| 4. Group-destination adapter | Scan `dingtalk_group_destinations`/rules, rebind webhook+secret keeping `destinationId` stable, drop=disable | After Phase 2 | Depends on the transfer substrate (Phase 2) |
| 5. Admin UI | Transfer list/detail, source/target selector, decision worklist, dry-run, apply progress | After Phase 2–4 APIs | Depends on the backend |
| 6. Provider expansion | Thin WeCom/Feishu driver | Later (YAGNI) | Only when a second provider is a real customer case |

**Honest headline:** the safe, high-value, unblocked step is **Phase 1**. Everything from Phase 2 onward
either changes live-synced schema, performs identity-layer writes, or depends on a **staging proof that
cannot be produced in this environment** — so it is planned + sequenced here, not force-implemented.

### 4.1 Owner roadmap (authoritative, 2026-07-12) — supersedes the phase table above for sequencing

The owner's real-time review reframed the line: the 17/17 H/OPS/PERF hardening tickets and follow-ups are
already on main; what remains is **one unfinished P1 guard (this PR), an un-executed real-DingTalk
UAT/switch decision set, and the not-yet-started local-org + org-transfer product line** — split into two
formal milestones:

- **DingTalk Sync Hardening v1** = Waves 0–2.
- **Canonical Org & Provider Transfer v1** = Waves 3–4.

| Wave | Work | Done-gate |
| --- | --- | --- |
| **0 — stop the bleeding** | disarm/fix **#4181** (this PR, immutable-corp_id rework); rebase + merge **#4171** (corp-anchor UAT probe) after re-running the callback real-DB suite; refresh **#3941** to as-built; revise **#3944 → Rev 3** absorbing #4181 + local-org; bring the local-org plan into committed docs | no OPEN P1/P2; docs have no dead refs / stale status |
| 1 — real-env UAT | resolve deploy-host disk (#159); deploy the exact main SHA; run the default-off smoke + interactive-card **U1–U13** | a real deploy of current main, with an evidence pack (time, SHA, result, rollback point) |
| 2 — switch closeout | per-switch ruling for deprovision / primary-department / OAuth shared-state / retention / alert-webhook | each switch is "verified-enabled" or "explicitly-deferred", never an unowned default-off |
| 3 — local org substrate | `provider='local'` integration; editable departments/memberships; external-department binding; **explicit routing policy (by org + purpose, not "take array[0]")**; manager relationship becomes a normalized field/relation (not hidden in DingTalk `raw.leader_in_dept`) | local department IDs are the stable anchor; DingTalk disappearing does not delete the local org |
| 4 — org transfer | transfer/decision tables; source freeze; dry-run; two-corp proof; atomic user rebind; group rebind/drop; admin UI; **never a direct corp_id edit** | resumable, idempotent, auditable, reversible |
| 5 — second provider | WeCom/Feishu directory driver | only on a named customer case; no premature plugin SPI |

**Switch decisions (owner guidance, all still owner-gated):** `DIRECTORY_DEPROVISION_ENABLED` stays off
until audited reactivation/rollback + real-data preview + small canary; `DIRECTORY_PRIMARY_DEPT_FROM_ORDER`
verify real `dept_order_list` + dry-run, prefer per-integration over global env; `DINGTALK_OAUTH_REQUIRE_
SHARED_STATE_STORE` must be on + Redis-verified for multi-replica (single-replica may defer);
`DINGTALK_DELIVERY_RETENTION_DAYS` set before enabling interactive cards, window > longest approval SLA;
`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` stays OFF until U1–U13 + the #4171 real-callback anchor proof;
the user/list primary-source flip is deferred behind a 2,000-user-tenant benchmark of the existing
`externalUserDetailCalls` path.

## 5. Phase 1 delivered this session — corp_id IMMUTABLE once set

Branch: `claude/dingtalk-org-transfer-phase1-guardrails` (off origin/main).

The first cut of this guard blocked a corp_id swap "only when the integration already has synced
records." Owner review (real-time, 2026-07-12) found that rule leaves a **first-sync TOCTOU window**:
`syncDirectoryIntegration` reads the corp config, claims the run lease, then pulls and writes rows. During
the first sync (corp_id already set, no account/department rows written yet) an interleaved PUT could
change corp_id from under the in-flight sync, which then writes the OLD corp's data into the now-retagged
integration — re-arming the exact mass-deactivation on the next sync. So the rule was made **absolute and
race-free**:

- **In an ordinary PUT, an already-set `corp_id` can NEVER change.** The guard (in
  `updateDirectoryIntegration`, after `normalized` is computed, before the `UPDATE` — so a blocked change
  performs zero mutation, and issues **no record probe** at all) throws when `current.corp_id` is
  non-empty and the input's corp_id differs.
- Initial set (current empty → a value) and same-corp resend pass through. A "clear" is unreachable —
  `normalizeIntegrationInput` throws `'corpId is required'` earlier.
- **No production escape hatch.** The `DIRECTORY_ALLOW_ACTIVE_CORP_ID_CHANGE` env bypass was removed
  entirely. A mis-entered corp_id (before first sync) is corrected by delete-and-recreate; a genuine
  organization change must go through the org-transfer workflow (Wave 4).
- New exported `DirectoryTenantChangeBlockedError`; the admin PUT route maps it to
  **`409 DIRECTORY_TENANT_CHANGE_BLOCKED`**.

This closes the design's #1 hazard (§3, §12.1). §12.2 (transfer-aware source-sync freeze) remains deferred
to the transfer substrate (Wave 4), because there is no "active transfer" to key off until then.

## 6. Verification

- `tsc --noEmit -p tsconfig.json`: **exit 0**.
- Unit tests `tests/unit/directory-tenant-change-guard.test.ts`: **4/4 pass** — a change to a set corp_id
  is blocked with NO record probe and the `UPDATE` never issued (proving the race window is closed
  regardless of synced records); the env bypass no longer works (still blocked with the flag set);
  same-corp resend allowed; initial-set allowed.
- **Real-DB integration test** `tests/integration/directory-tenant-change-immutable.db.test.ts` (against
  real Postgres): the first-sync window is blocked (corp_id set, zero synced records → swap rejected, row
  unchanged); blocked when records exist; same-corp resend and initial-set succeed. Wired into the real-DB
  CI lane (two-point: excluded from the no-DB default job so it cannot skip-green).
- **Load-bearing mutation**: neuter the `throw` → the block tests redden. (The earlier version's
  predicate/probe mutations no longer apply — there is no probe.)
- **Independent adversarial re-gate (Opus)** on the reworked immutable rule — see the gate report; the
  earlier gate's one P3 and the owner-found TOCTOU are both closed by this rule.

## 7. What remains + how to proceed

- **Merge the design docs** (#3941/#3944) so Phase 2+ builds on a ratified plan.
- **Phase 2** (schema + API skeleton + no-op adapter) is the next safe increment once the design is merged
  and you give a per-phase go; it is substantial but low-risk (new tables, admin-only API, no real writes).
- **Phase 2-Gate** needs you / ops: stage two DingTalk corps and run the coexistence proof, or accept the
  analytical conclusion (unionId collision ⇒ tenant-scoped directory-account key) and authorize the
  key-strategy migration.
- **Phase 3 (user rebind)** is the core value but is identity-layer + gate-blocked; it should be its own
  narrow PR with a real-DB atomic-rewrite mutation test, done only after the 2-Gate decision.

## 8. Model selection (per the goal)

- Phase 1 implementation: delegated to **Sonnet** (a well-specified, self-contained backend change), then
  reviewed and **adversarially gated by Opus** (the difficulty-appropriate choice for a change to
  sync-core). Fable was reserved for low-stakes drafting; the security-sensitive guard was kept under
  tighter review rather than the cheapest model.
- Rationale: use the cheapest model that meets the difficulty, and always gate security/sync-core changes
  with the strongest reviewer.

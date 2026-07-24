# DingTalk lifecycle line — post-merge findings (T1–T3 · D1–D7)

- Date: 2026-07-24
- Status: **findings — owner decision required on one fork**
- Reviewed at: `origin/main @ 8aad0ef8f` (after #4559 / #4574 / #4575 / #4577)
- Against: `dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md` Rev 4.2 (implementation design lock)
- Companion lock: `dingtalk-directory-admission-activation-lifecycle-design-20260723.md` Rev 4.2

This document records what a read of the merged lane found. It states evidence and the decision
the owner has to make; it does not claim any of it was ratified.

---

## 0. Summary

`dingtalk-lifecycle-line-closeout-20260724.md` presents **D1–D6 (backend)** as landed. The
planner, the ledger helpers and the migration did land. What did not land is the thing that makes
them mean anything: **the deprovision writer was never connected to any of it.** On `main`,
`deprovision-ledger.ts` has no importer.

Consequence if the canary sequence is followed as written and `DIRECTORY_DEPROVISION_ENABLED` is
set to `true`: deprovisions execute the pre-existing path at `directory-sync.ts:4147`, which
writes **no event, no effect row, and no `access_generation` bump**, and takes **no per-user
mutex**. The D7 evidence panel would show an empty ledger, and the restore API would have nothing
to restore from — with no error anywhere to indicate that.

---

## 0.1 Empirical run (real Postgres, `main`'s own code)

Static reads are not behaviour, so the findings below were re-established by **executing merged
`main`**: worktree detached at `8aad0ef8f`, all migrations applied to a throwaway DB
(`d4_probe_20260724`), then `applyDirectoryDeprovisionPolicies` / `previewDeprovisionForUser` /
`restoreDeprovisionEvent` called directly. Probe scripts are session-scratch, not committed.

### A — deprovision with `enabled: true` (what the canary GO turns on)

| | before | after |
|---|---|---|
| `users.is_active` | true | **false** |
| `user_orgs.is_active` | true | **false** |
| grant `enabled` | true | **false** |
| `users.access_generation` | 0 | **0** |
| ledger events / effects | 0 / 0 | **0 / 0** |

Writer returned `applied:true, grantsDisabledCount:1, usersDeactivatedCount:1`. So the person
**was** fully deprovisioned, and **nothing was recorded**. That is the whole finding, measured
rather than inferred.

### B — D7 preview vs a grant that is genuinely ON

Grant row in DB: `enabled = true`. Preview plan effects:
`["clear_user_orgs","set_user_inactive"]` — **no `disable_dingtalk_grant`**. The preview cannot
represent the grant, because it reads `user_external_identities.grant_enabled`, and
`information_schema` confirms that column does not exist on the migrated database.

### C — restore, with controls

Same event shape each time; only the effect's *leg* and the drift condition change.

| Case | Expected | Actual |
|---|---|---|
| **Control 1** — user leg, no drift | success, user reactivated | **SUCCESS**, `is_active` → true |
| **Control 2** — user leg, real drift (user already active) | `DRIFT_CONFLICT` | **`DRIFT_CONFLICT`** ✓ |
| **Subject** — grant leg, real drift (grant still enabled) | `DRIFT_CONFLICT` | **`25P02`**, nothing restored |

The controls matter: they prove the restore machinery and the drift guard both work on a leg that
reads a real column. The grant leg fails in two separate ways:

1. **Drift is not detected.** `currentMatchesAfter` for the grant effect reads the phantom column;
   the query errors, `.catch` turns it into "no grant", and "no grant" is read as *matching*
   `after_active=false`. The gate is satisfied **by the read failing**, so it can never fire — the
   subject case sailed past it despite the grant genuinely still being on.
2. **The restore then aborts unconditionally.** `.catch(() => {})` swallows the JS rejection but
   cannot un-abort a Postgres transaction: every later statement in that transaction fails with
   `25P02`, so the whole restore rolls back and the admin gets an opaque error. Any event carrying
   a `disable_dingtalk_grant` effect is **unrestorable**.

---

## 1. The writer is not wired (P1)

| Fact | Evidence |
|------|----------|
| The D4 writer + D5 supersede helpers are dead code | `git grep "from './deprovision-ledger'" origin/main` → no match. Control: the file exists (`git ls-tree origin/main -- packages/core-backend/src/directory/`) and sibling modules' imports do match, so the empty result is absence, not a bad path. |
| The real writer is untouched by the lane | `applyDirectoryDeprovisionPolicies` (`directory-sync.ts:1462`) — no `access_generation`, no ledger, no `users … FOR UPDATE` |
| `deprovision-restore.ts` exports only a pure evaluator | `evaluateDeprovisionRestoreEligibility`; the restore WRITE lives in `deprovision-evidence-api.ts` |

Note on framing: **#4574's own PR body is accurate** — it says "D2–D4: … ledger/generation
**helpers** + immutability migration". It never claimed the writer was swapped. The overstatement
is in the closeout MD, which lists D1–D6 as done. So this reads as a documentation defect plus an
unfinished step, not a false claim in the PR.

Beyond the wiring, the landed helper would not have been safe to wire as written:

- `writeDeprovisionLedger` opened its **own** `transaction()`, so evidence would commit
  independently of the access-graph write it claims to witness (lock §5.3 requires one
  transaction).
- Every ledger `INSERT` was wrapped in `.catch(() => {})` ("table may not exist in unit mocks") —
  a failed evidence write would have been invisible while the deprovision still committed.
- It set `users.is_active = FALSE` unconditionally, and never applied `clear_user_orgs` or
  `disable_dingtalk_grant` — so the recorded effects and the applied effects were different sets
  ("Apply≈Plan", §11).

---

## 2. Ledger schema deviates from the ratified §5.2 (P1) — **the fork**

`zzzz20260724170000` created the tables but not the enforcement §5.2/§5.2.1 marks mandatory.

| § 5.2 requires | Landed in `zzzz20260724170000` |
|---|---|
| prerequisite `UNIQUE` keys on `directory_accounts (id, integration_id)`, `directory_integrations (id, org_id)`, `directory_sync_runs (id, integration_id)` | none |
| composite FKs `(directory_account_id, integration_id)`, `(integration_id, org_id)`, `(run_id, integration_id)` | none |
| `local_user_id … REFERENCES users(id)` | no FK |
| `link_witness_account_id` / `link_witness_local_user_id` NOT NULL + self-consistency CHECKs | columns absent |
| `policy`, `globally_clear`, `restore_mode`, `resolved_at/by`, `resolve_note` | columns absent |
| `CHECK (event_origin IN ('sync','admin_manual'))` and sync ⇒ `run_id NOT NULL` | absent |
| `CHECK (status IN (…))` on events and effects | absent |
| effects `event_id NOT NULL REFERENCES events ON DELETE CASCADE` | nullable, no FK |
| `CHECK` effect_type ∈ (`membership_changed`,`grant_changed`,`user_changed`) + org_id-by-type | absent; planner emits `clear_user_orgs` / `disable_dingtalk_grant` / `set_user_inactive` |
| `UNIQUE (event_id, effect_type)` | absent |
| **BEFORE INSERT** triggers proving the link existed at apply time, account ∈ integration, integration ∈ org, sync run of same integration | absent (only a partial immutability trigger on UPDATE) |
| child table named `directory_deprovision_event_effects` | named `directory_deprovision_effects` |

**Owner decision.** Two coherent resolutions, and they lead to different work:

- **(A) Build to the lock** — corrective migration to the §5.2 shape, adopt the locked
  `effect_type` enum, then wire. Stronger (the DB refuses a malformed evidence chain), and it is
  what the ratified document says. Cost: an effect_type rename rippling through the D7 API/UI and
  ~27 real-DB call sites needing a `directory_sync_runs` fixture.
- **(B) Amend the lock** to match what shipped, and wire to the landed schema. Cheaper; gives up
  the DB-level guarantees the lock calls mandatory, leaving them to application code.

Recommendation: **(A)**, sliced — the lock's whole argument in §5.1 is that application-level
evidence is insufficient. But this is a ratified document, so the amendment is the owner's call,
not a reviewer's.

---

## 3. Writes target columns that do not exist (P1) — fork-independent, **now fixed**

Fixed on `claude/dingtalk-t3-grant-table-fix-20260724` (`6c1a093ef`), with a real-DB suite:
4/4 green with the fix, **4/4 red with `src` reverted to `main`**. Added to the plugin-tests
run-list (that list is explicit — a new `.db.test.ts` is not auto-collected) and its collection
proven by running it next to `directory-deprovision-selection.db.test.ts` (10/10 still green).
Typecheck clean. The slice touches no deprovision writer and no `effect_type`, so it is
independent of the schema fork in §2.

Two phantom columns, four statements, every one behind a `.catch`:

| Phantom write | Where |
|---|---|
| `user_external_identities.grant_enabled` | T3 activate (#4574); D7 preview and D7 restore (#4575) |
| `user_orgs.updated_at` | T3 activate (#4574); D7 restore (#4575) |

`user_orgs` is `(user_id, org_id, is_active, created_at)`, PK `(user_id, org_id)`. The grant lives
in `user_external_auth_grants`, which is what `dingtalk-oauth.ts` reads at login.

The `.catch` is what makes this severe rather than cosmetic. Inside a transaction a failed
statement poisons the connection, so swallowing the rejection does not contain the failure — it
relocates it, as `25P02`, onto whatever innocent statement runs next. Measured consequences on
`main`:

- **T3 activate with an `orgId` could not succeed at all** — the membership INSERT aborted the
  transaction and it died at COMMIT. The "schema variance" fallback written underneath it is
  structurally unreachable: a poisoned transaction rejects the fallback too.
- With `enableDingTalkGrant: true`, activation **reported success and granted nothing**.
- The D7 preview could **never** show a grant effect (§0.1 B).
- Restoring any event carrying a membership **or** grant effect aborted — i.e. **every real
  deprovision event**, since every candidate carries a membership effect (§0.1 C).
- The grant drift gate was satisfied **by its own query failing**: the error became "no grant",
  which reads as "matches `after_active=false`", so `DRIFT_CONFLICT` could never fire on that leg
  (§0.1 C subject vs control 2).

Why unit tests did not catch any of it: a stub client answers whatever SQL it is handed, so a
statement naming a column that does not exist looks identical to one that does. Only real
Postgres can tell them apart — which is the argument for §2 fork (A) restated in miniature.

### Original detail



`user_external_identities.grant_enabled` appears in **no migration**. Control: three migrations
reference that table, and `grep -rn "grant_enabled" src/db/migrations/` returns zero rows. The
authoritative table is `user_external_auth_grants (provider, local_user_id, enabled)` — the one
`dingtalk-oauth.ts` reads at login.

Three merged paths write or read the non-existent column behind a swallow, so each fails silently:

| Path | Landed behaviour | Impact | Measured |
|---|---|---|---|
| `user-activate.ts:141` (T3, #4574) | `UPDATE user_external_identities SET grant_enabled = TRUE` inside `.catch(() => {})` | Activation reports success; the person is **never granted DingTalk login** | column absent in `information_schema` |
| `deprovision-evidence-api.ts` preview (D7, #4575) | reads `COALESCE(grant_enabled, FALSE)` inside `.catch` | preview can **never** show a grant effect | §0.1 B |
| `deprovision-evidence-api.ts` restore (D7, #4575) | `UPDATE … SET grant_enabled = TRUE` inside `.catch` | drift gate can never fire, and the restore aborts (`25P02`) | §0.1 C |

**Trigger condition for the T3 defect (precise).** `POST /api/admin/users/:id/activate` accepts
`enableDingTalkGrant` from the request body with no flag of its own, but `activatePendingUser`
only accepts a user already in `activation_status='pending_activation'`
(`user-activate.ts:112`), and pending users are created **only** by the directory admission paths
gated on `isDirectoryPendingActivationEnabled()` (three call sites in `directory-sync.ts`,
default OFF). So the defect is **latent today** and **arms at canary step 2**
(`DIRECTORY_PENDING_ACTIVATION_ENABLED=true`) — the first write-bearing step of the canary
sequence, reached before deprovision is ever touched. It is not blocked by, and does not wait
for, the deprovision flag.

Note the `.catch(() => {})` idiom is worse than "silently no-ops" here: inside a transaction, a
failed statement poisons the connection, so swallowing the rejection converts a precise error
(`42703 column does not exist`) into a confusing one (`25P02 transaction is aborted`) raised by
whatever innocent statement runs next.

---

## 4. Restore decides eligibility outside its own transaction (P2)

`restoreDeprovisionEvent` read the event, the user's `access_generation` and the directory-source
state with plain `query()`, evaluated eligibility, and only then opened the transaction that takes
`users … FOR UPDATE`. §5.4 makes restore conditional on the generation being **unchanged**;
deciding that before the lock is a check-then-act. A concurrent access-graph write landing in the
window lets a restore proceed on a verdict that was true only in the past, replaying a stale
`before` over the newer writer's decision.

---

## 5. Process observations (not code)

- **#4574 and #4575 carry no independent adversarial review.** Their only PR comments are bot
  notices (Gemini sunset; Codex usage-limit). #4574 is the largest slice of the lane (T2 aliases,
  T3 activate, D2–D6 core). The standing pre-push norm for core/cross-package changes is an
  independent Opus pass; that review is **owed** for the whole T1–D7 stack, and I cannot
  self-satisfy it in this session.
- **No T1 GO record found.** Both locks state "design lock ≠ T1 GO … 另令开工". I found no GO in
  #4559/#4574/#4575/#4577 bodies or comments. It may have been given in session and simply not
  recorded on the PRs — worth the owner confirming rather than assuming either way.
- What I checked, and what I did not: I read the deprovision writer, the ledger/planner/restore
  modules, the evidence API and the two migrations. I did **not** audit the T2 alias
  backfill/cutover gate or the T1 invite/activation guards beyond their grant interaction — those
  surfaces are still unreviewed.

---

## 6. Work in flight on `claude/dingtalk-d4-d5-writer-ledger-wiring-20260724`

Built against fork (A), **not pushed, not merged**, held for the decision above:

- `zzzz20260724190000_harden_directory_deprovision_ledger.ts` — corrective migration to §5.2.
  Fails closed if either ledger table is non-empty rather than discarding evidence to make room
  for the new NOT NULL provenance columns.
- `deprovision-planner.ts` — locked effect-type enum; `policy` input plus the org-scoped vs
  globally-clear split, so the plan is the same decision the writer takes.
- `deprovision-ledger.ts` — runs on the caller's transaction; no swallowed errors; refuses an
  empty effect set.
- `directory-sync.ts` — per-user `users … FOR UPDATE` in sorted id order (§7.2), globally-clear
  re-read **under the lock** (§7.4 — this closes the write-skew gap the file's own comments
  recorded as deferred), plan → apply → `recordDeprovisionEvent` in the sync transaction,
  zero-effect ⇒ zero write.
- `deprovision-evidence-api.ts` — eligibility moved inside the locked transaction; grant reads and
  writes repointed at `user_external_auth_grants`; `restore_mode`/`resolved_*` recorded.
- `user-activate.ts` — T3 grant repointed at `user_external_auth_grants`, swallow removed.

Not built: **D5** (mutex on the full §7.3 writer inventory — bind/unbind, admit/activate,
admin-users is_active/grant, `user_orgs` upsert, `directory_accounts.is_active` transitions with
the D0 protocol) and its dual-connection race tests.

### Risk the owner should own explicitly

`assertAppliedMatchesPlan` throws when the applied effect set diverges from the plan, which rolls
back **the entire directory sync run**, not just the deprovision step. Under the mutex this can
only fire when another writer mutated the access graph without taking the same lock — i.e. the D5
gap. The alternative is committing an evidence chain known to disagree with what happened. This
argues D5 must precede any deprovision canary; it is a deliberate hammer, and it should be an
owner-accepted one rather than a surprise.

### Verification status — honest

| Item | State |
|---|---|
| Corrective migration up/down against real PG | **not run** |
| §11 real-DB matrix (raw-INSERT rejections, zero-effect no-write, Apply≈Plan, generation) | **not written** |
| Existing 5 real-DB deprovision suites (27 call sites) updated for `runId`/`triggeredBy` + run fixture | **not done** |
| Unit suites | stub updated for the new query shapes; **not run** |
| Typecheck / CI | **not run** |
| Independent adversarial review | **owed** — for this branch and for merged #4574/#4575 |

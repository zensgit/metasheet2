# DingTalk Sync Hardening — Design and Verification

- Date: 2026-07-08
- Scope: implementation of `docs/development/dingtalk-sync-integrated-roadmap-20260708.md` (Rev 3.2, merged as #3873)
- Baseline: `origin/main` at the time each branch was cut (main moved continuously; each PR states its own base)
- Status: **Phase 1 complete (11/11). Phase 2 complete (6/6), two tickets partial by design.** Phase 3 (`DT-STRAT-*`) is design-gated and deliberately not implemented — see roadmap §11.
- **Revision 2 (2026-07-08).** The independent adversarial review that §5.1 of Rev 1 recommended has now run. It found a **P1 in every one of the four PRs it examined**, and Rev 1 asserted proofs for two of them that did not hold. Those claims are corrected in place below; §8 records what the gate found and how each finding was closed; §9 records a systemic CI-coverage defect the gate exposed. Read §8 before trusting any "proof" column.

---

## 1. What this document is

The roadmap said *what* to fix and *why*. This says *what was built*, *how it was proved*, and — just as importantly — **what was not proved and why**. Every claim below is traceable to a test, a mutation experiment, or a real-database run.

A note on the verification standard used throughout: a passing test only proves the code does *something*. To show a guard is **load-bearing**, each safety property was additionally **mutation-tested** — the guard was deliberately broken, the specific test was observed to go red, and the code was restored. Where a property could not be proved this way, that is stated plainly in §5.

**Rev 2 correction to that standard.** Mutation testing proves a guard is load-bearing *with respect to the tests that exist*. It does not prove the guard is the **right** guard, and — the failure that actually occurred here — it does not prove the guard's **selection predicate** is covered at all. If a fixture shadows the thing under test (a fake client that regex-matches SQL and ignores the `WHERE`; an environment variable that short-circuits the resolver before it reads its argument; a mock that closes over the answer), then breaking the guard reddens nothing, and mutation testing reports success. Four such holes are documented in §8. The standard adopted afterwards is stricter: **a safety property that decides who loses access, whose approval routes where, or whose credentials are used, is proved against real Postgres through the real call site — not against a replica of the schema, and not through a stub that cannot evaluate a predicate.**

---

## 2. Design principles applied

These were not chosen post-hoc; they constrained every ticket.

1. **Default-off or default-noop.** No merged change may alter production behavior on deploy. Where a fix implies a behavioral decision the owner has not made (offboarding, primary-department semantics, multi-replica policy), the mechanism ships behind a flag that defaults to today's behavior. Merging is therefore safe even unattended.
2. **Additive migrations only.** No column is dropped or retyped. The one new index is `IF NOT EXISTS` and reversible; the one data-touching migration only closes out rows that are orphaned by definition.
3. **Fail closed, never destructive-by-default.** An unrecognised stored policy degrades to review-only. An unavailable state store refuses a login rather than degrading to a store other replicas cannot see. A grant that cannot be honoured throws *before* a user row is written.
4. **The seam is where the data crosses a boundary.** Credentials are encrypted at exactly one boundary and decrypted at every read site — enumerated exhaustively, because missing one turns an encryption fix into a production outage.
5. **Locks precede the expensive work.** The DingTalk API pull, not the database apply, is what must not be duplicated.

---

## 3. Phase 1 — shipped tickets

| Ticket | PR | What it fixes | Proof |
|---|---|---|---|
| DT-HARDEN-01 | #3882 | E1 container login was dead on arrival | supertest through the real global JWT gate; mutation |
| DT-HARDEN-02 | #3896 | auto-admission committed orphan users | mutation: orphan row appears when the guard is removed. **Call site untested** — §5.2, and under review |
| DT-HARDEN-03 | #3898 | group-robot credentials in plaintext | mutation ×2 — but 3 of the 5 read/write surfaces the gate names have **zero** coverage; see §8.5 |
| DT-HARDEN-04 | #3902 | batch bind/unbind lost the audit trail | mutation ×2 (service isolation, route audit) |
| DT-HARDEN-05 | #3903 | concurrent syncs double-pulled the DingTalk API | **real-Postgres proof** of the lease invariant; mutation. Every guard is separately neuterable with CI green — §8.5 |
| DT-HARDEN-06 | #3900 | unbounded requests; recipients marked both sent and failed | mutation ×2 |
| DT-HARDEN-07 | #3904 | approval routing anchored on an accidental primary department | ~~routing golden; mutation~~ → **real-DB write→route golden** (Rev 1's golden was a tautology — see §8.2) |
| DT-HARDEN-08 | #3897 | proxy-hijacked 200s recorded as successful sends | 248 tests incl. new robot/length-guard suites |
| DT-HARDEN-09 | **#3883 (merged)** | auto-provision open-registration hole | oauth gate suite; `tsc` clean |
| DT-HARDEN-10 | #3884 | DingTalk title-row CSVs mis-imported | ~~inline↔streaming parity~~ → the parity was incomplete and broke two shipped templates; see §8.4 |
| DT-HARDEN-11 | #3885 | env template drift | key-by-key consistency check against real code reads |

### 3.1 DT-HARDEN-01 — E1 container login wire

The backend registered the 免登 route at `/api/auth/dingtalk/container`; the frontend posts to `/api/auth/login/dingtalk/container`; the auth whitelist (a `startsWith` prefix match) covered neither. The frontend path 404'd, and the registered path was 401'd by the global JWT gate — for an endpoint that is *by definition* pre-authentication.

Every existing test missed it because they all bypass the HTTP wire: route tests invoke the handler directly off `authRouter.stack`, the DB test calls the service function, and the frontend test mocks `apiFetch`.

**Design.** Move the route under `/login/…`, which simultaneously matches the frontend and inherits the `/api/auth/login` whitelist prefix. A comment records that the prefix is load-bearing, since nothing in the code otherwise says so.

**Verification.** A supertest suite builds an app with a *verbatim slice* of `index.ts`'s global guard and the real `authRouter`, then asserts: the whitelist statically covers the new path and not the old; the new path is admitted without a JWT and reaches the handler (default-off → 404 with our body); and the pre-fix path is JWT-gated (401). Mutation: reverting the route path turns those red.

### 3.2 DT-HARDEN-02 — auto-admission orphans

Auto-admission hardcoded `enableDingTalkGrant: true`. A corp-scoped account without an `open_id` cannot hold a DingTalk login grant, so the bind assertion threw — **after** `INSERT INTO users`. The sync loop's catch swallowed it and the surrounding transaction committed, leaving an active local user with no identity, no link, and no presence in the review queue.

**Design.** Two independent changes, deliberately:
- the grant is now computed from openId presence (`resolveDirectoryAutoAdmissionCanGrantDingTalkLogin`, mirroring the bind assertion exactly), so such accounts are admitted with the grant **off** and their directory binding intact;
- the assertion is enforced **before** the `users` INSERT, making user+bind all-or-nothing for *every* caller.

The second change is what makes the orphan impossible; the first is what makes the account usable. They are separated so that a regression in one cannot silently re-open the other.

**Verification.** `directory-sync-admission-orphan-guard.test.ts` drives the internal function with a fake client and asserts that no `INSERT INTO users` is issued when the grant cannot be honoured. Mutation: removing the assertion makes that test fail with exactly the orphan symptom (`expected length 0, got 1` — a user row written before the throw).

`scripts/ops/dingtalk-directory-orphan-inventory.mjs` inventories pre-existing orphans, read-only. Remediation stays an owner decision.

### 3.3 DT-HARDEN-03 — group-robot credentials at rest

`webhook_url` embeds the robot's `access_token`; `secret` is the HMAC signing key. Together they are enough to inject messages into a customer's group. Both sat in plaintext while every other DingTalk credential in the repo already went through `security/encrypted-secrets`.

**Design.** Encrypt at one boundary, decrypt at every read site. The read sites were enumerated exhaustively — service mapper, test-send, the masked log line, and **the automation executor's send path** — because missing the last one would feed an `enc:` blob to URL validation and break every group delivery in production. `decryptStoredSecretValue` passes non-`enc:` values through, so legacy plaintext rows keep working and re-encrypt on their next write; `scripts/encrypt-dingtalk-destination-secrets.ts` backfills rows never touched again, and refuses to run without an explicit `ENCRYPTION_KEY` (the dev default would write values production cannot decrypt).

**Verification.** Mutation ×2: making the executor read the raw column turns the new send-path test red (the outage mode); making `create()` store plaintext turns the service test red (the P1 itself). The pre-existing service test asserted the *old* insecure behavior and was rewritten to assert the security property.

### 3.4 DT-HARDEN-05 — sync run lease

The sync inserts its run row, then walks the entire DingTalk directory, and only then opens the apply transaction. A transaction-scoped advisory lock around the apply would not protect the pull — and a *session* advisory lock is unsafe here because `query()` draws from a pool, so lock and unlock could land on different connections.

**Design.** The lease lives on the run row, which already predates the first outbound call. A partial unique index on `(integration_id) WHERE status='running'` makes "at most one running run per integration" a *database* invariant: the second claim is a unique violation, not a lost race under READ COMMITTED. The loser gets `DirectorySyncInProgressError` → the route answers 409 with the active `runId`, the scheduler logs a skip. Expired leases are reclaimed before each claim and swept once at scheduler boot; completion *and* failure release the lease.

**Verification — real Postgres.** Against the dev database, with the migration applied verbatim:

```
backfill closes duplicate zombie rows so the index can be created  → 2 rows failed
first claim                                                        → OK
concurrent claim                                                   → unique_violation (23505): lease ENFORCED
different integration claims concurrently                          → OK (no false blocking)
completion releases the lease; re-claim                            → OK
failure    releases the lease; re-claim                            → OK
down()                                                             → OK
```

Mutation: swallowing the unique violation makes the "never touches the DingTalk API" test red.

### 3.5 DT-HARDEN-06 — timeouts and honest partial failure

Three defects, one theme: the system lied about what happened.

- `requestDingTalkJson` used a naked `fetch`. Everything except the group-robot webhook — gettoken, directory sync, work notifications, approval cards, container login — could hang for undici's ~300s default *inside an inline automation execution*. Now bounded by `AbortSignal.timeout` and surfaced as a typed `DingTalkTimeoutError`. The spread order (`...init` **then** `signal`) is deliberate: an explicit `signal: undefined` in a caller's init would otherwise clobber the timeout.
- Work notifications batch by 100. When a later batch threw, the catch marked **every** recipient failed — including earlier batches already sent *and already holding a success row*. One send produced both a success and a failed row for the same person. Only unsent recipients are failed now; partial success is reported as a partial result.
- Approval-card mark-send-failed swallowed its own error (`.catch(() => null)`), so a card stuck `pending` was fail-closed but **invisible**. It is now logged and surfaced.

**Verification.** A 150-recipient / two-batch test asserts exactly one delivery row per recipient and an empty success∩failed intersection. Mutation ×2 (partial-failure, abort signal).

### 3.6 DT-HARDEN-07 — primary department (default-off, and why)

`is_primary` decides which management chain approvals route up — `ApprovalDirectoryOrg` anchors `direct_manager` and the whole `continuous_managers` chain on it. It was `departmentIds[0]`: an accident of array order. A multi-department employee could route up the wrong chain.

**The honest constraint.** DingTalk's `topapi/v2/user/get` has **no unambiguous "main department" field**. It returns `dept_order_list: [{dept_id, order}]`, whose `order` is the employee's sort position *within* each department — conventionally lowest for the primary one, but not contractually documented. Switching the signal silently would change **live approval routing** on an unverified assumption. Roadmap §6.8 already gated this on *"confirming the field shape in staging"*, which cannot be done from here.

**Design.** The order-based resolver ships behind `DIRECTORY_PRIMARY_DEPT_FROM_ORDER`, **default off** (current behavior byte-for-byte). What ships unconditionally is that the choice is now an explicit, deterministic, tested function with a stable tie-break, instead of an accident. `scripts/backfill-directory-primary-department.ts` recomputes existing rows from stored data; a `--dry-run` before and after flipping the flag shows exactly what enabling it would change.

**Verification.** A multi-department approval-routing golden: the same requester resolves a *different* manager and dept head depending solely on which department carries `is_primary`. Mutation on the resolver.

---

## 4. Phase 2 — shipped

| Ticket | PR | Notes |
|---|---|---|
| DT-OPS-01 | #3905 | Offboarding policy executor — **default-off with a preview** |
| DT-OPS-02 | #3915 | Read-only sync preview; async sync **opt-in, not default** |
| DT-OPS-03 | #3914 | Sync-failure alerts actually delivered; manager-binding coverage metric (backend) |
| DT-OPS-04 | #3910 | Work-notification credentials resolve from the recipient's own integration |
| DT-OPS-05 | #3907 | OAuth state store may fail closed — **default-off** |
| DT-PERF-01 | #3911 | Account-department upsert batched into one statement (partial, by design) |

### 4.1 DT-OPS-01 — offboarding policy executor

`default_deprovision_policy` / `deprovision_policy_override` have existed since the schema was created and were **never enforced**. Removing a member from DingTalk marked the shadow account inactive and queued a review item, but their **local account stayed active**: password login kept working, and `unbind` only cleared the identity.

**Why default-off is not timidity here.** The column's DB default is *already* `mark_inactive`. Naively honouring the stored value would have started deactivating users on the very next sync of **every existing integration** — a mass lockout, shipped while nobody was watching. So the executor is gated on `DIRECTORY_DEPROVISION_ENABLED` (default off). With it off, nothing is written and the run reports exactly what it *would* have done: `deprovisionCandidateCount`, `GrantsDisabled`, `UsersDeactivated`. That is the "show policy effect before enabling it" preview the roadmap asked for.

Policies: `manual_review` (review-only, as today) / `disable_grant_only` (revoke DingTalk login, keep the local user) / `mark_inactive` (revoke and deactivate). **An unrecognised stored value degrades to review-only, never to a destructive action.** Applied effects are audited post-commit and invalidate cached permissions.

**Verification (Rev 2).** Rev 1 mutation-tested only the *gate*. It never tested **who** the executor selects, and the unit fixture could not have told it: the fake client matched the SQL text and returned canned rows whatever the `WHERE` said. The gate proved this by inverting the selection so the executor deprovisioned **every active employee** — 4354 of 4354 tests stayed green.

Two P1s followed from that blind spot and are now fixed (§8.1). The selection predicate is proved against the real migrated tables in `tests/integration/directory-deprovision-selection.db.test.ts`: the rehire, the cross-integration sibling, the lifetime backlog, the unlinked account, both circuit-breaker arms, default-off, and each policy's write shape. Six mutations, each reddening exactly the golden that names it.

### 4.2 DT-OPS-05 — OAuth state store

The in-process `Map` fallback is fine for one replica and quietly wrong for more: the callback can land on a different instance than the launch (a valid state is rejected and a legitimate login fails), one-time-use is only guaranteed per process, and a transient Redis outage degrades to the same place — the one case where the degradation also breaks the login it was meant to rescue.

`DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE` (default off) makes multi-replica deployments fail closed: `generateState` throws 503 rather than writing a state the other replicas cannot see, and `validateState` never consults the per-process Map.

### 4.3 DT-OPS-02 — preview before apply; async by request only

Applying a sync is not reversible: `auto_for_scoped_departments` creates local users on the spot and the `last_seen_at` sweep deactivates accounts.

`POST /integrations/:id/sync/preview` pulls the DingTalk directory *exactly as a sync does* — so its numbers are the real ones — and compares against the database **writing nothing at all**: no run row, no lease, no upsert, no user. It reuses the same pure eligibility predicate the apply path uses, so preview and apply cannot drift on the question that matters: *who gets an account created for them*.

Async is **opt-in**, and this is the interesting constraint: the synchronous response carries the auto-admission onboarding packets — one-time temporary passwords that are **never persisted**. A default `202` would silently throw them away. So `{"async": true}` returns `202 + runId`, and the default path is untouched. Mutation-proven: making async the default turns the existing packet-carrying test red.

### 4.4 DT-OPS-03 — alerts that leave the database; approval-routing health

`directory_sync_alerts.sent_to_webhook` had existed since the table was created and nothing ever sent anything: a nightly sync failing on a rotated app secret just accumulated rows nobody read. The product already owns the channel, so *"the DingTalk sync broke"* is now announced over DingTalk — env-gated (no channel, no noise), SSRF-pinned and HMAC-signed by the same `robot.ts` primitives, masked in every log, and **best-effort by construction: a sync that already failed must never be made worse because a webhook was down**. The subject escalates once failures repeat.

`getDirectoryManagerBindingCoverage()` exposes approval-routing health. `ApprovalDirectoryOrg` can only resolve a manager that is *linked* to a local user, so the bound share of managers is a direct upper bound on approval-routing success — invisible until now. Verified against real Postgres: a department head and a `leader_in_dept` account count; a `leader:false` account does not; a department with no managers does not divide by zero.

### 4.5 DT-OPS-04 — credentials follow the recipient, not "latest active"

A DingTalk userid only means anything inside its own corp, but the person-notification path resolved credentials with no integration, so the stored-config resolver fell back to *whichever integration sorts first as latest active*. Under two integrations, a user bound to corp A could be notified with corp B's credentials.

The recipient query now carries the binding's integration and scopes the credential lookup. Recipients are **grouped by integration and each group is sent with its own token**.

**Rev 2 correction.** Rev 1 shipped a *refusal* for multi-integration audiences and described it here as a safety property. It was a defect (§8.3). A `failed` action hits `executeActions`' fail-stop, so every later action in the rule is marked `skipped` — a rule author who added a two-corp member group silently lost the rest of their rule. The roadmap asked for correct credentials, never for a refusal, and a two-corp audience is legitimate. Worse, the refusal fired even on env-configured deployments, where exactly one credential exists and the bug it guarded against cannot occur.

Rev 1 also could not see its own fix. `readDingTalkMessageConfigFromRuntime` returns environment config **before** it consults the `integrationId` argument, and the test that named itself after the scoping set `DINGTALK_APP_KEY` — so deleting the scoping, or pointing it at a wrong integration, left the suite green. The Rev 2 golden sets no DingTalk environment variables and stores two real integrations with two different app keys; the app key travels in the token request, so which corp's credentials reached which recipient is directly observable. Two further call sites carrying the same bug — the rule-creator failure notice and the approval-card send — are now scoped too.

### 4.6 DT-PERF-01 — batched membership upsert (and what was *not* done)

`(employee × department)` is the highest-cardinality write in the sync: thousands of single-row round trips inside the apply transaction, holding its locks for the whole walk. One `unnest` statement replaces them with identical semantics, proved on real Postgres (batch insert, `ON CONFLICT DO UPDATE`, empty arrays as a no-op).

**Rev 2 — a merge-order hazard, now disarmed.** DT-PERF-01 and DT-HARDEN-07 rewrite the same line (`departmentId === user.departmentIds[0]`). The batched builder still hardcoded the array index, so landing it after DT-HARDEN-07 would have **silently reverted the approval-routing fix** with every test green. DT-HARDEN-07 now performs its write through an extracted seam that a real-DB golden drives directly, so the batched rewrite has to keep that golden passing rather than quietly restoring the old semantics.

Two parts were deliberately **not** done, with reasons rather than silence:
- **the per-user `user/get` N+1** cannot be removed blind. `ApprovalDirectoryOrg` reads `leader_in_dept` out of `directory_accounts.raw`, which *is* the user-detail payload. Whether `user/list` carries that field is precisely the staging check roadmap §7.7 asks for; dropping the detail call without it would silently destroy manager routing.
- **hoisting bcrypt out of the transaction** would require pre-hashing every in-scope candidate before knowing which actually need admission — more cost than it saves.

---

## 5. What was NOT proved — read this before trusting the above

Honesty about the boundary of the evidence is part of the deliverable.

1. **The independent adversarial review has now run, and Rev 1's central worry was correct.** The house rule is that a gate is an *independent* reviewer, not self-review. Partway through the original work every reviewer subagent died mid-flight, and everything after that point was implemented **and** verified by the same author. Rev 1 recommended a fresh adversarial pass "before or shortly after merge".

   That pass ran. It examined four PRs and **found a P1 in all four** — see §8. Nothing had been merged, because the recommendation was taken as a blocker rather than a nicety. Six further PRs on this line remain under review, and the merge train stays stopped until each has an independent verdict.

   The lesson is sharper than "reviews are good". Every one of the four defects had passed mutation testing. Mutation testing asks *is this guard load-bearing?*; an adversarial reader asks *is this the right guard, and can any test see it at all?* Those are different questions, and only the second one caught these.

2. **`syncDirectoryIntegration` orchestration has no test harness, repo-wide.** This predates the work (the audit noted it). Consequence: for DT-HARDEN-02 a regression at the *call site* would not turn any test red. The safety property (no orphan) is protected independently by the mutation-proven assertion-before-insert; a call-site regression would only make such accounts fail admission, not corrupt data. DT-OPS-01's executor is now proved against real Postgres, but its *wiring into the sync* is likewise uncovered. DT-HARDEN-07's write is no longer in that category: it was extracted into `upsertDirectoryAccountDepartments` precisely so a real-DB golden could drive it.

3. **Two behavioral decisions are deferred to the owner, by design.** `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` and `DIRECTORY_DEPROVISION_ENABLED` both ship off. Neither can be turned on responsibly without a staging tenant: the first needs DingTalk's real `dept_order_list` shape, the second needs a look at the preview counts on real data.

4. **CI, not just local runs — and CI covers less than Rev 1 assumed.** Every PR states its local test evidence. A PR that has not turned green is not verified merely because the tests passed on a laptop. Rev 1 stopped there. It should have asked *which* tests CI actually runs: the answer, established in §9, is that a new real-database test file runs in **no workflow at all** unless it is wired in at two separate points. Every auto-merge on this line has since been disarmed.

5. **Migrations were exercised on a dev Postgres, not on production-shaped data.** The DT-HARDEN-05 lease migration was proven end-to-end (including that it copes with pre-existing duplicate zombie rows). The DT-HARDEN-08 index migration was not run against a large table; `CREATE INDEX` on a big `dingtalk_*_deliveries` will take a lock — consider `CONCURRENTLY` if those tables have grown.

---

## 8. The adversarial gate — what it found, and how each finding was closed

Four PRs were reviewed, chosen for blast radius rather than swept uniformly. All four were sent back. What follows is the record, because a verification document that hides its own near-misses is worth less than no document.

**The shared root cause was never "the guard is written wrong".** In every case the guard was approximately right and *no test could see it*. A fixture stood between the test and the thing under test:

| PR | The fixture that shadowed the guard | The mutation that should have failed, and did not |
|---|---|---|
| DT-OPS-01 | a fake client regex-matching the SQL text, returning canned rows whatever the `WHERE` said | invert the selection to deprovision **every active employee** → 4354/4354 green |
| DT-HARDEN-07 | a mock that closed over the answer and ignored its `params` | revert the `is_primary` write to array order → 4353 green |
| DT-OPS-04 | `DINGTALK_APP_KEY` set, and the resolver reads the environment *before* its `integrationId` argument | delete the scoping, or point it at a wrong integration → green |
| DT-HARDEN-03 | a fixture storing plaintext, so every decryption was a pass-through no-op | make `updateDestination` persist **plaintext credentials** → 4350/4350 green |

### 8.1 DT-OPS-01 — two P1s: a rehire lost their account, and a broken fetch looked like a layoff

`directory_account_links` is unique on `directory_account_id` and carries only a plain index on `local_user_id`, so **N directory accounts map to one local user**. Candidates were scoped by integration, but the write is global (`UPDATE users SET is_active = FALSE WHERE id = $1`). An employee who left and rejoined — or who exists in a second corp — had their live account disabled by the departure of a stale badge. Nothing in the backend writes `is_active` back to true: the product offers no way out.

Fixed with a sibling guard: a person is a candidate only if they hold no other linked, active directory account **anywhere**. The guard is deliberately *not* scoped by integration, and a golden fails if someone adds that scope back — it is the plausible wrong fix.

Second P1: *absent from the fetch* is not *departed*. A blank name is silently dropped by the client, a missing list yields zero users with no error, restricted members are hidden when the contact scope is narrowed, and a narrowed root department shrinks the whole tree. Any of these is indistinguishable from a company-wide resignation. A circuit breaker now aborts the pass — deprovisioning nobody — when the fetch returned zero accounts or when the batch exceeds `DIRECTORY_DEPROVISION_MAX_BATCH` (default 25).

Also: candidates are now this run's *transitions*, not the lifetime backlog of inactive rows; one decision per **person** rather than per account, with the least destructive policy winning; and the affected identities reach the run stats, because an operator deciding whether to flip the flag needs to see *who* would lose access.

### 8.2 DT-HARDEN-07 — a backfill that walked, and a golden that proved nothing

The backfill's load-bearing comment claimed the query's ordering preserved the sync's fallback semantics. It did not: there is no ordering column on the membership table, a select returns heap order, and every update moves the tuple to the heap tail. On real Postgres the primary department **walked one step further on every run, with the flag off** — and `--dry-run`, which the design lock names as the operator's go/no-go for flipping a live approval-routing flag, reported changes the sync would never make. The order now comes from the stored DingTalk payload, which is exactly what the sync reads; an account whose payload lacks it is skipped and reported, never guessed at.

The consumer golden was a tautology: its mock returned "department 20 is primary" regardless of the parameters it was handed, so it proved only that routing follows whatever the database says — green no matter what the flag was written as. It has been replaced by a real-database test in which the writer and the router *meet*: a requester in two departments with two different leaders, the real write, then the real routing SQL naming a manager.

### 8.3 DT-OPS-04 — the refusal skipped unrelated work

Covered in §4.5. The refusal was itself the P1.

### 8.4 DT-HARDEN-10 — the fix broke two of the product's own templates

The streaming parser lost the fallback its predecessor had (*if no header row is detected, treat the first non-empty row as the header*). The upload-validation reader kept the fallback; the parser did not — so validation passed, the parser yielded zero data rows, and the upload failed with *"CSV must include at least 1 non-empty data row"*. Two of the three import templates the product itself ships have no name column and were rejected. This was live broken product behaviour, not a latent risk.

The header heuristic also accepted a single name token against a vocabulary the rest of the code defines as seventeen keys, and skipped the normalisation the validator applies — so `Work Date` and a space-separated Chinese name validated but failed detection. The fix folds the heuristic onto the real vocabulary, applies the same normalisation at all three call sites, and makes the streaming path two-pass: a bounded peek for the header index, then a stream through the existing explicit-header seam. A one-line fallback was impossible; the streaming path discards rows unbuffered.

### 8.5 The two reviews that did not block

- **DT-HARDEN-05** (sync lease): approve-with-hardening, no P1. The partial-index lease is correct and real-database-verified, and `main` has no lease at all, so blocking would preserve worse behaviour. But every guard is separately neuterable with the suite green; the failure path releases the lease in its *second* statement, so a database blip while already failing wedges the run row; the boot-time sweep reuses the 120-minute predicate and therefore **cannot reclaim the crash it exists for**; and the same predicate steals the lease from a *live* long sync, because nothing touches the row during the pull. One heartbeat column closes the last two.
- **DT-HARDEN-03** (credentials at rest): changes-requested, but the shipped runtime is correct — the reviewer could not break it. What blocks is the coverage: three of the five surfaces the gate names are untested, and the update path can be neutered to persist plaintext credentials with the entire suite green. Separately, the backfill script enforces that an encryption key is *present* while silently accepting a default salt, though the derived key depends on both — and it overwrites the plaintext, so the drift is irreversible.

---

## 9. A systemic finding: a real-database test runs in no workflow unless wired in twice

This is the defect behind the defects, and it applies to every future change in this repository, not just this line.

`packages/core-backend/tests/integration` holds 251 files. **CI does not run that directory.** It runs an explicit allowlist of filenames, hand-maintained inside the workflow. A new `.db.test.ts` therefore executes nowhere — it passes locally, it is cited in a PR body, and it guards nothing.

Worse, the default (no-database) test job *does* collect `tests/integration` by glob. A database-gated file placed there without care is collected, finds no `DATABASE_URL`, and **skips green** — reporting success for a test that never ran.

So a database-backed golden must be wired at **two** points, and the repository's existing files say so in comments that had to be discovered rather than found:

1. added to the `exclude` list in the package's default vitest config, so the no-database job cannot skip-green it;
2. added **as a whole file** — never as a name filter, which exits green when it matches nothing — to a real-database step in the workflow.

Every real-database golden introduced in Rev 2 is wired at both points, and each pull request states which workflow step runs it. Unit tests need no such treatment: the default test job does run `tests/unit` in full.

The general rule this line learned the hard way: **before claiming a test protects something, run the command CI runs and confirm the file appears in its output.** A test that runs nowhere is indistinguishable from a test that passes.

---

## 6. Remaining work

Every roadmap ticket has been *implemented*; none of this line has *landed*. The merge train is stopped, every auto-merge is disarmed, and no pull request merges without an independent adversarial verdict (§8). Four have one; six do not.

Beyond that, what is left is the work each ticket **explicitly scoped out**, recorded here rather than quietly dropped:

| Open item | From | Why it was left |
|---|---|---|
| Admin-UI polling for async sync; run-diff and alert-`details` panels | DT-OPS-02 / DT-OPS-03 | Substantial work in a 5,735-line SFC that cannot be visually verified from here. The APIs they need now exist. |
| `integration_id` on approval-card delivery rows | DT-OPS-04 | Needs an additive migration on the card ledger so the approve/reject **callback** can resolve the corp. The card *send* is now scoped (the assignee lookup already carried the binding), and the person-notification hazard is closed. |
| Remove the `user/get` N+1; hoist bcrypt out of the transaction | DT-PERF-01 | The first is staging-gated (`leader_in_dept` lives in the detail payload); the second costs more than it saves. |
| Delivery-telemetry retention sweep | DT-HARDEN-08 | Needs scheduler wiring; the indexes and validation shipped. |
| Refuse a sync preview while a run holds the lease | DT-OPS-02 | Depends on DT-HARDEN-05 landing first. |
| A heartbeat column on sync runs | DT-HARDEN-05 (§8.5) | Closes both the un-reclaimable recent crash and the lease stolen from a live long sync. |
| Cover the three untested credential surfaces; make the backfill's key check symmetric | DT-HARDEN-03 (§8.5) | The runtime is correct; the coverage is not. |
| `DT-STRAT-01/02` | Roadmap §11 | **Design-gated. Deliberately not implemented.** |

---

## 7. Operational notes for the owner

- **Nothing in these PRs changes production behavior on deploy.** Every new behavior is behind a flag that defaults to today's semantics, except three strict tightenings: `#3883` refuses auto-provision when the corp allowlist is empty (its PR body documents the migration path); `#3897` stops recording malformed 200 responses as successful sends; `#3900` stops recording a recipient as both sent and failed. (Rev 1 listed a fourth — `#3910` refusing multi-corp audiences. That refusal was a defect and has been removed; see §4.5.)
- **Run a preview before the first sync after these land** (`POST /integrations/:id/sync/preview`, DT-OPS-02). It writes nothing and tells you exactly how many accounts a sync would create, deactivate, and deactivate-while-still-linked.
- **`DIRECTORY_SYNC_ALERT_WEBHOOK`** is worth setting immediately: until it is, a failing nightly sync still only writes a row nobody reads.
- **`DIRECTORY_DEPROVISION_ENABLED` must not be set anywhere, staging included, until DT-OPS-01 has landed with its real-database goldens.** Then: run a sync with the flag off and read `deprovisionAffected` from the run stats — the identities, not just the counts. There is no reactivation path in the product, so a wrong deactivation is not undoable through the UI. The circuit breaker will abort a pass that sees zero fetched accounts, or more than `DIRECTORY_DEPROVISION_MAX_BATCH` (default 25) departures; if it fires, verify the contact scope and root department before raising the cap.
- **Before enabling `DIRECTORY_PRIMARY_DEPT_FROM_ORDER`**: confirm `dept_order_list` against a real tenant, then run `backfill-directory-primary-department.ts --dry-run` to see which employees' approval routing would move. Rev 1 gave this same instruction while the dry run was reporting phantom changes and the apply was non-idempotent (§8.2). Both are fixed: with the flag off the backfill is a provable no-op, so a dry run that reports zero changes is a real baseline. Scope it with `--integration=<uuid>`.
- **Run the orphan inventory** (`scripts/ops/dingtalk-directory-orphan-inventory.mjs`) once: DT-HARDEN-02 prevents new orphans but does not clean up the ones already committed.
- **If group destinations exist today**, run `encrypt-dingtalk-destination-secrets.ts` with the production `ENCRYPTION_KEY` to close the plaintext window on rows that are never edited again — **but not before** its key check is made symmetric (§8.5). It verifies the key is present and ignores the salt, though the derived key depends on both; run it with the wrong salt and it overwrites the plaintext with ciphertext nothing can decrypt.

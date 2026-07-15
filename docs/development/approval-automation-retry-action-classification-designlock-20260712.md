# 自动化 retry / test-run 治理 — 按动作类型分级语义 — 设计锁（2026-07-12）

**Status: RATIFIED 2026-07-15（owner）。** 设计经 owner ratify——本锁的 §1-§10 契约即为实现验收标准。落地顺序：本锁（#4196）随批 #4203/#4195 一并合入 main 后，方授权启动 P2 durable-delivery runtime；FWB / 附件 / 一切相关 flag 保持 **OFF**，直至完整实现 + 8 场景全链验收通过。**本文档仍是设计契约（零 runtime code 随附）**；下述任何实现切片仍受 per-slice deploy 门约束。历史：曾为 PROPOSED（仅文档，零 runtime）awaiting owner ratify。This document has NO ratify authority of
its own; nothing below may be implemented until the owner explicitly ratifies it.

**Rev (2026-07-14c) — two internal-contradiction fixes (owner P2) so "standalone-ratifiable" actually holds.**
(1) **Claim table stays terminal; lease/fence live only on the reclaimable rows.** `meta_automation_action_applied`
is a TERMINAL `UNIQUE(kind, root_execution_id, action_key)` claim table with **no** lease/status/fence/attempts
column; the monotonic `fence` + bounded `attempts` + `lease` live ONLY on the `event_fires` re-execution lease
and the bridge continuation lease (and #4203's outbox rows). A zombie's class-A **mutation** is blocked by the
claim table's UNIQUE `ON CONFLICT DO NOTHING` (not a fence); its **lease-row** terminal writes are blocked by
fence-CAS. §10 + §9 V7 corrected accordingly. (2) **Q1/Q2/Q6 folded in as #4196's own rulings (not "pending
#4164 ratify"); Q3 is SUPERSEDED, not still-open.** The test-run runtime depends on Q2/Q6, so they cannot wait
on another lock's ratify — §7 now adopts Q1/Q2/Q6 as this lock's contracts; §0/§7's Q3 "superseded vs still-open"
contradiction is resolved (Q3 closed by supersession — #4196's per-action-type classification replaces it, and
it appears in no open-question list). #4196 is now genuinely self-contained + contradiction-free.

**Rev (2026-07-14b) — action_key type-safety + test-run namespace isolation + Q-A..Q-D closed as v1 rulings
(owner P1×2 + P2 on #4196).** Three corrections so #4196 is genuinely standalone-ratifiable:
(1) **`action_key` identity now includes `action.type` as a first-class, NON-OPTIONAL component** — the identity
is the ordered tuple `{structuralPath, action.type, canonicalConfig}` (§2.1), not the previous
`{structuralPath, canonicalConfig}` pair that omitted type and let `lock_record {}` and `delete_record {}` at the
SAME structural path with the SAME (empty) config collide on one `action_key` (RULE_CHANGED miss + wrong dedup).
(2) **`testRunOperationId` no longer enters the production execution namespace** — the caller value is an INPUT
only; the server derives a scoped ledger root, and disjointness from real executions is STRUCTURAL via a
NON-OPTIONAL `kind` discriminator column in the ledger UNIQUE key ⇒ `(kind, root_execution_id, action_key)` on
BOTH the class-A applied-ledger (§2.2) and the class-B two-phase table (§3). A client-supplied value can NEVER
address, dedup-skip, or corrupt a real execution's `(root_execution_id, action_key)` (§6.1).
(3) **Q-A..Q-D are now v1 DECIDED rulings** (moved from §8 待裁决 to decided): B′ non-durable `send_notification`
FORBIDDEN from `real_fire`; 4xx defaults `outcome_unknown`; rule-changed ⇒ 409 RULE_CHANGED (refuse outright);
retry window ≤ ledger retention with missing-evidence fail-closed. **#4196 now carries no open questions of its
own.** Status stays PROPOSED, zero runtime.

**Rev (2026-07-14) — self-containment + webhook-4xx correction.** Folded #4164's C1 (`testRunOperationId`
test-run idempotency key, §6.1), C4 (`action_key` structural identity, §2.1), and the
`meta_automation_action_applied` applied-ledger row shape (§2.2) IN as **#4196's own locked contracts** — #4196
is now **self-contained** and yields an implementable spec on its own ratify (it no longer requires #4164's
C1/C4 to be ratified first; §7/§10 updated accordingly). Corrected the class-B webhook/email classification: an
HTTP **4xx** received *after* the request body was sent now DEFAULTS to `outcome_unknown` (ambiguous, never
auto-resend), NOT plain `failed` — only definite pre-dispatch non-delivery (DNS/connection-refused/TLS-handshake
failure, nothing ever sent) stays plain `failed` (§3, §8 Q-B).

**This document SUPERSEDES #4164's Q3 premise.** #4164 (`approval-automation-retry-design-refresh-20260712.md`,
still OPEN/HELD) framed the applied-ledger's durability trade as **one global choice** — Q3 asked the owner to
pick *mark-after-success (at-least-once) vs claim-before-fire (at-most-once) vs two-phase claim→commit* for
**all** side-effecting actions uniformly. The owner rejected that premise: **"one global at-least-once /
at-most-once semantic for all actions" is the wrong question.** Different action classes have different
correctness requirements and different mechanics available to them (a DB write can sit inside a transaction; an
HTTP POST cannot). This document replaces #4164 Q3 with a **per-action-type classification** (§1) and works out
what each class actually requires. It does **not** re-litigate #4164's other rulings — Q1 (retry stays admin),
Q2 (test-run simulate-default), Q6 (simulate gate + write scope), Q7 (S3 stays fenced out of the automation
path), or C5/C6 (retry-vs-resume split, S3 boundary) — those are carried forward by reference (§7) and this
document does not edit #4164 or the 2026-07-09 lock file. #4164's C1 (`testRunOperationId`) and C4 (`action_key`
structural identity), plus the applied-ledger row shape, are the exception: this Rev **folds them in** as
#4196's own locked contracts (§6.1, §2.1, §2.2) so #4196 is self-contained — see §7.

Scope: `B3-10` (automation-failure one-click retry) + `B3-12` (sample-record test-run), same substrate as the
2026-07-09 lock (`approval-automation-retry-and-sample-testrun-design-lock-20260709.md`, #4032) and its 07-12
Rev-2 refresh (#4164). Grounded on `origin/main` `c714559fd`.

---

## 0. The thesis, stated once

#4164's Q3 crash-window worry — "the ledger mark is written *after* dispatch, so a crash between dispatch-OK
and mark-write lets one action re-fire" — is not a fact about retry in general. It is an artifact of treating
**every** side-effecting action as if it needed a *separate, post-dispatch* ledger write, which is only true for
actions that leave the database. For actions that stay inside Postgres, the ledger claim and the business
mutation can be **one INSERT/UPDATE pair inside one transaction** — there is no "after dispatch" moment, so
there is no crash window to trade away. For actions that leave the process (HTTP egress, DingTalk dispatch), no
transaction can span the network call (established already at
`docs/development/multitable-button-b1s2-send-webhook-designlock-20260619.md` §5a: *"An external HTTP egress
cannot sit inside a DB transaction"*), so the correct answer is not a durability trade at all — it is **two-phase
state plus a `outcome_unknown` terminal state that never auto-resends**, mirroring the DingTalk transport's
`read`/`exchange`/`send` tiers (`packages/core-backend/src/integrations/dingtalk/transport.ts:110-136`) and the
repo's standing doctrine (`docs/development/dingtalk-backlog-pool-closeout-design-and-verification-20260710.md`:
*"重试按业务语义分级，不按 HTTP 动词… 网络错误 ≠ 未执行"*).

So: **§1's matrix is the answer to #4164 Q3, not a placeholder for one.** Two classes, two different
correctness mechanisms, neither of which is "pick a global at-most/at-least-once knob."

---

## 1. Per-action-type semantics matrix (LOCKED — the classification itself)

| Action type | Class | Idempotency mechanism | Ambiguous-outcome handling | Never auto-resend? |
|---|---|---|---|---|
| `create_record`, `update_record`, `delete_record`, `lock_record` | **A — Same-DB write** | Business mutation + applied-ledger claim commit in **ONE transaction** (`UNIQUE(kind, root_execution_id, action_key)`) | N/A — a DB statement inside a transaction either commits or the whole transaction rolls back; there is no "maybe applied" state | N/A — retry re-checks the ledger row synchronously; if present, SKIP; if absent, the write (by construction) never happened |
| `send_webhook`, `send_email`, `send_dingtalk_group_message`, `send_dingtalk_person_message`, `send_dingtalk_approval_card` | **B — Outbound / external side-effect** | Two-phase state: `intent` row written and committed BEFORE the attempt → attempt → `outcome` row written and committed AFTER, keyed `(kind, root_execution_id, action_key)` (§3) | Timeout / connection-reset / **any HTTP status (4xx or 5xx) received after the request body was sent** ⇒ **`outcome_unknown`**; only definite pre-dispatch non-delivery (DNS/conn-refused/TLS, nothing ever sent) is plain `failed` (§3) | **YES — outcome_unknown NEVER auto-resends** (only an explicit, audited, human-operator redelivery may act on it, and only through the already-shipped narrow S3 path — §7) |
| `send_notification` (in-app, rule path) | **B′ — Internal notify, eventBus-only** | Not currently durable on the rule path (`automation-executor.ts:2580-2618`, eventBus emit only — see scope note at `:2596-2603`); has no retry-relevant durable state to double-apply, so a `send_notification` step is a re-*emit*, not a re-*deliver*. **v1 ruling (§8 Q-A): FORBIDDEN from the `real_fire` path** (no durable state to dedup); reclassify as **B** only if/when a durable rule-path notification write is added | Emit either happens or doesn't; no network ambiguity today | N/A today; revisit if a durable write is added |
| `start_approval` | **A-adjacent — CREATE-APPROVAL** | Already hard-blocked from whole-execution retry by the existing `START_APPROVAL_ALREADY_CREATED` guard (`automation-service.ts:2200-2206`) — unchanged by this lock | N/A (blocked, not retried) | N/A |
| `condition_branch`, `parallel_branch`, `wait_for_callback` | **C — Control-flow** | Never claimed on the applied-ledger (pure/repeatable, must re-run to re-derive routing) — unchanged from the 07-09 lock §4.2 | N/A | N/A |
| `record_click` | **D — Inert** | Audit-only, zero business effect (`automation-executor.ts:1719` in the 07-09 lock's citation) | N/A | N/A |

**The load-bearing distinction is A vs B, not "how risky does this action feel."** A is "can this action's
effect and its idempotency marker be made durable by the SAME COMMIT" (yes for anything that is only a SQL
statement against `meta_records`); B is "does dispatching this action require leaving the process" (yes for
HTTP/DingTalk egress). Nothing in class A needs an `outcome_unknown` state, because nothing in class A has an
ambiguous outcome — Postgres does not leave transactions half-committed. Nothing in class B can be made
exactly-once by a smarter ledger write, because the ambiguity is in the network, not in our bookkeeping.

---

## 2. Class A — same-DB write actions: same-transaction ledger (LOCKED contract)

**Requirement.** For `create_record` / `update_record` / `delete_record` / `lock_record`, the applied-ledger
claim INSERT and the business mutation MUST commit in the **same database transaction**. Concretely: `BEGIN` →
`INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key) VALUES (...) ON CONFLICT DO
NOTHING` (`kind = 'execution'` for a real retry lineage; `kind = 'test_run'` for a `real_fire` test-run — §2.2,
§6.1) → if 0 rows affected, `ROLLBACK` and report the step `already_applied` (skip, no mutation attempted);
if 1 row affected, perform the mutation (`INSERT`/`UPDATE`/`DELETE` against `meta_records`) → `COMMIT`. A crash
or process kill at ANY point before `COMMIT` leaves NEITHER the ledger row NOR the mutation durable — retry sees
an absent ledger row and correctly re-attempts. A crash after `COMMIT` leaves BOTH durable — retry sees the
ledger row and correctly skips. **There is no window in which one is durable and the other is not**, which is
exactly what dissolves #4164 Q3's "at-least-once duplicate window" for this class: that window only existed
under the Rev-2 design's *mark-after-dispatch* ordering, and this class does not dispatch outside the
transaction.

**Why `create_record` is the sharpest example.** `executeCreateRecord` (`automation-executor.ts:2446-2495`)
mints a fresh `recordId = rec_${randomUUID()}` on every call — a naive retry that re-runs this action from
scratch creates a **second, distinct record**, not a duplicate write to the same row. This is not a
"duplicate-if-unlucky" risk like a webhook double-POST; it is a **guaranteed** duplicate on every unguarded
retry that reaches this step. This is the single strongest argument for class A's same-transaction requirement
being non-optional, not merely nice-to-have.

**Existing precedent already in the codebase (extend, don't invent).** `executeDeleteRecord` already wraps its
lock-read + `meta_links` cleanup + delete-revision insert + hard `DELETE FROM meta_records` in one transaction
via `withTransaction` (`automation-executor.ts:2247-2436`, transaction helper at `:2437-2445`) — for the
*global-history delete-revision* feature, not yet for retry idempotency, but the mechanism is exactly what class
A needs: add the applied-ledger claim as the first statement inside that same transaction. **Gap to close:**
`executeCreateRecord` (`:2446-2495`) and `executeUpdateRecord` (`:2139-2246`) do **NOT** currently wrap their
writes in a transaction (bare `INSERT`/`UPDATE` against `this.deps.queryFn`) — they will need the same
`withTransaction` wrapping `delete_record` already has before the applied-ledger claim can be added inside it.
This lock treats that as an in-scope prerequisite of the class-A guarantee, not a separate, deferrable slice.

**`FOR UPDATE` on the lock-check SELECT — the load-bearing element, not the transaction wrap alone.** Wrapping
`executeUpdateRecord`/`executeCreateRecord`/`lock_record` in `withTransaction` does not, by itself, close the
lock-guard race — `withTransaction` only makes the *ledger-claim + mutation* pair atomic (the crash-window
argument above); it says nothing about what a CONCURRENT session sees while the transaction is still open. Under
Postgres READ COMMITTED, `executeUpdateRecord`'s lock-check `SELECT locked, locked_by, created_by FROM
meta_records WHERE id = $1 AND sheet_id = $2` (`automation-executor.ts:2186`) takes **no row lock** as written —
a concurrent `lock_record` action (or a REST-path lock) can commit between that SELECT and the automation's own
`UPDATE ... WHERE id = $2 AND sheet_id = $3` (`:2216-2223`), and that UPDATE's WHERE clause never re-checks
`locked`. The automation would then write straight through a lock its actor cannot override — exactly the
violation `ensureRecordNotLocked` (`:2205`) exists to prevent, and a regression of the "lock priority over
base-write" invariant the code's own comment states (`:2184`). **This lock therefore REQUIRES the class-A
lock-check SELECT to be `SELECT ... FOR UPDATE`, run inside the same `withTransaction` as the ledger claim and
the mutation** — matching `executeDeleteRecord`'s existing `FOR UPDATE` at `automation-executor.ts:2296`. `FOR
UPDATE` — not the surrounding transaction — is what forces a concurrent locker to block until this transaction
commits or rolls back; the transaction wrap alone leaves the exact same race the "lock priority over base-write"
invariant was meant to close. This is a correctness requirement of the class-A guarantee, not an
owner-discretion hardening — see §8 for the disposition of this finding.

**Concurrent-retry corollary.** Two concurrent retries of the same root racing on the same `action_key`: the
loser's `INSERT ... ON CONFLICT DO NOTHING` returns 0 rows, so the loser's transaction never reaches the
mutation statement at all (or, if implemented as "claim then mutate then commit" rather than
"claim-check-before-mutate", the loser's transaction is rolled back entirely by the unique-constraint semantics
before any mutation is visible). Either ordering is acceptable as long as the invariant holds: **the mutation is
only ever visible if its own transaction's ledger claim won**. This is exactly-once-effective by construction —
not a probabilistic trade the owner has to accept a residual gap on, unlike class B.

### 2.1 `action_key` identity (LOCKED contract — folded in; origin: #4164 C4)

The `action_key` that keys every applied-ledger claim (§2's `INSERT`, the §2.2 unique constraint, and §4's
drift guard) is **this document's own locked contract**, not a dependency to be ratified elsewhere. It is an
**ordered three-component tuple** — `action.type` is a FIRST-CLASS, NON-OPTIONAL component, not derivable from
path or config:

> **`action_key` = the ordered tuple `{ structuralPath, action.type, canonicalConfig }`**, where:
> - **`structuralPath`** = a NORMALIZED FULL STRUCTURAL STEP PATH of the action — the top-level action index
>   AND, for an action nested inside a branch/parallel step, that child's `step_key` (the SAME `step_key` the
>   A6-3-3 branch cursor uses to address a branch child), **NOT** a bare top-level `positionIndex`;
> - **`action.type`** = the action's type discriminator (`create_record` / `update_record` / `delete_record` /
>   `lock_record` / `send_webhook` / …) as a **non-optional** tuple component — it is NOT inferable from
>   `structuralPath` or `canonicalConfig`, so it MUST be carried explicitly;
> - **`canonicalConfig`** = a STABLE CANONICAL HASH of that action's `config` (object keys canonicalized into a
>   deterministic order before hashing, so a key-reordering re-serialization does not change the hash).
>
> The three components are combined in this fixed order into the single stable `action_key` value **via an
> INJECTIVE encoding — not bare string concatenation.** `canonicalConfig` is a fixed-width hash and `action.type`
> is a bounded enum, but `structuralPath` is variable-length and embeds a `step_key` that could in principle
> contain any delimiter byte; a naive `join('|')` would let `{path="a", type="b|c"}` and `{path="a|b", type="c"}`
> collide. The encoding MUST therefore be **length-prefixed** (each component's byte length prepended) **or a
> structured-tuple hash** (the three fields hashed as a typed tuple, not a joined string), so the mapping from
> `(structuralPath, action.type, canonicalConfig)` to `action_key` is provably injective. A RED-before test
> constructs two tuples that would collide under naive concatenation and asserts they get DISTINCT `action_key`s.

**Why `action.type` cannot be omitted (the collision this closes).** The previous folded identity was the
`{ structuralPath, canonicalConfig }` pair only — it OMITTED `action.type`. Under that pair, a `lock_record {}`
and a `delete_record {}` at the **SAME** structural path with the **SAME** (empty) `config` produce an
**identical** `action_key` and collide: the §4 drift guard would **miss** the `lock_record → delete_record`
rule change (RULE_CHANGED never fires), AND the §2 applied-ledger claim would **wrongly dedup** one action
against the other (one action's claim suppresses the semantically different action's write). Including
`action.type` as a non-optional tuple component makes the two `action_key`s DISTINCT, closing both the missed
drift detection and the wrong-dedup at once.

This **REPLACES** the types-only `computeActionFingerprint`
(`packages/core-backend/src/multitable/automation-suspension-service.ts:60`, which hashes only the sequence of
action **types** — `actions.map(a => a.type).join('|')` — and by construction cannot tell two actions of the
same type apart, nor detect a config-only edit). For the applied-ledger, hashing types-only would make two
distinct `update_record` steps collide on one `action_key` and let one action's claim suppress the other — a
correctness bug, not a fingerprint nicety. The type is one of THREE tuple components here, not the whole key.

**Nested-action conflict property (REQUIRED).** Two distinct branch/parallel children that would collide under a
naive top-level index (e.g. both reachable at "top-level step 3" but on different branch arms, or two children
of the same parallel step) MUST resolve to **distinct** `action_key`s, because the structural step path includes
each child's `step_key`. A key derived from `positionIndex` alone does not satisfy this and is non-conformant.

**Type-distinguishing property (REQUIRED).** Two actions at the SAME `structuralPath` with the SAME
`canonicalConfig` but DIFFERENT `action.type` (e.g. `lock_record {}` vs `delete_record {}`) MUST resolve to
**distinct** `action_key`s, and a rule edit that swaps one action's type while leaving its path and config
unchanged MUST be detected by the §4 drift guard as a change (409 RULE_CHANGED). An identity that omits
`action.type` does not satisfy this and is non-conformant — see §9 V4b for the RED-before test.

**Cross-lock — keep the `action_key` identity aligned.** Because this identity now includes `action.type`, the
`action_key` definitions carried by #4203 D9 and #4239 MUST match this ordered `{ structuralPath, action.type,
canonicalConfig }` tuple (each handled in its own brief); a divergent definition on either side reintroduces the
type-collision this section closes.

### 2.2 `meta_automation_action_applied` row shape (LOCKED contract — folded in)

The class-A same-transaction claim (§2) and the §10 migration target are defined **here**, within this lock — no
external row-shape reference is required. At minimum:

```
meta_automation_action_applied (
  kind               text        NOT NULL,   -- NON-OPTIONAL namespace discriminator: 'execution' (real retry
                                             -- lineage) | 'test_run' (real_fire test-run, §6.1). Part of the
                                             -- claim key so a test-run root can NEVER collide with a real one.
  root_execution_id  text        NOT NULL,   -- kind='execution': the original execution's lineage root;
                                             -- kind='test_run': the SERVER-DERIVED scoped root (§6.1) — NOT the
                                             -- raw caller value, which is an input to the derivation only
  action_key         text        NOT NULL,   -- the §2.1 ordered tuple { structuralPath, action.type,
                                             -- canonicalConfig }; action.type is encoded INSIDE this value
  action_type        text        NULL,        -- optional audit/debugging metadata; NULLABLE so §2's claim INSERT
                                             -- stays valid — NOT itself a claim-key column (the type already
                                             -- participates in the key via action_key above)
  applied_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, root_execution_id, action_key) -- the ON CONFLICT DO NOTHING claim key used by §2's INSERT
)
```

Only the three claim-key columns (`kind`, `root_execution_id`, `action_key`) are required at claim time — §2's
INSERT supplies exactly those three, and both remaining columns are self-satisfying (`applied_at` defaults,
`action_type` is nullable audit metadata a caller MAY populate). The row shape therefore introduces no column
§2's `INSERT ... (kind, root_execution_id, action_key) ... ON CONFLICT DO NOTHING` fails to satisfy. The
standalone `action_type` column is audit-only and NOT the identity source: the action's type participates in the
claim key through `action_key` (§2.1), where it is a first-class, non-optional tuple component.

The `UNIQUE (kind, root_execution_id, action_key)` constraint is the exact target of §2's `INSERT ... ON CONFLICT
DO NOTHING` — the whole class-A exactly-once-effective guarantee rests on this claim key existing and being
unique. A retry re-checks a `(kind='execution', root_execution_id, action_key)` row to decide SKIP-vs-apply; a
`real_fire` test-run claims under `kind='test_run'` with a server-derived scoped `root_execution_id` (§6.1),
STRUCTURALLY disjoint from every real execution's rows regardless of the caller-supplied value. This row shape is
retention-swept per §5's policy —
sweeping it is NOT the same as clearing a class-B `outcome_unknown` marker (§3), which lives in the separate
class-B two-phase intent/outcome table.

**Test-run execution rows are EXCLUDED from the retry-eligibility surface (adversarial-review catch).** A
`real_fire` test-run mints an execution row via `testRun`→`executeRule`; if it ends `status='failed'`, the
current `retryExecution` eligibility gate (`status ∈ {failed, skipped}`, the only status check on
`origin/main`) would otherwise let a caller **retry their own test-run execution** — which would then run under
`kind='execution'` retry semantics, blurring the test/production boundary the `kind` discriminator exists to
keep. Contract: `retryExecution` MUST refuse an execution row whose originating `kind='test_run'` (a test-run
is re-run by issuing a fresh `real_fire` with a new `testRunOperationId`, never by `retryExecution`). Worst case
without this is only "retrying one's own test run" (it cannot corrupt a *real* execution's ledger — `kind`
still isolates the rows), so it is low-severity, but the boundary is stated so it is not left to discretion.

---

## 3. Class B — outbound / external side-effect actions: two-phase state + `outcome_unknown` (LOCKED contract)

**Requirement.** For `send_webhook`, `send_email`, and the three `send_dingtalk_*` actions, retry/dispatch MUST
follow: **(1) record intent** (a durable row keyed by `(kind, root_execution_id, action_key)` in state
`pending`, committed BEFORE the network call — the SAME `kind` namespace discriminator as the class-A ledger
(§2.2), so a `real_fire` test-run's outbound intent is disjoint from any real execution's) → **(2) attempt**
(the actual HTTP/DingTalk call, outside any DB
transaction — a transaction cannot span it) → **(3) record outcome** (a second, separate commit that flips the
intent row to a terminal state: `sent` / `failed` / **`outcome_unknown`**). This is the same ordering already
locked for the button `send_webhook` action at
`docs/development/multitable-button-b1s2-send-webhook-designlock-20260619.md` §5a ("Tx A claims the dedup row
with `outcome='pending'` and commits… the egress runs **between** the transactions… Tx B then records the final
`outcome`… atomically") — this lock extends the SAME two-phase pattern to the automation-rule path's retry
substrate, rather than inventing a second one.

**`outcome_unknown` classification — mirror the DingTalk transport tiers exactly, do not re-derive.** The
transport layer (`packages/core-backend/src/integrations/dingtalk/transport.ts:110-136`) already classifies
outbound calls into `read` (safe to retry), `exchange` (never retry — single-use), and `send` (ambiguous
failure ⇒ `outcome_unknown`, never auto-resend, because "DingTalk may have delivered the message even though we
saw no response"). Every class-B action in this matrix is a `send`-tier action. Concretely, for
`send_webhook`/`send_email`:

- **Definite non-delivery (safe to mark plain `failed`, eligible for future retry) — ONLY pre-dispatch failures
  where nothing was ever sent:** DNS resolution failure, connection refused, TLS handshake failure. In each of
  these the request body never left the client, so the receiving service cannot have acted on it. This is the
  ENTIRE definite-`failed` set by default.
- **Ambiguous (`outcome_unknown`, NEVER auto-resent) — the default for anything after the body was sent:**
  request timeout, connection reset mid-request/mid-response, **any HTTP response status received after the
  request body was sent, INCLUDING a 4xx**, 5xx after the request body was fully sent, or any error where the
  client cannot distinguish "server never received it" from "server received and possibly acted on it, but the
  response was lost." **A 4xx is NOT treated as a definite pre-processing rejection by default** — a proxy/WAF
  can synthesize a 4xx after forwarding the request, an idempotency-key conflict (409) means the server already
  saw a prior copy, and a 4xx can accompany partial server-side processing; any of these mean the server may
  have acted. **v1 ruling (§8 Q-B): every 4xx defaults to `outcome_unknown`; NO 4xx subset is adopted as
  definite `failed` in v1.** A future endpoint-declared exception — a **narrow subset of 4xx that the endpoint
  contract explicitly designates as a pre-dispatch/pre-processing rejection** — would be a post-v1 change, not an
  open question here.
- The current `executeSendWebhook` (`automation-executor.ts:2496-2579`) does **not** make this distinction today
  — every non-2xx response or thrown error collapses to a single `'failed'` status (`:2568-2579`) and is
  retried up to `maxWebhookRetries()` **within the same call** (`:2537-2557`) with no ambiguous-vs-definite
  split. This lock requires that distinction be added before `send_webhook` participates in the retry
  substrate's `real_fire` path — see §8 Q-B for the v1-decided HTTP-status boundary (every 4xx ⇒
  `outcome_unknown`).
- `send_notification`'s current rule-path implementation (`:2580-2618`) is an in-app `eventBus.emit` with **no
  external egress and no durable write on this path** (scope note at `:2596-2603` says the durable
  Notification-Center write is a *different*, route-level path). It is therefore **not** class B as implemented
  today — flagged as B′ in §1, not silently folded into either class.

**Once `outcome_unknown` is recorded, the row is terminal for automatic purposes.** No retry path, no
`real_fire` test-run, and no scheduled job may transition an `outcome_unknown` row back to `pending` or attempt
a second dispatch for the same `(kind, root_execution_id, action_key)`. The ONLY sanctioned recovery is a
human-operator action through the already-shipped, narrow S3 redelivery mechanism (#4102) — and even that
mechanism explicitly **rejects** rows in `outcome_unknown` (`docs/development/dingtalk-remaining-boundary-round2-closeout-and-verification-20260711.md`:
*"`outcome_unknown` 硬拒（可能已送达，绝不重发）"*). This lock does not create a new automation-path redelivery
affordance for `outcome_unknown` rows — see §7 Q7 carry-forward.

**Lease fencing + poison terminal (adversarial-review catch, shared with #4203 Layer 1).** Wherever this
lock's mechanisms run under a *time-based lease that releases its row lock and executes outside it* — the
class-B two-phase intent worker, and any future autonomous re-lease of the shared `meta_automation_event_fires`
row — they inherit #4203 Layer 1's **fencing** contract: each lease row carries a monotonic `fence` bumped on
every claim/reclaim, and every write to durable state (the intent row's terminal outcome, the **lease row's**
`done` mark — NOT the terminal `meta_automation_action_applied` claim table, which has no `done`/fence) is a
**fence-CAS**, so a *live-but-lease-expired* holder (a "zombie" that stalled past its lease while a
reclaimer took over) writes 0 rows and aborts rather than double-completing. Durable state is single-writer;
the external send remains at-least-once (a zombie is one more at-least-once source — deduped by an endpoint
idempotency key where supported, else `outcome_unknown`, never auto-resent). **This introduces a third,
class-B-specific liveness obligation (the "class-B storm leg"): because fence-CAS protects durable state but
not the send itself, a class-B send whose single-attempt latency chronically exceeds the lease duration would
be reclaimed mid-attempt on every cycle — unbounded reclaims + unbounded duplicate sends. That is bounded by a
`lease_duration ≥ max single-attempt latency` invariant OR a bounded reclaim cap → `dead_letter` (V9).**
Separately, a **deterministically permanent-failing** class-A action (e.g. its target record deleted mid-flight)
must NOT re-lease forever: the **lease row's** state machine (the `event_fires` re-execution lease — again NOT
the terminal claim table) carries **bounded `attempts` + a terminal `failed`/`dead_letter` state** (with an
alert seam), distinct from `outcome_unknown` (which is scoped to *outbound* ambiguity, not deterministic
DB-write failure). The zombie-fencing leg, the poison-terminal leg, and
the class-B storm leg are RED-before verification requirements (§9 V7/V8/V9), not implementation-discretion.

---

## 4. Rule-changed-since-original-run: fail-closed (LOCKED contract)

**Gap.** `retryExecution` (`automation-service.ts:2179-2218`) re-fetches the **current** rule
(`:2207 getRule(original.ruleId)`) and only checks `rule.enabled` (`:2208-2210`) — it does **not** compare the
current rule's actions against what the original execution actually ran. Contrast `resumeExecution`
(`automation-service.ts:2243-2296`), which already has exactly this guard for the resume path: it computes
`computeActionFingerprint(execRule.actions)` and rejects with `409 RULE_CHANGED` if the current fingerprint
does not match the suspend-time fingerprint (`:2270-2272`), plus a second branch-level fingerprint check for
branch resumes (`:2289-2296`). **Retry has no equivalent guard today** — a rule edited between the original
failed run and the retry click will silently retry against the **new** rule definition, in a possibly different
action order, with possibly different action config, and the operator has no signal that this happened beyond
reading the confirm-dialog copy (if any).

**Requirement.** Before dispatching a retry, the service MUST compare a structural fingerprint of the rule's
current actions against a fingerprint captured at the time of the **original** execution (persisted on the
execution row, or re-derivable from the stored trigger context — implementation detail for the ratified slice,
not this lock). If they differ, the retry is **refused** (`409 RULE_CHANGED`, same code resume already uses)
rather than silently replayed against the mutated rule. This is fail-closed by construction: an operator who
genuinely wants to retry against the *new* rule definition has explicit, distinguishable options, never a silent
default:

- **(a) Refuse outright** — the operator must re-trigger a fresh execution against the new rule (no retry
  lineage), OR
- **(b) Explicit re-authorization** — a new request parameter (e.g. `acknowledgeRuleChanged: true`) lets the
  operator knowingly retry against the current rule, with the response/audit recording that this happened, and
  the resulting execution's `already_applied` semantics reset to "start over" (since the applied-ledger's
  `action_key`s were computed against the OLD rule and may not even correspond to the new rule's actions).

**v1 ruling (§8 Q-C): (a) refuse outright** — a rule-changed retry returns `409 RULE_CHANGED`, matching resume's
existing behavior. (b) explicit re-authorization is NOT built in v1; it is a possible later slice, deferred, not
an open question here.

**Fingerprint mechanism reuse.** The fingerprint used for this comparison SHOULD be the same ordered
`{ structuralPath, action.type, canonicalConfig }` identity this document locks for `action_key` in **§2.1**
(not the current `computeActionFingerprint`, which per §2.1 hashes only the sequence of action **types** —
insufficient to detect a config-only edit, which is exactly the kind of "rule changed" this guard exists to
catch). Because `action.type` is a non-optional component of that identity (§2.1), a rule edit that swaps one
action's type in place — same path, same config — is detected here as a change (409 RULE_CHANGED), the collision
an identity omitting type would miss. §2.1's
`action_key` identity (folded from #4164 C4) is this document's own contract, so the applied-ledger key and this
drift guard share one identity defined WITHIN this lock — no external ratify dependency.

---

## 5. Retry age bound + missing-ledger-row fail-closed (LOCKED contract)

**Gap (already identified in #4164 as C3, carried forward here with the fail-closed framing sharpened).**
`retryExecution` has no age cap — eligibility is `status ∈ {failed, skipped}` only (`:2187-2193`), unbounded in
time. The applied-ledger (once it exists) needs a retention/sweep policy (mirroring
`sweepEventDedupLedger`/`meta_automation_event_fires`, 7-day retention, `automation-service.ts:1524-1550`) —
ledger rows cannot be kept forever. These two facts combine into a correctness gap: **a retry request older
than the ledger's retention window can no longer prove which of the original execution's actions already
succeeded**, because the evidence (the ledger rows) has been swept.

**Requirement — two independent guards, both required:**

1. **Age bound at the eligibility gate.** A retry request whose original execution is older than the ledger
   retention period MUST be refused (new code, e.g. `409 RETRY_WINDOW_EXPIRED`) — never silently treated as "no
   prior progress, safe to run from scratch," because that is indistinguishable from "ledger rows expired but
   real side effects already happened."
2. **Missing-row fail-closed as a second, independent guard (not a substitute for #1).** Even within the
   nominal retention window, if a specific eligible root's ledger has **zero** rows for reasons other than "this
   is the first retry attempt" (row corruption, a manual DB intervention, retention math off-by-one, a schema
   migration gap) — the service cannot distinguish "genuinely first attempt" from "evidence lost" from ledger
   absence alone. Where that ambiguity is material (see §8 Q-D for the v1 ruling and the disambiguating signal
   that separates a first-attempt from an evidence-loss), the retry MUST be refused rather than proceed on the
   assumption of
   not-executed. This mirrors the repo's standing doctrine that a missing/ambiguous state is never silently
   read as "safe" (`isRetryableStoredTriggerEvent` at `:2194-2197` already fails closed on a missing stored
   trigger for the same reason — a missing input is refused, not defaulted).

**v1 ruling (§8 Q-D):** guard #1 is implemented as **(a) cap retry eligibility to ≤ ledger retention** (the
retry window is bounded by the ledger's fixed retention period), and guard #2 as **(c) fail-closed on a missing
ledger row for an otherwise-eligible root**. Both are required; #4164 C3's option (b) (retention keyed to
eligibility) is NOT adopted in v1. The exact numeric retention window is an ops-config value, not an open design
question. This lock's contribution is establishing that BOTH the age bound AND the missing-row fallback are
required, not just one.

---

## 6. `simulate` vs `real_fire` for test-run (carried forward from #4164, restated for completeness)

Test-run today (`testRun`, `automation-service.ts:2962-2980`) calls `executeRule` directly with no dry-run
parameter — every action, including class-A writes and class-B egress, dispatches for real. This lock does not
change #4164's already-ruled disposition (Q2: `simulate` is the default; `real_fire` is an explicit,
separately-gated opt-in) — it restates the requirement in terms of §1's classes so the split is unambiguous:

- **`simulate` (default):** class A actions are **suppressed** — record the intended target + payload, perform
  NO `INSERT`/`UPDATE`/`DELETE` against `meta_records`, and (per #4164 Q6's corrected ruling) write only a
  values-free execution-log/audit row, never a business mutation. Class B actions are **suppressed** — record
  the intended target host/recipient, perform NO outbound call. Class C runs (routing must be derived). Class D
  is inert either way.
- **`real_fire` (opt-in):** every class dispatches for real, under the SAME guards this document requires for
  retry — class A gets the same-transaction ledger (§2); class B gets the two-phase `outcome_unknown` handling
  (§3); both claim under a server-derived `kind='test_run'` ledger root built from the caller's stable
  idempotency key this document locks in **§6.1** (`testRunOperationId`, since test-run mints a fresh execution
  per call and has no natural lineage root the way retry does). **B′ non-durable `send_notification` is FORBIDDEN
  from `real_fire`** (§8 Q-A ruling) — it has no durable state to dedup, so it must not participate in the
  `real_fire` path.

No new decision is introduced here; this section exists so §1's matrix has a single home that also answers
"what does test-run do," rather than leaving that answer only in the superseded #4164 document.

### 6.1 `testRunOperationId` — the `real_fire` test-run idempotency key (LOCKED contract — folded in; origin: #4164 C1)

This is **#4196's own locked contract**, not a dependency to be ratified elsewhere. A `real_fire` test-run MUST
carry a **caller-supplied stable `testRunOperationId`** (an Idempotency-Key). The reason it is required for
test-run but not for retry: `testRun` (`automation-service.ts:2962`) **mints a fresh execution on every call**
and therefore has **no natural lineage root** the way retry does (retry inherits its original execution's root).
Without a caller-supplied key, two `real_fire` clicks — or two concurrent requests — would each mint a distinct
execution and so **could not dedupe against each other on the applied-ledger**, letting a class-A write fire twice.

**The caller value is an INPUT ONLY — it never becomes a `root_execution_id` directly.** The previous folded
design let `testRunOperationId` *become* the applied-ledger `root_execution_id`, which is unsafe: with the ledger
key being only `(root_execution_id, action_key)`, a client-controlled value would sit in the SAME keyspace as
real executions' lineage roots and could collide with a real execution's root — or across rules — and thereby
address, dedup-skip, or corrupt a real execution's `(root_execution_id, action_key)` rows. Instead:

- **The server DERIVES the ledger root** — a scoped `root_execution_id` deterministic in
  `(kind='test_run', actor_id, rule_id, clientOperationId)`, where `clientOperationId` is the validated
  `testRunOperationId`. Determinism in that tuple is what gives dedup (same tuple → same derived root → same
  claim); including `actor_id` and `rule_id` is what keeps two different rules (or two different actors) carrying
  the same `clientOperationId` on **independent** scoped roots.
- **Disjointness from real executions is STRUCTURAL, via the NON-OPTIONAL `kind` column** (§2.2): the test-run
  claim is written with `kind='test_run'`, and every real execution's claim with `kind='execution'`. Because
  `kind` is part of the `UNIQUE (kind, root_execution_id, action_key)` key, a test-run row and a real-execution
  row can NEVER be the same claim even if their `root_execution_id` strings were identical.
- **The `clientOperationId` is validated and bounded** before use — a bounded length and a restricted charset
  (opaque token; rejected if it violates the bound), so it cannot be abused to inject arbitrary structure into
  the derived root.

**Guarantee (stated explicitly).** A client-supplied `testRunOperationId` can NEVER address, dedup-skip, or
corrupt a real execution's `(root_execution_id, action_key)` claim. The `kind='test_run'` namespace and the
server-side derivation together make the test-run keyspace STRUCTURALLY disjoint from the `kind='execution'`
keyspace, independent of whatever string the caller supplies.

**Dedupe semantics.** Repeat or concurrent `real_fire`s carrying the **SAME** `testRunOperationId` (same actor,
same rule) derive the **same** scoped root and dedupe through the same-transaction applied-ledger claim (§2): the
first claim wins the `UNIQUE(kind, root_execution_id, action_key)` row (§2.2) under `kind='test_run'`, later ones
see the row and SKIP — exactly-once-effective for class A, same construction as retry. A **NEW**
`testRunOperationId` derives a **distinct** scoped root and re-applies — callers who want a fresh run mint a fresh
key; callers retrying an interrupted `real_fire` reuse the key.

---

## 7. Folded-in rulings and genuine cross-refs (standalone-ratifiable, owner P2)

**Q1/Q2/Q6 are FOLDED IN as #4196's OWN v1 rulings — they are NOT "pending #4164 ratify" (owner P2).** The
prior draft listed them as #4164 rulings carried by reference "pending #4164's own ratify," which was
self-contradictory: this document's `real_fire`/`simulate` test-run runtime (§6) **depends on** Q2 and Q6, so
#4196 cannot be standalone-ratifiable while its runtime waits on another lock's ratify. This Rev therefore
**adopts Q1/Q2/Q6 as this lock's own contracts** (each keeping a "(origin: #4164)" provenance note but stated
as #4196's requirement, exactly like C1/C4 below), so ratifying #4196 alone yields an implementable test-run +
retry spec:

- **Q1 (folded)** — retry stays `requireAdminRole()`; resume permission unchanged. (The retry(admin) /
  test-run(`canManageAutomation`) asymmetry is intentional and documented.)
- **Q2 (folded)** — test-run defaults to `simulate`; `real_fire` is an explicit opt-in carrying confirm +
  capability + the C1 idempotency key + the applied-ledger.
- **Q6 (folded)** — `simulate` requires `canManageAutomation` + record-**readable** (not writable); MAY write a
  values-free audit/execution-log row; MUST perform zero business side-effects / egress / notifications /
  approvals (spy-proven, §9 V6).

**Genuine cross-refs (NOT runtime dependencies of this lock — stay #4164's, no ratify-coupling):**

- **Q7** — S3 (attendance/DingTalk notification redelivery, #4085/#4102) stays fenced OUT of the automation
  `executeRule` path; any future "resend" affordance for automation-triggered notifications routes through the
  existing narrow single-row DingTalk redelivery mechanism, not through a new automation-path redelivery.
- **C5** — retry (`retryExecution`, whole re-run from step 0) and resume (`resumeExecution`, tail-continuation
  via token claim) are different mechanisms; this document's applied-ledger applies to retry only; resume keeps
  its existing token + fingerprint guards unchanged and must not regress.
- **C6** — S3 is narrowly the shipped single-failed-DingTalk-row `redelivery_safe=true` operator route; not a
  general redelivery entry point.

**NO LONGER carried by reference — folded in as #4196's own contracts (see the Rev note at the top).** #4164's
**C1** (`testRunOperationId` test-run idempotency key) and **C4** (`action_key` structural identity), plus the
`meta_automation_action_applied` applied-ledger **row shape**, were previously listed here as ratify-dependencies
on the still-open #4164. This Rev **folds all three into this document as its own locked contracts** — C4 → §2.1,
row shape → §2.2, C1 → §6.1 — each keeping a one-line "(origin: #4164 …)" provenance note but stated as #4196's
own requirement. They are therefore NOT in the carried-by-reference list above and do NOT need #4164 ratified
first. Only **Q7/C5/C6** remain genuine #4164 cross-refs (Q1/Q2/Q6 are folded into this lock per §7 above; Q3 is superseded) — those three are unchanged and carry no ratify-coupling to #4196.

This document edits neither the 2026-07-09 lock file nor #4164's refresh file — it is a standalone amendment
that supersedes only #4164's Q3 (and the C2 "at-least-once vs at-most-once" framing that produced Q3), for the
reasons in §0.

**Self-containment — stated plainly (owner directive, this Rev).** This document's LOCKED contracts are now
**self-contained**: §2's same-transaction ledger claim has its `action_key` structural identity defined in **§2.1**
and its `meta_automation_action_applied` row shape defined in **§2.2**, and §6's `real_fire` test-run has its
`testRunOperationId` defined in **§6.1** — all three folded in as #4196's own contracts (each with an "(origin:
#4164 …)" provenance note), not left as by-reference dependencies. **Ratifying #4196 DOES yield an implementable
spec**: §10's migrations have a defined `action_key` identity, ledger-row shape, and test-run idempotency key to
implement against, all locked WITHIN this document. #4196 no longer requires #4164's C1 or C4 to be ratified
first. **Q3 is SUPERSEDED, not open (owner P2 — resolving the earlier "superseded vs still-open" contradiction):**
#4196's per-action-type classification (§1) *replaces* #4164's Q3 "one global durability trade" premise, so Q3 is
**closed by supersession** — it is NOT a still-open #4164 item and does NOT appear in any open-question list here.
Q1/Q2/Q6 are **folded into this lock** (§7) as #4196's own rulings. The only genuine remaining #4164 cross-refs
(Q7, C5, C6 — S3/resume boundaries) and #4164's own separate items (C2/C3) are NOT blockers of #4196's
implementable surface and carry no ratify-coupling to #4196.

**No open questions of its own.** With this Rev's rulings (§8 Q-A..Q-D now DECIDED for v1), **#4196 carries zero
open questions** — every contract it needs (§2.1 `action_key` identity, §2.2 row shape incl. the `kind`
discriminator, §3 class-B two-phase keying, §6.1 test-run derivation, and the §8 v1 rulings) is decided WITHIN
this document. An open-question doc is not standalone-ratifiable; this one now is.

---

## 8. v1 rulings (DECIDED — #4196 carries no open questions)

**These four items (Q-A..Q-D) were previously 待 owner 裁决; this Rev CLOSES them as v1 DECIDED rulings** so
#4196 is genuinely standalone-ratifiable (an open-question doc is not ratifiable). Each states the v1 decision;
any listed alternative is an explicitly-deferred later slice, NOT an open question. The Q- labels are retained
only as stable cross-reference anchors.

**Note — one gap surfaced during drafting is intentionally NOT listed as a Q- item below.** Adversarial review of
this document found that §2, as originally drafted, mandated wrapping `executeUpdateRecord`/`executeCreateRecord`/
`lock_record` in `withTransaction` but never required `FOR UPDATE` on the lock-check SELECT — leaving the
lock-guard write-through race (§2's new "load-bearing element" paragraph) open by omission. That is a
**correctness fix, not an owner-discretion question**: §2 now REQUIRES `FOR UPDATE`, closing it outright rather
than deferring it here. It is recorded in this note so the trail shows the gap was consciously found and closed
during this document's own drafting, not silently carried forward or later discovered as an oversight.

- **Q-A — `send_notification` rule-path classification. DECIDED (v1): B′ non-durable `send_notification` is
  FORBIDDEN from the `real_fire` path** and left OUT of the applied-ledger. It has no durable write to
  double-apply, so there is no durable state to dedup — participating in `real_fire` would only add an
  unguardable re-emit. A re-emitted in-app notification on a plain retry path is a minor UX annoyance, not a
  correctness bug. **Deferred (not open):** if/when a durable rule-path notification write is added, reclassify as
  class A or B (depending on whether the durable write is local-DB or has external delivery semantics) — at which
  point it may be admitted to the guarded path. Until then, `real_fire` excludes it (§1 B′ row, §6).

- **Q-B — HTTP 4xx classification. DECIDED (v1): every 4xx defaults to `outcome_unknown`** (never auto-resend),
  and only definite pre-dispatch non-delivery (DNS failure, connection-refused, TLS-handshake failure — nothing
  ever sent) is plain `failed`. **No 4xx subset is adopted as definite `failed` in v1.** This matches the
  DingTalk transport's `send`-tier reasoning (`transport.ts:110-136`) — a `send`-tier ambiguous failure is never
  auto-resent — rather than inventing a webhook-specific boundary; a proxy/WAF can synthesize a 4xx after
  forwarding, a 409 idempotency-key conflict means the server already saw a prior copy, and a 4xx can accompany
  partial processing. A 429 specifically stays `outcome_unknown` (it may have been received and rate-limited
  AFTER partial processing; the transport doc left 429 auto-retry deliberately disabled). **Deferred (not
  open):** a future *endpoint-declared* narrow subset of 4xx (e.g. a documented 400 an endpoint emits ONLY on a
  schema-invalid body it provably never processes) may be promoted to definite `failed` — but that is a post-v1
  change, endpoint-declared, never inferred from the status code alone.

- **Q-C — rule-changed handling (§4). DECIDED (v1): (a) refuse outright** — a rule-changed retry returns `409
  RULE_CHANGED`, matching resume's existing `RULE_CHANGED` behavior (which has no re-authorization escape hatch
  either). **Deferred (not open):** (b) explicit re-authorization (`acknowledgeRuleChanged`) is NOT built in v1;
  it is a possible later slice only if operators find refuse-outright too disruptive in practice. Do not build (b)
  speculatively.

- **Q-D — retry age bound + retention coupling (§5), i.e. #4164's C3 (a)/(b)/(c). DECIDED (v1): (a) cap retry
  eligibility to ≤ ledger retention** as the primary age-bound guard (bounded, easy to reason about) **plus (c)
  fail-closed on a missing-ledger-row-for-an-eligible-root** as the second, independent safety net (catches
  retention math bugs, corruption, or migration gaps that (a) alone would not). **Option (b) is NOT adopted** —
  retention keyed to eligibility (rather than a fixed window) adds unbounded-growth risk to the ledger table for
  little benefit over (a)+(c). The exact numeric retention window is an ops-config value, not an open design
  question.

---

## 9. Verification requirements (how the runtime PROVES each claim — not merely "is tested")

Each claim below needs BOTH the assertion test AND a positive-control leg proving the assertion CAN fail when
the guard is absent — an "assert it doesn't happen" test with no positive control is unfalsifiable (repo
doctrine: a test suite that is entirely fail-closed assertions goes green even if the observation channel itself
is broken).

- **V1 — class-A same-transaction claim (§2).** Test: start a retry against a root with one not-yet-applied
  `update_record` action; inject a failure (throw) AFTER the business `UPDATE` statement executes but BEFORE the
  transaction commits (e.g. force a subsequent statement in the same transaction to fail, or abort the
  transaction directly). Assert: (a) the record's data is UNCHANGED from before the retry (the `UPDATE`'s effect
  did not survive), AND (b) `meta_automation_action_applied` has NO row for that `(root_execution_id,
  action_key)`. **Positive control:** the identical retry WITHOUT the injected failure — assert the record data
  DID change AND the ledger row DOES exist. Without the positive control, a test harness that silently no-ops
  the whole retry path would pass V1's negative assertion vacuously.

- **V1b — third-party lock committed while the class-A lock-check SELECT is blocked on it (§2's `FOR UPDATE`
  requirement).** Test (real-DB, two DB sessions). Session **L** (an actor OTHER than the automation's — one it
  cannot unlock): open a transaction and take the target row (`UPDATE meta_records SET locked = true, locked_by
  = <other-actor>, ... WHERE id = $1 AND sheet_id = $2`), leaving the transaction OPEN (not yet committed).
  Session **A** (the class-A retry, e.g. `update_record`): run it naturally so it reaches its lock-check `SELECT
  ... FOR UPDATE` on the SAME row — assert A BLOCKS, proven via `pg_blocking_pids()` / `pg_stat_activity` showing
  A's backend PID blocked on L's backend PID, **not** a wall-clock timer (a timer only shows "took a while," not
  "was actually waiting on this row's lock"). L then COMMITs, making the lock durable; A's SELECT unblocks,
  returns `locked = true`, and `ensureRecordNotLocked` (`:2205`) throws. Assert: (a) the automation step is
  REJECTED (`status: 'failed'`, "Record is locked"), and (b) the record's data is UNCHANGED — the automation
  never wrote through L's lock. **Positive control:** run the identical scenario with NO Session L (no
  interposing lock) — assert the SAME automation op is NOT blocked and DOES succeed, proving V1b isn't vacuously
  "always rejects" — it specifically detects the interposed lock, not automation writes in general. (A separate,
  non-standing mutation-check — reverting the lock-check SELECT to a plain `SELECT`, no `FOR UPDATE`, and
  confirming V1b then fails because the automation writes through L's lock instead of blocking — belongs to
  §10's mutation/fault-injection pass, not this leg: it requires reverting the guard itself, which cannot be a
  permanent green-suite assertion.)

- **V2 — class-A concurrent-retry dedup (§2).** Test: fire two concurrent retry requests against the same root
  and same not-yet-applied action. Assert: the business mutation is applied exactly once (query the record's
  final state / a mutation-count spy), and exactly one of the two responses reports the action as newly-applied
  while the other reports `already_applied`. **Positive control:** run the same two concurrent requests against
  two DIFFERENT roots (or with the applied-ledger check stubbed out) and assert the mutation IS applied twice —
  proving the test's concurrency harness can actually observe a double-apply when the guard is bypassed.

- **V2b — `real_fire` test-run dedup on `testRunOperationId` (§6.1, folded C1).** Test: issue two `real_fire`
  test-runs of the same rule (containing one class-A `create_record`/`update_record` action), same actor,
  carrying the **SAME** `testRunOperationId` — run them both sequentially AND as a concurrent pair. Assert: the
  class-A business mutation is applied **exactly once** (the same `(kind='test_run', actor, rule, clientKey)`
  derives the SAME scoped `root_execution_id`, so both runs claim the same `(kind, root_execution_id, action_key)`
  row and the second SKIPs), and exactly one run reports the action newly-applied while the other reports
  `already_applied`. **Positive control:** issue the two test-runs with **DIFFERENT** `testRunOperationId`s —
  assert the mutation IS applied twice (two distinct derived roots = two runs), proving the dedup is specifically
  keyed on the caller-supplied key and is not "test-run never applies twice for any reason." (For `create_record`,
  "applied twice" = two distinct `rec_${randomUUID()}` records, the §2 sharpest-example failure mode.)

- **V2c — test-run namespace isolation: a client value can NEVER address a real execution (§6.1 guarantee).**
  Three legs, all RED-before (each fails if the client value is used as the ledger root directly):
  - **(a) two different rules, SAME `clientKey` ⇒ independent scoped roots.** Issue a `real_fire` for rule R1 and
    another for rule R2, same actor, carrying the **identical** `testRunOperationId`. Assert the two derive
    **distinct** scoped `root_execution_id`s and each class-A mutation applies independently (neither dedups
    against the other). **Positive control:** same rule + same clientKey (the V2b case) — asserts the harness CAN
    observe dedup when the derived roots do coincide, so leg (a)'s independence is a real distinction, not a
    harness that never dedups.
  - **(b) a `testRunOperationId` crafted to EQUAL a real execution's `root_execution_id` ⇒ still disjoint.**
    Seed a real (`kind='execution'`) applied-ledger row for some `root_execution_id = X` and `action_key = K`.
    Issue a `real_fire` whose `testRunOperationId` is crafted so the raw value equals `X`. Assert: the test-run
    claims under `kind='test_run'` (a server-derived root, disjoint keyspace) and does NOT see, dedup-skip, or
    overwrite the real `(kind='execution', X, K)` row — the real row is byte-for-byte unchanged and the test-run
    applies on its own row. **Positive control:** a second real (`kind='execution'`) claim on `(X, K)` DOES
    dedup-skip against the seeded row — proving the harness can observe a collision WITHIN a namespace, so leg
    (b)'s cross-namespace non-collision is the `kind` discriminator working, not the ledger never colliding.
  - **(c) same `(kind, actor, rule, clientKey)` twice ⇒ dedup** — the V2b assertion, restated here as the third
    isolation leg for completeness.

- **V3 — class-B ambiguous outcome → `outcome_unknown`, never auto-resent (§3).** Test: configure the outbound
  transport mock to simulate a timeout (or connection reset) on a `send_webhook` action's attempt. Assert: (a)
  the action's ledger/outcome row is `outcome_unknown` (not `failed`, not `success`), and (b) a subsequent retry
  of the same root does NOT invoke the outbound transport a second time for that action (spy call-count stays
  at 1) — assert this across BOTH "retry immediately" and "retry after the ledger's normal retention window"
  (the row must stay terminal regardless of ledger sweep timing, since sweeping the `applied` ledger must never
  be conflated with clearing an `outcome_unknown` marker). **Positive controls, two required:** (i) simulate a
  clean 2xx success on the same action — assert the outbound transport IS marked `sent` and a subsequent retry
  does NOT re-invoke it (proves success-path skip works, isolating that V3's skip is specifically about
  `outcome_unknown`, not "retry never re-invokes anything"); (ii) simulate a definite non-delivery (e.g.
  connection refused — a pre-dispatch failure where nothing was ever sent, classified plain `failed` per §3, not
  the §8 Q-B 4xx path) — assert THIS one CAN be marked plain `failed` and
  IS eligible to re-fire on a subsequent retry (proves the test can distinguish "ambiguous, blocked" from
  "definite-failure, retryable" — without this leg, a test that treats ALL outcomes as unretriable would also
  pass (b) vacuously).

- **V4 — rule-changed fail-closed (§4).** Test: capture the fingerprint of an original failed execution's rule
  actions, edit the rule (change one action's config), then retry. Assert: the retry is refused with
  `RULE_CHANGED` (or the equivalent code) and NO action — class A or class B — is dispatched. **Positive
  control:** retry the SAME original execution WITHOUT editing the rule — assert it proceeds normally (proves
  the guard is comparing fingerprints, not simply always refusing).

- **V4b — `action_key` includes `action.type` (§2.1 type-distinguishing property).** RED-before test: build a
  rule with one action at a fixed `structuralPath` and a given `config`; capture the original-execution
  fingerprint. Then edit the rule so the action at that SAME `structuralPath` keeps the SAME `canonicalConfig` but
  its **type** changes `lock_record → delete_record`. Assert BOTH: (a) the two actions produce **DISTINCT**
  `action_key`s (the applied-ledger claim for one does NOT suppress the other), AND (b) a retry against the edited
  rule is refused with **`409 RULE_CHANGED`** (the §4 drift guard detects the type swap). **Positive control:**
  retry with NO edit (same path, same config, same type) — assert the fingerprint matches and the retry proceeds,
  proving the guard compares the type component rather than always refusing. Without V4b, an identity that omitted
  `action.type` would let `lock_record {}` and `delete_record {}` collide on one `action_key` — RULE_CHANGED miss
  AND wrong dedup — and go green.

- **V5 — retry age bound + missing-ledger-row fail-closed (§5).** Two tests: (a) retry an execution older than
  the configured retention window — assert `409 RETRY_WINDOW_EXPIRED` (or equivalent) and no dispatch;
  **positive control:** retry an execution just inside the window — assert it proceeds. (b) simulate a ledger
  row deliberately absent for an otherwise-eligible, within-window root (e.g. delete the row out-of-band in the
  test) — assert the retry is refused rather than silently treated as "nothing applied yet, safe to run from
  scratch"; **positive control:** a genuinely-first retry (ledger never populated because this really is
  attempt #1) proceeds normally — proving the guard distinguishes "evidence deliberately missing" from
  "evidence never existed because this is the first attempt" via the disambiguating signal (e.g., an explicit
  `retry_count` or `first_attempted_at` marker on the execution row, independent of the ledger table), not by
  ledger-row-count alone — per the §8 Q-D v1 ruling ((a) age-bound ≤ retention + (c) missing-row fail-closed).

- **V6 — `simulate` zero business dispatch (§6, carried forward from #4164 G5).** Spy every class-A and class-B
  handler; run `simulate` against a real record; assert ZERO calls to any of them, `dryRun: true` in the
  response, and (per Q6) that the execution-log/audit row IS written (proving `simulate` is not simply "the
  whole call was a no-op" but specifically "business side-effects were suppressed while bookkeeping continued").

- **V7 — lease fencing: a "zombie" cannot double-complete (§3, the fence-CAS leg §3 marks RED-before).** Test
  (real-DB, two workers): worker A claims the lease row (fence = N), the harness advances the clock past
  `lease_expires_at` **while A is still alive** (simulate a stalled A — do NOT crash it), worker B reclaims
  (fence = N+1) and completes. Then let the **zombie A** attempt its terminal durable write on its **lease
  row** (the `event_fires` re-execution lease or the class-B two-phase intent row — mark `done` / `sent` /
  `outcome_unknown`; **NOT** the terminal `meta_automation_action_applied` claim table, which carries no fence)
  with its **stale fence N**. Assert: (a) A's fence-CAS `UPDATE … WHERE … AND fence = N` affects **0 rows** — A
  learns it was superseded and aborts, writing no terminal state; (b) the lease row's terminal state is B's,
  written exactly once; (c) for class-A, the additional `UNIQUE(kind, root_execution_id, action_key) ON
  CONFLICT DO NOTHING` on the claim table independently blocks A's **mutation** (the claim table needs no fence
  precisely because the UNIQUE constraint already makes the mutation single-writer).
  **Positive control:** run the identical two-worker sequence with the fence check **bypassed** (stale write
  uses no fence predicate) and assert a **double-write / double-complete IS observed** — proving V7 detects the
  zombie abort specifically, not "the harness never lets two workers touch the row." (Bypassing the fence is a
  §10 mutation-pass leg, not a standing green assertion.)

- **V8 — poison event reaches a terminal `failed`/`dead_letter`, not infinite reclaim (§3, the poison-terminal
  leg §3 marks RED-before).** Test: a **deterministically permanent-failing** class-A action (e.g. its target
  record is deleted before every attempt) is retried/re-leased. Assert: after the **bounded `attempts` cap**
  the row moves to terminal `failed`/`dead_letter` (no further auto-reclaim) and the alert seam fires — NOT an
  unbounded reclaim loop. **Positive control:** a **transient** failure (fails once, then its cause is removed)
  **succeeds** on a later attempt and reaches `done` — proving the cap distinguishes permanent from transient,
  not "gives up on the first failure." Assert `outcome_unknown` (outbound-ambiguity terminal, §3) is a
  **distinct** state from `failed`/`dead_letter` (deterministic-DB-write-failure terminal).

- **V9 — class-B lease liveness: bounded reclaim + lease-duration invariant (§3, the class-B storm leg).** Test:
  a class-B send whose single-attempt latency (including timeout) is configured to **exceed** the lease
  duration. Assert the design's guard holds — either the invariant **`lease_duration ≥ max single-attempt
  latency`** is enforced (the worker is never reclaimed mid-attempt, so it always reaches a terminal
  `outcome_unknown`), OR a **bounded reclaim cap** moves the intent to `dead_letter` — so the outbound send is
  NOT re-attempted unboundedly. **Positive control:** with latency **within** the lease, the send reaches its
  terminal outcome in one attempt. (Bounds the "every worker reclaimed mid-attempt → unbounded duplicate send"
  storm that fence-CAS alone does not close, since fencing protects durable state, not send liveness.)

---

## 10. TODO checklist (gated; nothing below may start before RATIFY)

- 🔒 **RATIFY** this design-lock (owner) — blocks everything below. **This document is self-contained:**
  ratifying #4196 IS sufficient to yield an implementable spec — the `meta_automation_action_applied` row shape
  (§2.2), the `action_key` identity (§2.1), and the `testRunOperationId` test-run key (§6.1) are all folded in as
  #4196's own locked contracts, so §10's migrations have a defined target WITHIN this lock and do NOT wait on
  #4164's C1/C4 to be ratified first. **Q1/Q2/Q6 are ALSO folded in as #4196's own rulings (§7) and Q3 is
  SUPERSEDED by §1's per-action-type classification — none of them waits on #4164 ratify** (the test-run runtime
  depends on Q2/Q6, so they could not). Ratifying this document does NOT automatically ratify #4164's genuinely
  remaining items — only **Q7/C5/C6** (S3/resume cross-refs) and **C2/C3** (#4164's own separate items) — and
  those are cross-references, not blockers of #4196's own implementable surface.
- ⬜ Migration: `meta_automation_action_applied` per **§2.2's row shape** (defined in this lock), including the
  NON-OPTIONAL `kind` column and the `UNIQUE (kind, root_execution_id, action_key)` claim key, consumed under
  the class-A same-transaction contract (§2) — including wrapping `create_record`/`update_record` in
  `withTransaction` (currently only `delete_record` is wrapped).
- ⬜ Migration/table: class-B two-phase intent/outcome tracking (`pending` → `sent`/`failed`/`outcome_unknown`),
  keyed to the same `(kind, root_execution_id, action_key)` identity (same `kind` discriminator as §2.2).
- ⬜ Executor: `send_webhook`/`send_email` gain the ambiguous-vs-definite classification (§3, §8 Q-B: every 4xx ⇒
  `outcome_unknown`) replacing today's single `'failed'` collapse (`automation-executor.ts:2568-2579`).
- ⬜ Service: `retryExecution` gains the rule-drift `RULE_CHANGED` guard (§4, §8 Q-C: refuse outright), mirroring
  `resumeExecution`'s existing fingerprint check, using **§2.1's `{ structuralPath, action.type, canonicalConfig }`
  identity** (folded C4, now type-inclusive).
- ⬜ Service: `retryExecution` gains the age-bound + missing-row fail-closed guards (§5) per **§8 Q-D's v1 ruling**
  ((a) age-bound ≤ ledger retention + (c) missing-row fail-closed).
- ⬜ Service/Route: `testRun` gains `simulate`/`real_fire` per §6, taking **§6.1's `testRunOperationId`** (folded
  C1) as a validated INPUT the server DERIVES a scoped `kind='test_run'` ledger root from — never used as a real
  execution's `root_execution_id` directly; B′ `send_notification` excluded from `real_fire` (§8 Q-A).
- ⬜ Service: **`meta_automation_action_applied` stays a TERMINAL claim table** (a `UNIQUE(kind,
  root_execution_id, action_key)` claim row — no `lease`/`status`/`fence`/`attempts` on it; owner P2). The
  **lease + fence + bounded-attempts live ONLY on the reclaimable rows** — the `event_fires` re-execution lease
  and the bridge continuation lease (and #4203's outbox rows). Every terminal durable-state write on a *lease*
  row is a **fence-CAS**; a zombie's class-A **mutation** is blocked independently by the claim table's UNIQUE
  `ON CONFLICT DO NOTHING` (not a fence — the claim table has none). class-B gains a **bounded reclaim/attempts
  cap** + the **`lease_duration ≥ max single-attempt latency`** invariant (§3, V7/V9); a deterministically-
  failing class-A action reaches terminal `failed`/`dead_letter` after bounded attempts on its **lease** row (V8).
- ⬜ Tests: the V1, V1b–V9 verification requirements in §9 (including **V2c** namespace-isolation, **V4b**
  `action.type` type-distinguishing, **V7** fence-CAS zombie-abort, **V8** poison-terminal, and **V9** class-B
  lease liveness), each WITH its positive-control leg, real-DB where the transaction/ledger/lease behavior is
  exercised.
- ⬜ Verification doc + adversarial review before merge — including an explicit mutation-test or fault-injection
  pass on the class-A transaction boundary (V1), the class-A `FOR UPDATE` lock-check (V1b — revert the lock-check
  SELECT to a plain `SELECT` and confirm V1b then FAILS because the automation writes through a concurrent lock
  instead of blocking on it), the class-B ambiguous-outcome classifier (V3), **the fence-CAS zombie-abort (V7 —
  revert to a fence-less write and confirm a double-complete IS then observed), and the poison-terminal bound
  (V8 — remove the attempts cap and confirm the reclaim loop then goes unbounded)** — since all of these are
  exactly the kind of "assert it doesn't happen" guard that can go green while silently not wired.

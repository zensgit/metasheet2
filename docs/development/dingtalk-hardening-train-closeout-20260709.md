# DingTalk Sync Hardening — Train Closeout and Verification Ledger

- Date: 2026-07-09
- Status: **the 10-car landing train is drained — all 10 cars merged to `main`.** Two earlier-line cars remain OPEN and are *not* landed: **#3898 (DT-HARDEN-03) and #3903 (DT-HARDEN-05)** — see §1. This is the record of what shipped, how each was re-verified through the merge, and what remains.
- Companions on `main`: `dingtalk-sync-hardening-design-and-verification-20260708.md` (Rev 1 → Rev 2, the per-ticket design + verification) and `dingtalk-hardening-second-review-round-20260709.md` (the second adversarial round). This document is the *landing* record those two anticipated.

---

## 1. What landed

Ten PRs, each merged into `main`. Every one was independently adversarially reviewed, every fix mutation-proven, and every one re-verified after its rebase through a continuously-moving `main`.

| PR | Ticket | Merge SHA | What it fixes |
|---|---|---|---|
| #3896 | DT-HARDEN-02 | `35a406f20` | auto-admission committed orphan users → per-account SAVEPOINT makes INSERT+bind all-or-nothing |
| #3902 | DT-HARDEN-04 | `174dd1df5` | batch bind/unbind per-item isolation + audit trail |
| #3900 | DT-HARDEN-06 | `f2aa3242d` | request timeouts + honest partial-failure delivery semantics |
| #3897 | DT-HARDEN-08 | `64eae0b5f` | strict robot response, delivery indexes, message-length guards |
| #3915 | DT-OPS-02 | `795cc8e28` | read-only sync preview + opt-in async; preview/apply candidate-count parity |
| #3914 | DT-OPS-03 | `7054491c5` | sync-failure alerts delivered over DingTalk + manager-coverage metric + endpoint |
| #3905 | DT-OPS-01 | `8bc8d5aad` | offboarding executor — never deprovision an employed person; empty-fetch/mass-departure circuit breaker |
| #3910 | DT-OPS-04 | `2c9e5b8ac` | work-notification credentials scoped to the recipient's own integration (no cross-corp) |
| #3884 | DT-HARDEN-10 | `cc6904fca` | CSV header-detection parity on the streaming import path |
| #3911 | DT-PERF-01 | `1f0af4d7f` | batched `unnest` account-department upsert *inside* the DT-HARDEN-07 write seam |

(DT-HARDEN-01 `#3882`, DT-HARDEN-07 `#3904`, DT-HARDEN-09 `#3883`, DT-HARDEN-11 `#3885`, and DT-OPS-05 `#3907` landed earlier in the line; #3908/#3933/#3954 are the design/verification MDs. **Correction, verified against `gh` on 2026-07-09: DT-HARDEN-03 `#3898` and DT-HARDEN-05 `#3903` never merged and remain OPEN** — both were adversarially reviewed (#3903 APPROVE-with-hardening; #3898 CHANGES-REQUESTED, partially addressed on its branch) but neither joined the landing train. `main` today has no sync-run lease and no at-rest encryption for group-robot credentials. The roadmap's 17 tickets are therefore **15/17 landed**; #3898 and #3903 are the first cars of the follow-up pool below.)

---

## 2. The verification standard, and how the rebases held it

Every car was rebased onto a `main` that moved dozens of commits during the landing. The rule enforced at each rebase — because a rebase can silently revert a landed sibling or drop a test — was: **re-run the golden and re-fire the load-bearing mutation on the rebased head, not just resolve the merge.**

- **#3905** rebased through the recurring insertion-point conflict (main's DT-HARDEN-07 block + #3915's identity-match predicate both landing at the same spot as its deprovision executor). Kept-both, then re-proved: three real-DB suites 18/18, and **mutation E — invert the selection to deprovision every active employee — RED ×6** (the exact mutation that once left 4354 tests green).
- **#3915** refactored the live apply cascade into a shared predicate; its rebase kept both blocks, and the re-fired **mutation A (preview counts unconditionally) → RED ×2** confirmed the parity guard survived. The apply-equivalence itself was independently gated: a byte-identical pure extraction.
- **#3910** hit a multi-generation test interleave (main's H06/H08 tests vs two generations of its own OPS-04 tests at one insertion point). Two region-surgery attempts cut or duplicated tests; both were caught by the roster/line-count integrity check before anything was pushed. The clean fix was to compute the PR's *net* delta (+72/−0) and construct the terminal tree directly. Post-rebase: **mutation B (delete the scoping) → RED ×3**.
- **#3897** hit the predicted #3900↔#3897 collision in `automation-v1.test.ts`; both tests were reconstructed from pristine sources, and both sides re-mutated (revert H06 partial-failure → RED; drop truncation → RED ×2).
- **#3911** rebased onto the fully-drained main **with zero conflicts** (its write seam was untouched by the other nine merges); its anti-revert mutation (builder → `departmentIds[0]`) still reddens 4 real-DB goldens.

No car was accepted on the strength of a green rebase alone.

---

## 3. Systemic findings reinforced

- **A real-DB golden runs in no CI job unless wired at two points** — excluded from the no-DB glob job so it cannot skip-green, and added as a whole file (never a `-t` name filter) to a real-DB step. Every golden added across this line is wired at both.
- **Mutation testing proves a guard is load-bearing with respect to the tests that exist** — not that it is the right guard, and not that its selection predicate is covered. Four of the original P1s, and several round-two P2s, passed mutation testing while a fixture shadowed the thing under test (a fake client ignoring the `WHERE`, an env var short-circuiting a resolver, a mock returning the answer, a plaintext fixture making every decrypt a no-op). The correction adopted: anything deciding *who loses access / whose routing changes / whose credentials are used* is proved against real Postgres through the real call site.
- **Multi-generation test-conflict rebases**: when a PR's own tests have multiple generations and main has landed adjacent tests at the same insertion point, region surgery is unreliable — compute the PR's net delta and build the terminal tree, then assert `+N/−0` and a one-of-each roster.

---

## 4. Merge mechanics, recorded honestly

The train drained one car at a time (single armed window inside the DingTalk code train), auto-merge firing at the atomic green+current instant. On a `main` with **strict up-to-date + no merge queue**, and a merge cadence (~10–17 min) faster than an ~8-min CI cycle, this is a timing game: a car goes green and is immediately behind again. The discipline that worked: let auto-merge self-heal, intervene with a single rebase only after a confirmed-stuck window, and time the nudge to a *fresh gap start* rather than mid-gap. The last car (#3911) was sniped repeatedly and finally landed by holding its winning position through a genuine main lull rather than reshuffling it. No `--admin` bypass was used — the up-to-date gate was respected throughout.

---

## 5. Follow-up backlog (unblocked now that the train has drained)

| Item | Source | State |
|---|---|---|
| **#3903 (DT-HARDEN-05)** — sync-run lease | first round review (APPROVE-with-hardening) | **OPEN, unmerged** — first car of the follow-up pool; the heartbeat hardening below folds into it |
| **#3898 (DT-HARDEN-03)** — group-robot credential encryption at rest | first round review (CHANGES-REQUESTED) | **OPEN, unmerged** — update-path ciphertext test added on branch; backfill SALT check, tsconfig inclusion, and credential-surface coverage still due |
| **#3972 P2-1** — case-insensitive admission uniqueness + server-side batch-admit eligibility (a live duplicate-user defect) | #3972 review | **Fixed in PR #3998** (gated ACCEPT, mutation-proven real-DB), rebased onto post-#3911 main |
| Approval-card ledger `deliveryStuckPending` executor-level test | #3900 P2 | recipe recorded; observability, not correctness |
| Delivery-telemetry retention sweep | DT-HARDEN-08 tail | not started |
| `integration_id` on `dingtalk_approval_card_deliveries` (approve/reject callback) | DT-OPS-04 R2 | not started (additive migration) |
| Refuse a sync preview while a run holds the lease | DT-OPS-02 R3 | not started (requires #3903 to land first — there is no lease on `main` today) |
| Per-run change summary; admin async-polling UI | OPS-02/03 remainder | not started |
| A heartbeat column on sync runs (un-reclaimable recent crash + stolen-lease) | DT-HARDEN-05 §8.5 | not started (folds into #3903 itself, which is still open) |

The provider-agnostic org-transfer line (`#3941` assessment + `#3944` dev plan) remains a separate design-lock track, on its own ratify cadence, not part of this train.

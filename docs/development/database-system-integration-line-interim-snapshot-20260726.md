# Database & System Integration Line — INTERIM SNAPSHOT (2026-07-26T15:27:35Z)

> **⟲ RETITLED (owner, round 3). This is NOT a closeout record.** Earlier revisions called it one while
> **ten line tickets are still open** — a closeout cannot be written while the line is open. It is a
> **point-in-time snapshot**, it closes nothing by merging, and it **will be regenerated when the line
> actually closes**. The retraction is recorded rather than the title silently changed.

## 0.0 SAMPLING BASIS — one sampling, all of §2 drawn from it

| | |
|---|---|
| `recordedAt` | `2026-07-26T15:27:35Z` |
| `mainSha` | `ac05efa25fd0dfdae0779e7ae14a3a942a0c374e` |
| open PRs in repo | **134** |
| IN_LINE | **10** (this record, #4622, excluded) |
| OUT_OF_LINE | **123** |
| **UNCLASSIFIED** | **0** |

**STALENESS RULE, machine-checkable:** this record is **stale the moment any new open PR appears or any
listed `headRefOid` moves**. It does not degrade gracefully; re-sample before relying on it.
Basis lineage: `4be09076d` → `df610db9a` → `ac05efa25fd0dfdae0779e7ae14a3a942a0c374e`.

### 0.1 ENUMERATION METHOD — full set, then classify (⟲ replaces the method that failed twice)

The previous method used a **keyword pre-filter** plus a hand cross-check **bounded at #4622**. It failed
completeness **twice at two different edges**: first omitting five paused tickets, then omitting **#4623 —
a PR this line's own work created**, unreachable by the keyword filter (`fix-integration-workbench-flaky`)
and by the numeric bound. **Now: read every open PR, classify each IN_LINE / OUT_OF_LINE with a reason,
assert zero UNCLASSIFIED.** Silent absence is not this document's practice.

**#4623 `5684266` is the TENTH in-line ticket**, and it is a **declared prerequisite for promoting
`integration-guard` to a required check** — the act #4614 prepares. An earlier revision listed the
`IntegrationWorkbenchView` flake as a *standing residual with no producer* while #4623 sat open fixing it.

**Revision notice.** A gate review of the first cut of this record returned **HOLD** with 3 P1s
and 1 P2. All four are corrected in §0 below, retraction-first — what was wrong is stated before
the corrected figure replaces it. Read §0 before trusting any count elsewhere in this document.

**What this document is.** The consolidation the line never had: six-plus merged PRs, **nine** open
tickets (corrected in this revision — see §0), a ratified ledger with owner amendments, a
real-engine capability spike, a four-decision roster and roughly ten rounds of adversarial
findings — none of it previously readable in one place. An owner should be able to act on every
open ticket from this record alone, without reconstructing a conversation.

**What this document is not.** It is not the ledger and does not compete with it. The single
authoritative design-and-verification document remains
`docs/development/database-system-integration-line-design-and-verification-20260724.md`
(“the ledger”; on `main` at blob `7b6931a9e6ceb24a5ef62051eb29176e08ecfea8`, re-verified
`git rev-parse origin/main:<path>` 2026-07-26 at this revision, unchanged). Where this record and
the ledger disagree, the ledger wins and this record is the thing to fix. This record adds **no**
decisions, opens **no** gates, and authorizes nothing.

**Verification basis.** Every claim below was re-derived against the repo on 2026-07-26, not
copied from prose: merge SHAs via `git log origin/main`; open-PR heads via
`gh pr view <n> --json headRefOid`; CI verdicts read from the actual run logs.

> ⟲ **The previous basis line was KNOWN-stale and the knowledge was not recorded.** It pasted
> `4be09076d` under "re-confirmed at this revision" while main had already advanced to `df610db9a`
> (#4613, attendance doc-only) **six minutes before that commit** — a fact the author had in hand. The
> delta was harmless (the ledger blob is byte-identical at both refs), but omitting a known basis change
> from the one command offered to prove "re-derived, not copied from prose" is a claim stronger than its
> evidence. Current basis is `ac05efa25`, sampled at `2026-07-26T15:27:35Z` together with every head in §2.

Basis, re-confirmed
at this revision:

```
$ git rev-parse origin/main
4be09076d192cb7bedc7f95e895c5e9305089720
```

Head-scoped discipline applies throughout: every verdict below is bound to the exact SHA it was
taken at. If a branch has moved past the SHA cited here, the verdict must be re-derived, not
carried forward. **Two of the heads cited in the original cut of this record had already moved by
the time of this revision** (#4610, #4591 — see §0); this is exactly the discipline in question,
applied to this document itself.

---

## 0. CORRECTIONS TO THIS RECORD — gate returned HOLD, 3 P1 + 1 P2, all addressed here

Retraction-first: each item states what was wrong before giving the corrected figure. Nothing
below is a silent edit to the sections that follow.

### [P1-1 — RETRACTED] "five open tickets" / "OPEN — five tickets" / "none dropped" were all false

The intro (former line 4), the former §2 heading, and the former §6 heading each asserted a closed,
five-item set. **Re-enumerated 2026-07-26 via `gh pr list --state open --limit 200`**, filtered to
this line's branches/titles (`gip-`, `b1a`/`b1b`/`b1c`, `data-source`, `canonical-object`,
`connector-kind`, `onprem-package-verify`) and then **cross-checked by hand across the full
`#4580`–`#4622` number range** to catch anything the keyword filter would miss (it caught nothing
extra; `#4617` matched the keyword filter on "b2" but is an unrelated attendance PR and is
excluded).

**Nine** open Draft PRs belong to this line, all based on `main`:

```
#4589  8471332fe9  BEHIND   13/13 SUCCESS
#4591  b52a0b030b  BLOCKED  17/19 SUCCESS, 1 SKIPPED, test(20.x) IN_PROGRESS @ 2026-07-26T14:51Z
#4593  15e71afe04  BEHIND   13/13 SUCCESS
#4594  5c87f8091c  BEHIND   14/14 SUCCESS
#4598  0900c96f90  BEHIND   13/13 SUCCESS
#4610  c25b32ddf3  BLOCKED  12/13 SUCCESS, test(20.x) IN_PROGRESS @ 2026-07-26T14:51Z
#4614  6b01ebb530  CLEAN    14/14 SUCCESS
#4619  467ec6b319  CLEAN    13/13 SUCCESS
#4620  7888ee7cc6  CLEAN    22/23 SUCCESS, 1 SKIPPED
```

**#4622 (this record) is not counted** — it is the record, not a ticket. Full rows for all nine,
including what each is waiting on, are in the rewritten §2 below.

**#4589, #4593 and #4594 were paused by the owner earlier**, which is why they fell out of prior
status reports — **paused is not absent**, and that omission carried into this record's first cut,
which is exactly the defect this document exists to fix.

### [P1-2 — RETRACTED] §2's "Nothing else blocks it" for #4610 — and the picture has moved again since

**The claim was false when written.** At the time of the gate review, **#4618** — a child PR based
directly on #4610's own branch (`claude/gip-b1a-2-identity-registries-20260725`), not on `main` —
was open and reported a **confirmed defect** in #4610, in its own words:

> `__internals.computeActivationReadiness()` converted raw `registry.lookup()` failures but
> rethrew every `GipCanonicalObjectContractError` unchanged. Because the error class is public, a
> hostile lookup could forge arbitrary `reason`, `message`, `details`, `cause`, and `stack`; those
> values escaped the module's stated closed error contract.

Scoped honestly, in #4618's own words: **"The production activation gate was checked separately
and rejects a hostile registry before this path. The defect is real but limited to the exported
`__internals` mechanism at this LATENT head."** Neither inflated nor minimised.

**Current state, re-verified at this revision (2026-07-26, 14:46–15:00 UTC):** #4618 is no longer open —
`gh pr view 4618 --json state,mergedAt,mergeCommit` reports **`state: MERGED`**, `mergedAt:
2026-07-26T14:37:35Z`, `mergeCommit.oid: c25b32ddf367098d01247374db766599c75e23bd` — merged into
**#4610's own branch**, not into `main` (base `claude/gip-b1a-2-identity-registries-20260725`).
That merge commit is now **#4610's own current head** (`gh pr view 4610 --json headRefOid` returns
the identical SHA): **#4610 moved `09aece0d7` → `c25b32ddf3`.**

The fix is confirmed landed, not merely claimed:
- `git diff --stat 09aece0d7 c25b32ddf3` touches exactly three files: the canonical-object registry
  module, its test, and #4618's own dev-verification doc — matching #4618's stated scope.
- Reading the landed module at `c25b32ddf3`: the old `instanceof GipCanonicalObjectContractError`
  brand-exemption rethrow inside `computeActivationReadiness` is gone, replaced by an unconditional
  discard (`catch { fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', ...) }`, comment: `//
  Unconditional discard — no brand exemption.`) — the exact repair #4618 describes.
- It is genuinely **not on `main`**: `git merge-base --is-ancestor c25b32ddf367098d01247374db766599c75e23bd origin/main`
  exits `1`. (Note: GitHub squash-merged #4618, so its own head `4b7fc373d` is not a graph-ancestor
  of `c25b32ddf3` — the content diff above, not commit-graph ancestry, is the correct check for a
  squash merge.)

**So: §2's "Nothing else blocks it" is RETRACTED as stated** — an open child PR reporting a
confirmed defect is precisely something that blocks a clean read of a HARD HOLD, and the original
cut of this record said otherwise. **As of this revision the specific defect is fixed and folded
into #4610's own head** — #4610 no longer needs to be "read together with #4618", because #4618's
fix is now *part of* #4610. What #4610 still needs, unchanged, is the **owner decision** to lift
the HARD HOLD and merge (or return findings) — but that decision now applies to `c25b32ddf3`, not
to the previously-cited `09aece0d7`, and the CI/merge-state snapshot underneath it has also
changed: `12/13 SUCCESS` with `test (20.x)` still `IN_PROGRESS` and `mergeStateStatus: BLOCKED`
(not the previously-cited `14/14 SUCCESS; CLEAN`, which was bound to the old head). §2 is rewritten
below with the new head. §6 residual 4 (`buildInventoryAttestation` has zero call sites) was
re-verified against `c25b32ddf3` — still true, re-cited at the new head.

**Also caught during this same re-verification pass (not separately gated, but the identical
discipline applies): #4591's head moved too**, `436dc6a1c` → `b52a0b030b`, via a plain
`Merge branch 'main' into claude/data-source-offset-ordering-b2-20260724` — confirmed content-free
by `git diff --stat 436dc6a1cf b52a0b030b`, which shows only files newly added on `main` since
#4591's branch point (e.g. `scripts/ops/gip-authority-substrate-inventory.mjs`,
`scripts/ops/multitable-onprem-package-verify.sh`, W4C-0 test files) — zero changes to #4591's own
adapter/guard files. **§2's "merge state BEHIND (expected)" and §6's former residual 13 ("#4591 is
BEHIND `main` and will need a refresh") are both RETRACTED as current fact**: #4591 is no longer
BEHIND (`mergeStateStatus: BLOCKED`, not a merge-conflict signal — `mergeable: MERGEABLE`); the
refresh residual 13 warned about has already happened **for that instance**.

> ⟲ **WRONG OPERATION — the retraction of residual 13 is itself retracted.** Under **strict** required
> checks, "must be synced to current main and have required checks re-run before merge" is **not a fact
> about one moment — it RECURS every time main advances**. Retracting it converted a **permanent
> structural invariant** into a cancelled claim. Correct form, and the form that stands:
> **SNAPSHOT (perishable):** at `2026-07-26T15:27:35Z`, #4591 / #4610 / #4614 read `BEHIND`.
> **STANDING INVARIANT (permanent):** *every ticket on this line must be re-synced and re-checked
> immediately before merge, every time main advances. A green reading at an older head is never merge
> evidence.* This applies to all ten in-line tickets, not only #4591.

### [P1-3 — REQUALIFIED] §3 item 6's "scripts/ops/ carries only the β/γ authority-substrate inventory" was false

**Verified count:** `git ls-tree origin/main:scripts/ops | wc -l` → **367** (this is the top-level
listing a reader gets from `ls scripts/ops`, and it is the number the gate cited). The recursive
count, `git ls-tree -r --name-only origin/main -- scripts/ops | wc -l` → **385**, additionally
counts the files inside **THREE** subdirectories — `__tests__`, `fixtures`, `yjs-client-validation`
(6 + 14 + 1 = 21; 364 top-level blobs + 21 = 385, so the arithmetic reproduced anyway).
⟲ An earlier revision of *this very correction* said "the one subdirectory" — a fresh false "only"
inside the paragraph correcting a false "only". Verified: `git ls-tree <main>:scripts/ops | awk '$2=="tree"'`
returns three trees. Either number contradicts
"only" — `scripts/ops/` holds hundreds of attendance/dingtalk/stock-prep/data-source ops scripts
with no relationship to this line.

**The sharper problem:** this very document's own §1 row for #4604 cites
`scripts/ops/multitable-onprem-package-verify.sh` — confirmed present at
`git ls-tree origin/main:scripts/ops | grep multitable-onprem-package-verify.sh` → blob
`89ec733a41af25bee9d7f02f608fefcbefbbd9c1` — a **second** `scripts/ops/` artifact contributed by
this very line, contradicting "only" inside the same document.

**What actually does not exist on `main` at `4be09076d`:** the specific per-deployment
`/select`-caller inventory artefact the ledger specifies (DB counts **+** a per-deployment
`/select` access-log analysis with a stated retention window **+** a static tree-wide enumeration
of `manager.select`/`adapter.select` callers — a three-part artefact per the ledger, lines 90–91).
No file matching that description appears anywhere in the 367-entry `scripts/ops/` listing on
`main`. It exists only as **open Draft #4594** (`scripts/ops/data-source-exposure-inventory.mjs` +
test + workflow, head `5c87f8091c`) — and even there only as a **partial** producer: #4594's file
list is exactly those three files, covering the schema-probed **DB-count** third only; the
per-deployment access-log analysis and the static caller enumeration are not part of this PR. §3
item 6 is rewritten below to say precisely this, interlocked with #4594's new §2 row.

### [P2-1 — ADDED] §6 gains an entry for #4620's own §10 disclosures, on par with #4614/#4610/#4591

#4620's PR body §10 ("open items this PR does not decide") discloses, verbatim in substance: (i)
only MySQL **8.0** is in the declared matrix — 5.7 and 8.4 are left open, and the isolation
variable name is resolved from the declared version with no try-both; (ii) **M-4 is implemented and
mutation-instrumented but kept non-load-bearing** — the `MYSQL_PRECONDITIONS_PROVEN` formula is
`M-1 ∧ M-2 ∧ M-3` only, per the battery's own `(∧ M-4 if ratified)` and M-4's not-yet-ratified
status; (iii) outcome-token naming is verbatim from the battery §3; (iv) the workflow ships both
`workflow_dispatch` and a path-filtered `pull_request` trigger and was **not** added to required
checks. See the new §6 entry 14 below, and the one-line pointer added to §5 pointing to it — the
`open=true` verdict for `mysql::8.0::default` **stands**, but it is a **three-condition proof
limited to MySQL 8.0**, and the owner is entitled to know that before ruling on §4 step 3.

---

## 1. LANDED — what is actually on `main`, enumerated from `git log`, not from memory

```
$ git log --oneline origin/main --grep="#4573\|#4583\|#4590\|#4601\|#4603\|#4604\|#4609\|#4553"
4be09076d fix(stock-prep): M0-A — retract freeze-act blocker, record A1 build+verify (run 30148584851) (#4604)
97cf62033 feat(ops): GIP authority-substrate inventory — β connector-kind + γ objectKey probes (#4603)
cd2670695 B1a-1: config v2 — orderingKeySpec + actionProfileVersion (additive) (#4601)
551117bef docs(integration): ⟲OD2 — amend §4 step 1.1's phantom "flip", rule the M0-A loopback check built not deleted, separate A1 from M0-A (#4609)
402f04982 docs(integration): database & system integration line — design and verification MD (RATIFIED, doc-only) (#4590)
68bcd9a67 fix(data-source): enforce the A5 row bound in MySQLAdapter + pin the SQL-adapter roster (#4583)
7bf2bd7a1 fix(gip): bridge.bounded_read.v2 — applied-limit hardening + version-lineage invalidation (#4573)
a53a199b1 feat(gip): A-wave — profile certification schema + compliance harness + read-only qualification spike (latent) (#4553)
```

Eight commits are on `main`. One (`a53a199b1`, #4553) is the **upstream GIP-D0 design lock**,
which this line defers to rather than owns; the other seven are the line’s own landed record —
two pre-ledger (recorded in ledger §1) and five post-ledger.

| PR | merge SHA | what it actually changed | evidence that pinned it |
|---|---|---|---|
| #4553 (upstream) | `a53a199b1` | GIP-D0 design lock + profile certification schema + compliance harness + read-only qualification spike, all **latent** | ledger “Upstream contracts” block; the lock wins over the ledger on all contract material incl. `systemContentKey` |
| #4573 | `7bf2bd7a1` | `bridge.bounded_read.v2`: adapter `read()` verifies the agent-echoed applied limit (missing / non-integer / divergent ⇒ fail-closed); `profileId`/`actionProfileVersion` bumped to `.v2` so old-v1 qualifications recompute to `QUALIFICATION_DIGEST_MISMATCH`. 6 files, +900 | ledger §1; profile **LATENT** — zero runtime consumers proven by tree-wide grep at merge time. Companion fact: **#4565 CLOSED unmerged** — its head `828aeb4d6` carries the pre-hardening fail-open and must never merge |
| #4583 | `68bcd9a67` | MySQL A5 row bound enforced (previously an omitted limit issued a whole-table SELECT); single frozen adapter registry (`DEFAULT_ADAPTER_REGISTRY` → derived `SUPPORTED_DATA_SOURCE_TYPES`); registry-derived A5 conformance suite. 3 files, +172 | mutation-proven: an unbounded fake adapter grew the suite 11→14 and failed its three A5 cases with zero test edits; freeze negative controls (assignment/replace/delete/push/splice all rejected) |
| #4590 | `402f04982` | the ledger itself, doc-only, 698 lines | §4 slice order **RATIFIED** by the owner 2026-07-25 at pre-squash branch head `a7c562d34` (verified: `a7c562d34` sits on `claude/database-system-integration-line-doc-20260724`, the #4590 branch) |
| #4609 | `551117bef` | ⟲OD2 amendment to the ledger (+36/−6): §4 step 1.1’s phantom “flip an existing test” replaced by a named characterisation test; M0-A loopback check ruled **built, not deleted**; A1 separated from M0-A; “an inventory TOOL is not an inventory RESULT” | doc-only; its rulings are implemented in #4601 and #4604 below |
| #4601 | `cd2670695` | **B1a-1 / §4 step 1.1**: `orderingKeySpec` + `actionProfileVersion` accepted **additively** at both enforcement points — `ALLOWED_CONFIG_KEYS` (acceptance) and `normalizeReadSourceConfig` (persistence) — plus contract shapes in `gip-profile-certification-contracts.cjs`. 5 files, +384 | the ⟲OD2 acceptance predicate: named pre-change-RED / post-change-GREEN characterisation test; save→re-read shows both fields survive into stored `config`; two bodies differing only in `orderingKeySpec` mint **different** `content_key`s (so the idempotent-save path cannot collapse them) |
| #4603 | `97cf62033` | **β/γ inventory TOOL**: `scripts/ops/gip-authority-substrate-inventory.mjs` + its test (+ workflow + `.gitignore`), 4 files, +3763 | its CI runs against a fake executor with no real database — it proves the tool behaves, and per ⟲OD2 it is **not** an inventory result: no (β) alias map and no (γ) backfill list exist |
| #4604 | `4be09076d` | **M0-A**: retracts the wrongly-claimed freeze-act blocker, records **A1 PASS** (build+verify at `7bf2bd7a1`, `publish_release=false`, run `30148584851`); adds the ⟲OD2-ruled loopback check to `scripts/ops/multitable-onprem-package-verify.sh` (fifth reported field) with a **negative fixture** test; M0-A status doc (905 lines) | `multitable-onprem-package-verify-loopback.test.sh` — a bundle embedding a loopback `VITE_API_URL` MUST fail (without the negative fixture the check is unfalsifiable); recorded under `verificationToolSha`, never conflated into `serviceRuntimeSha` (⟲R7) |

Nothing else attributable to this line is on `main`. In particular: **none of the B1a-2
registries/identity read (#4610), none of the B1b spike harness (#4620), no integration-guard
promotion (#4614), no B2 enforcement (#4591), and no ⟲OD3 amendment (#4619)** are on `main` as of
`4be09076d`.

---

## 2. OPEN — **TEN** in-line tickets (⟲ was nine; #4623 was missing — see §0.1), all heads from the `2026-07-26T15:27:35Z` sampling

| PR | head | base | why in line / what it waits on |
|---|---|---|---|
| **#4589** | `8471332fe` | `main` | data-source pagination contract taskbook — cites #4580 and the /select offset surface |
| **#4591** | `b52a0b030` | `main` | B2 OFFSET-ordering guard — §4 item 7, merges LAST |
| **#4593** | `15e71afe0` | `main` | B1c page-sequence execution design — §4 item 4 design ticket |
| **#4594** | `5c87f8091` | `main` | schema-probing values-free exposure inventory — the in-repo replacement for the ledger §1 NO-GO SQL |
| **#4598** | `0900c96f9` | `main` | B1 automated development & verification record — cites ledger #4590 |
| **#4610** | `c25b32ddf` | `main` | B1a-2 identity read + registries — §4 item 1 substep 1.2/1.3; gates B1a-3 |
| **#4614** | `6b01ebb53` | `main` | integration-guard required-check wiring — governance prerequisite for promotion |
| **#4619** | `467ec6b31` | `main` | ledger ⟲OD3 amendment (PROPOSED) — fixes the δ=(c) seam contradiction |
| **#4620** | `7888ee7cc` | `main` | B1b capability spike, evidence only — §4 item 2 |
| **#4623** | `568426678` | `main` | IntegrationWorkbenchView flaky fix — declared PREREQUISITE for #4614's promotion |

**Classification is exhaustive:** 134 open PRs at sampling = **10 IN_LINE** + **1** (this record, #4622) +
**123 OUT_OF_LINE**, **0 UNCLASSIFIED**. Out-of-line tickets are *classified out*, never omitted.

**#4614's row must be read with #4623:** #4614 prepares the required-check promotion but
"deliberately does not perform it" — and **a declared prerequisite for that act (#4623) is open and
unmerged**. The promotion cannot be scheduled from #4614 alone.

### 2.1 Original per-ticket detail (retained, verified content unchanged)

Heads re-derived 2026-07-26 (revision pass) via `gh pr view <n> --json headRefOid`. All nine are
**Draft** by design, all based on `main`. CI states are point-in-time at those heads; two (#4591,
#4610) had a matrix leg still `IN_PROGRESS` at capture — timestamped below rather than awaited, per
this document's own head-scoped discipline. Sorted by PR number (the original cut used a thematic
order; numeric order is what makes "nine, no more, no fewer" checkable at a glance).

| PR | head SHA | CI @ head | what it contains | gate verdict | **waiting on — exactly** |
|---|---|---|---|---|---|
| **#4589** data-source pagination contract taskbook | `8471332fe9` | 13/13 SUCCESS; merge state BEHIND | **PAUSE/PROPOSED, doc-only.** D1–D8 lock: splits safe adapter hardening (H1) from caller-contract restoration (H2); resolves every PK column through the owner-scoped facade with the same order every page; bounds no-PK objects to single-page; rejects public positive-offset-without-order as exact 400s; requires `copyData` to append the full PK as a uniqueness suffix. Records the correction to the earlier #4580 GO (#4580 is CLOSED, superseded) | Codex traced connector→read-only facade→manager→all three SQL adapters and reproduced the page-1/page-2 break on #4580’s head; confirmed `getTableInfo` is owner-gated and exposes composite PKs; confirmed Postgres/MySQL/MSSQL accept structured multi-column `orderBy`; Kimi K3 independent read-only sweep stopped without file edits. No production query, merge, deploy, or activation performed | **Owner ratification:** sign off D1–D8, then authorize H1, then H2, build-then-HOLD only. **Paused by the owner earlier** — this is why it fell out of prior status reports (§0); paused is not absent |
| **#4591** B2 enforcement | `b52a0b030b` (moved from `436dc6a1c` — pure sync-merge with `main`, zero content change, see §0) | 17/19 SUCCESS, 1 SKIPPED (`Strict E2E with Enhanced Gates`), `test (20.x)` `IN_PROGRESS` @ 2026-07-26T14:51Z; merge state **BLOCKED** (not a conflict — `mergeable: MERGEABLE`; the former **BEHIND** is RETRACTED, see §0) | exactly the owner-listed three, unchanged: OFFSET-ordering fail-fast guard (`offset > 0` without `orderBy` ⇒ fail-closed, all three SQL adapters, registry-derived roster); typed closed **422** (`DataSourceOffsetOrderingError` / `DATA_SOURCE_OFFSET_ORDERING_REQUIRED`; generic errors still 500, pinned); deletion of MSSQL’s `ORDER BY (SELECT NULL)` fallback. Observability deliberately excluded (own gate) | 16/16 conformance; mutation-verified both ways (guard-neuter reds exactly the fail-closed cases; mapping-removal reds exactly the 422 case); full unit suite green; `tsc` clean — all unaffected by the sync-merge (verified: `git diff --stat` between the old and new head shows only files newly added on `main`, none of #4591’s own adapter/guard files) | **Nothing in-ticket.** By §4 item 7 it merges **LAST**, after items 1–6 — so it waits on the *completion of the rest of the line*, then an owner merge decision. It is the only open PR whose merge changes runtime behaviour (fail-closed at page 2 on the shipped offset path), which is exactly why it is last and why migration precedes it |
| **#4593** B1c page-sequence execution design | `15e71afe04` | 13/13 SUCCESS; merge state BEHIND | **PROPOSED, design-first, doc-only** — authorizes no runtime/arming/wiring. Specifies `PageSequenceExecutionContext`, both `PAGED_READ_LEGAL_COMBINATIONS` rows and what is explicitly NOT a consistency context, per-dialect certification duties (incl. SQL Server `ALLOW_SNAPSHOT_ISOLATION`, MySQL isolation level), 12 points marked "to be confirmed by spike." Corrects the ledger's earlier wrong claim that `copyData` was "the one in-tree multi-page reader" — records that a shipped `pipeline-runner.cjs` loop pages the SQL adapter by OFFSET with no `orderBy` today; the ledger (#4590) has been amended to match | Authored by Fable 5; adversarially reviewed by Opus 5 (3 P1 / 2 P2 / 4 P3), all fixed; independently re-verified by a separate Opus 5 pass, 12/12 CLOSED, 0 regressed | **Owner decision** to open B1c's own gate (§4 item 4) — nothing to build until then; this is a design lock only, and it is what the pending ⟲OD3 amendment (#4619) would route the deferred seam + source-column translation into. **Paused by the owner earlier** (§0) |
| **#4594** data-source exposure inventory (ops tooling) | `5c87f8091c` | 14/14 SUCCESS; merge state BEHIND | Schema-probing, values-free replacement for the NO-GO ad-hoc SQL — every count query gated behind an `information_schema`-confirmed plan, `UNAVAILABLE` rather than a guess otherwise. **This is a candidate producer for §3 item 6's missing artefact, but only a partial one** — its file list is exactly the DB-count script + test + workflow; the per-deployment `/select` access-log analysis and the static `manager.select`/`adapter.select` caller enumeration the ledger also specifies are not part of this PR (see §0/§3 item 6) | Opus 5 adversarial review found 2 blocking findings (allowlist-corruption blind spot; `computeVerdict` could emit `…WITHIN_COVERAGE` with an `UNAVAILABLE` group), both fixed and re-proven; reviewer stood up a real PostgreSQL 15, ran migrations 057/060/062, and matched all 7 counts against `psql` ground truth; tests 53→89, all passing | **Owner merge decision**, then — per §3 item 6 — the **ops-authorized per-deployment run**, understanding it produces one-third of the ledger's specified inventory. **Paused by the owner earlier** (§0) |
| **#4598** B1 automated dev/verification report | `0900c96f90` | 13/13 SUCCESS; merge state BEHIND | **Doc-only** companion to the ledger; records an automated build round's review findings (B1a hash-over-lossy-projection P1; a recursive-codec regression the fix introduced; B1b SQL-Server lock-class zero coverage P1; an unpinned MySQL snapshot claim P1 — all fixed) and two self-disclosed authoring errors. Its own table cross-references **#4596** and **#4597** as "Draft" B1a/B1b PRs — **both are now CLOSED, unmerged**, superseded by #4610 and #4620 respectively (verified: `gh pr view 4596/4597` → `state: CLOSED`, not `MERGED`) | n/a — record only, no independent review round of its own | **Owner merge decision** (doc-only, no runtime behaviour changes) |
| **#4610** B1a-2 — identity read + registries | `c25b32ddf3` (moved from `09aece0d7` — folds in #4618's fix, see §0) | 12/13 SUCCESS, `test (20.x)` `IN_PROGRESS` @ 2026-07-26T14:51Z; merge state **BLOCKED** (not the previously-cited CLEAN, which was bound to the old head) | 3 **latent** modules in `plugins/plugin-integration-core/lib/`: `gip-connector-kind-registry.cjs` (β, ships **empty**), `gip-system-identity-read.cjs` (GIP-D0 §6 verbatim, decision α), `gip-canonical-object-contract-registry.cjs` (γ, ships **empty**, activation refuses caller-asserted evidence) — **plus #4618's squash-merged fix** closing the forgeable-error rethrow in `computeActivationReadiness` (see §0). Zero runtime consumers proven by grep | owner **HARD HOLD** (3 P1 + 1 P2) closed in round 5 (`8a39cb1de`); rounds 6–10 closed further P3s/retractions; **plus #4618's security fix**, merged 2026-07-26T14:37:35Z, independently converged on by Codex/Grok 4.5/Kimi K3. ⚠️ the PR **body documents rounds 1–6 only** — read the commit trail | **Owner decision:** lift the HARD HOLD and merge (or return findings) — now against `c25b32ddf3`. Nothing else blocks it (true again as of this revision — see §0 for why this needed re-checking, not assuming). Downstream: B1a-3 (steps 1.4–1.6) is explicitly held until this PR closes |
| **#4614** integration-guard required-wiring | `6b01ebb530` | 14/14 SUCCESS; CLEAN | **wiring only, not promoted**: classifier + a 27-assertion wiring-contract test inside `plugin-tests.yml`’s `test:` job so that promoting `integration-guard` to a required context later cannot false-green. 9 commits; latest fix `3994073c3` (“round 10”: load-bearing empty-`relevant` test + self-covering NUL pin, mutation-verified both directions) | three documented review rounds (r3: 1 P1 — unpinned classifier `env:` block, universal false negative — 1 P2, 3 P3, all closed) plus later commit-level rounds; body’s top section is r3 — same body-staleness caveat as #4610 | **Owner decision + admin act:** whether to add `integration-guard` to `main`’s required status-check contexts (branch-protection change). The PR itself needs only a merge decision; promotion is a separate act it deliberately does not perform |
| **#4619** ⟲OD3 ledger amendment | `467ec6b319` | 13/13 SUCCESS; CLEAN | **doc-only.** Four amendments: (1) Gate bullet 4 — core-backend statement seam removed from v1; (2) §3.2 seam ownership corrected; (3) §4 step 1.4 — seam **and** certified source-column translation removed (both travel with the SQL path, (b′)+B1c, own gate); (4) GIP-D0 §9.2 widening’s live scope narrows to the validator change alone — recorded so no item appears to vanish silently | resolves the (δ)-created contradiction: under v1=(c) the seam’s justification and consumer are both unreachable, so building it in 1.4 would land a second-package production surface with zero v1 consumers — the exact owner-P1-1 class | **Owner sign-off (ratification):** it amends RATIFIED text. Until signed, the ledger stands as amended by ⟲OD2 only, and step 1.4’s scope is formally the un-amended one |
| **#4620** B1b capability spike harness | `7888ee7cc6` | 22/23 SUCCESS, 1 SKIPPED (`Strict E2E with Enhanced Gates`); merge state **CLEAN** (the previously-cited in-progress `test (18.x)`/`test (20.x)` legs have since finished) | CI harness + probes for §4 step 2 against real, ephemeral, first-party **MySQL 8.0 + SQL Server 2019 + SQL Server 2022** service containers; 112/112 mutations; **evidence only** — mints no certification, registers no strategy, `gip-b1b-registry-unchanged.test.cjs` pins that the registry is untouched. **Its own §10 discloses four scope limits — see the new §6 entry 14, and §0/P2-1** | four review rounds including an adversarial gate review (1 P1 — vacuous CP-1 comparison — + 5 P2 harness-honesty defects), all closed; **none of the five frozen cell outcomes changed** across rounds. Full verdicts: §5 below | **Owner decision, two-fold:** (a) merge the harness; (b) the §4 **step 3** per-cell certification-opening decision, for which this PR’s output is an *input* and never the act. Opened ahead of its §4 slot deliberately (zero dependency on B1a); it does not claim B1a is done |

---

## 3. §4 RESIDUAL MAP — the seven ordered items, plus the parallel M0 track

Classification is deliberately three-valued and the distinctions are load-bearing — this line has
repeatedly confused them: **owner decision** (a ruling/sign-off/merge only the owner can give),
**ops authorization** (a privately-authorized run or deployment window), **engineering** (code
that does not exist yet).

| §4 item | status | blocked on whom / what — specifically |
|---|---|---|
| **1. B1a redo** (six substeps) | mixed — see breakdown | — |
| — 1.1 config v2 | ✅ **DONE** — merged as #4601 `cd2670695`, both enforcement points, ⟲OD2 predicate satisfied | — |
| — 1.2 identity read + β registry | 🔄 **in flight** — built in #4610 (substrate + **empty** registry) | *Owner decision:* close the #4610 hold and merge. *Ops authorization:* the concrete **(β) alias map** requires the privately-authorized real inventory run (⟲OD2: tool ≠ result); the tool (#4603) is merged, the run has not happened |
| — 1.3 canonical object contract registry | 🔄 **in flight** — built in #4610 (**empty**, activation gate refuses every caller today) | *Owner decision:* same #4610 merge. *Engineering:* no inventory scanner exists — `buildInventoryAttestation` has **zero call sites** in the shipped module (disclosed in the PR body). *Ops authorization:* the **(γ) backfill list** requires the same real inventory run |
| — 1.4 server-bound source executor | ⛔ **not started** (engineering), and its scope is in motion | *Owner decision, twice:* (a) B1a-3 is held until #4610 closes; (b) #4619/⟲OD3 — whether the core-backend seam and source-column translation leave 1.4 — is unsigned, so 1.4’s formal scope is currently ambiguous between the ratified text and the pending amendment. Starting it before ⟲OD3 is ruled would build to a contested scope |
| — 1.5 legacy `probe()` removal/privatisation | ⛔ **not started** (engineering; part of held B1a-3) | same B1a-3 hold; acceptance predicate already frozen in the ledger (exact key-set pin on the prober object, so re-addition under any name reds) |
| — 1.6 counter + handshake shape freeze | ⛔ **not started** (engineering; part of held B1a-3) | same hold; hermetic tests only, no wiring — wiring is item 5’s gate |
| **2. B1b capability spike** | 🔄 **evidence DELIVERED** — #4620 open, spike green on head `7888ee7cc` and on `4eaaca006` (run `30201271891`) | *Owner decision:* merge the harness. No engineering remains in-scope; live-customer connection was never in this step’s scope (first-party engines only) |
| **3. B1b certification** | ⛔ **not started — correctly**: it “opens ONLY if step 2 passes” and opening it **is an owner act** | *Owner decision:* the §4 step 3 gate, per dialect and per capability posture. The evidence input exists (three cells `open=true`, two refused — §5); the gate-check computed it and, by construction, opened nothing |
| **4. B1c** (cross-page snapshot/session executor) | ⛔ **not started** (design-first, own gate) | *Owner decision* to open its gate + *engineering*. If ⟲OD3 is signed, the deferred seam + source-column translation land here with (b′) |
| **5. B1-observability** (counter + handshake **wiring**) | ⛔ **not started — by ruling**: owner decision recorded, NOT opened early | *Owner decision:* its own runtime gate, later. *Engineering precondition that has no producer yet:* the **agent/protocol-version certification-scoped preflight** (hard gate before this item and before any activation/arming) is **not built** — §4 imports it from §2 M1 but schedules no producer |
| **6. Customer migration** | ⛔ **not started** | *Engineering:* the ledger's specified per-deployment inventory is a **three-part** artefact — DB counts + a per-deployment `/select` access-log analysis (stated retention window) + a static tree-wide enumeration of `manager.select`/`adapter.select` callers — and **none of the three exists on `main`** at `4be09076d` (corrected — the prior "scripts/ops/ carries only the β/γ authority-substrate inventory" was false on its face: `scripts/ops/` holds **367** top-level entries — `git ls-tree origin/main:scripts/ops \| wc -l` — including this very line's own `multitable-onprem-package-verify.sh` from #4604, blob `89ec733a41af25bee9d7f02f608fefcbefbbd9c1`; see §0/P1-3). The DB-count third has an **open, unmerged, paused** candidate producer: **#4594** (`scripts/ops/data-source-exposure-inventory.mjs`, head `5c87f8091c`) — a partial artefact, not the whole one, and not on `main` either way. *Ops authorization:* per-deployment runs incl. access-log windows, once the tooling exists. The migration decision must state the runtime blind spot explicitly (no counter until item 5) |
| **7. B2 merge (#4591)** | 🔄 code **complete**, PR open, head `b52a0b030b` (no longer BEHIND — synced with `main`, zero content change; see §0) | blocked **by construction** on items 1–6 (owner-set order), then an *owner* merge decision. No in-ticket engineering. “Log-zero alone can never green-light enforcement” stands |

**Parallel M0 track (on-prem, unblocked by all of the above):**

| phase | status | remaining |
|---|---|---|
| **M0-A** | 🔄 nearly closed: **A1 PASS** (build+verify at `7bf2bd7a1`, `publish_release=false`, run `30148584851`); loopback check **built** with negative fixture (#4604) | **A2 — the publish/freeze act — is owner-only and still open.** Owner guidance since recorded (freeze A1’s already-verified original bytes rather than rebuild) is *recorded, not executed*. Nothing else in M0-A waits on anyone |
| **M0-B** | ⛔ **ops-gated, its own authorization** | controlled deploy → flag-OFF health → bounded-config flag-OFF preflight (`SHORT_PAGE`) → one C-stage flag-ON window → 11-item PASS ⇒ closes **#4437** (verified still OPEN) as a **bounded-subset mechanism acceptance** — one tenant, one source, no large-scale capability claim |

---

## 4. THE FOUR OWNER DECISIONS AND THE THREE AMENDMENTS

### Decisions (all ruled 2026-07-25; roster = ledger §4.0)

| # | ruled | implemented where | still pending |
|---|---|---|---|
| **(α)** identity read vs credential decryption | **two materials, two rules**: identity material (principal/scope) — decrypt only inside the `credential-store` boundary, domain-separated HMAC / canonicalise immediately, discard plaintext; authentication secret — consumed inside the boundary by a connector-owned factory returning an opaque handle, never reachable from the executor, HMAC inapplicable. Neither may reach evidence, logs or errors. Rotation with unchanged principal+scope ⇒ `systemContentKey` unchanged; changed principal/scope ⇒ rebuild lineage + re-qualify | **identity half:** #4610’s `gip-system-identity-read.cjs` (unmerged) — wrapped foreign calls, plaintext discarded, rotation contract tested | **secret-factory half:** lands with step 1.4, not started; #4610 merge itself |
| **(β)** connector-kind vocabulary | first-party **CLOSED** registry; aliases mapped explicitly; unknown kind fails closed for GIP binding with `SYSTEM_IDENTITY_KIND_UNCERTIFIED`; never auto-extended from customer free strings; legacy paths keep working | #4610’s `gip-connector-kind-registry.cjs` (unmerged), ships **empty**; probe tool merged (#4603) | the **alias map itself** — waits on the ops-gated real inventory run |
| **(γ)** canonical object contract registry | first-party only; immutable registration by `contractId`+`version`, append-only; no auto-synthesis from customer config; unregistered ⇒ `CANONICAL_OBJECT_CONTRACT_UNREGISTERED`; inventory + backfill **before** activation | #4610’s `gip-canonical-object-contract-registry.cjs` (unmerged), ships **empty**, activation gate refuses caller-asserted evidence | the **backfill list** (ops-gated inventory run) and an inventory **scanner** (engineering — zero call sites today) |
| **(δ)** B-6 source-column translation scope | **v1 = (c)**: connector-owned, named, certified **HTTP probe actions only**; SQL builders stay unreachable — accepted outcome, not a gap; no SQL-shaped widening of `approved-config`, no invented source-column artefact; SQL path deferred to (b′)+B1c behind its own gate | nowhere yet — it scopes step 1.4, which is not started | #4619/⟲OD3 refines it further (seam + translation leave 1.4 entirely); unsigned |

### Amendments

| tag | what it ruled | where it stands |
|---|---|---|
| **⟲OD** (2026-07-25) | the four-decision roster above, plus the **approved narrow widening of GIP-D0 §9.2** (exactly three unlocks: config v2 validation/persistence; internal authority substrate; restricted statement seam fixture/first-party-only) — everything else still forbidden, lock wins on all contract material | **implemented in the ratified ledger text itself** — folded in before ratification at `a7c562d34`, merged as `402f04982` (#4590) |
| **⟲OD2** (2026-07-25, post-ratification) | (1) §4 step 1.1’s “flip the existing test” was a **phantom** — no such test existed on `main`; replaced by a named pre-RED/post-GREEN characterisation test + retained generic negative control; (2) the M0-A **loopback check** is closed **by building the check**, not by amending the contract away; (3) **A1 ≠ M0-A** — A1 PASS recorded, M0-A stays open pending the loopback check and the owner-only A2 act; (4) **an inventory TOOL is not an inventory RESULT** — empty registries may build now, alias map/backfill wait for the ops-gated run | **MERGED** as `551117bef` (#4609); its rulings are discharged in code by #4601 (characterisation test) and #4604 (loopback check + A1 record) |
| **⟲OD3** (proposed) | the core-backend statement seam **and** certified source-column translation leave B1a step 1.4 and travel with the SQL path ((b′)+B1c, own gate); the GIP-D0 §9.2 widening’s **live** scope narrows to the validator change alone (recorded so the three-item approval list doesn’t appear silently shortened) | **OPEN — #4619 @ `467ec6b31`, awaiting owner sign-off.** Until signed, the ratified text as amended by ⟲OD2 governs, and 1.4 formally still contains the seam |

---

## 5. B1b REAL-ENGINE EVIDENCE — CI run `30201271891`, quoted from the log

Workflow `B1b capability spike (evidence only)`, branch `claude/gip-b1b-capability-spike-20260726`
@ `4eaaca006`, conclusion `success` (verified via `gh run view 30201271891`). Jobs: MySQL 8.0
preconditions spike, SQL Server 2019 + 2022 snapshot-semantics spikes, and the gate-check —
all `success`. The gate-check job log (job `89791582848`), quoted exactly:

```
[b1b-gate-check] verdicts (EVIDENCE ONLY — this does not itself open anything):
  mysql::8.0::default  open=true  reason=MYSQL_PRECONDITIONS_PROVEN
  sqlserver::2019::default_rc_no_rcsi  open=false  reason=SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED
  sqlserver::2019::rcsi_on  open=true  reason=SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN
  sqlserver::2022::default_rc_no_rcsi  open=false  reason=SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED
  sqlserver::2022::rcsi_on  open=true  reason=SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN
[b1b-gate-check] at least one cell verdict is OPEN — §4 step 3 still requires the owner.
```

Re-verified on the PR’s **current** head `7888ee7cc` (run `30204851845`, job `89801125300`):
the five verdict lines are **identical**, so the evidence is not stale against the head an owner
would merge.

**The explicit non-claim, stated as the harness itself states it:** the gate-check **computes**
open/non-open per cell and **opens nothing**. `open=true` is an *input* to the owner’s §4 step 3
decision, never the decision; nothing in the PR, the workflow, or the gate-check writes to any
certificate or registry (pinned by `gip-b1b-registry-unchanged.test.cjs`). The three-outcome
SQL Server design ruled in the ledger is visible working live: default READ COMMITTED without
RCSI **refuses** certification (B-5’s exact failure inverted); RCSI is a **separate** capability
posture; explicit SNAPSHOT-transaction claims remain reserved to B1c and were not probed as a
single-statement capability. Everything proven is **first-party engine capability** — no customer
system was connected, and that connection remains a separately ops-gated step this run does not
touch.

**Before ruling on `mysql::8.0::default`'s `open=true`, read §6 entry 14.** The verdict above
stands, but it is a three-condition proof (`M-1 ∧ M-2 ∧ M-3`) limited to MySQL 8.0 — not the full
`M-1 ∧ M-2 ∧ M-3 ∧ M-4` battery formula, and not any other MySQL version. A reader who stops here
gets the unqualified version.

---

## 6. KNOWN RESIDUALS — carried forward (revised: three items below were re-verified or added this pass — see §0)

Behavioural residuals:

1. **`integration-guard` is not a required check on `main`.** Verified 2026-07-26 via the
   branch-protection API — the 8 required contexts are exactly:
   `contracts (strict)`, `contracts (dashboard)`, `pr-validate`, `test (20.x)`,
   `contracts (openapi)`, `web-tests`, `stock-prep PowerShell 5.1 acceptance`,
   `attendance-web-guard`. The Integration Guard workflow — which runs the full
   plugin-integration-core CJS chain (35 suites) and the integration web mirror-tripwire /
   panel / values-free specs — is therefore **advisory**: a PR can merge with those assertions
   red. #4614 is the safe-promotion wiring; the promotion itself is an undecided owner/admin act.
2. **`IntegrationWorkbenchView` FE flaky** (standing): before debugging a red web run on an
   unrelated diff, first prove the diff does not touch `apps/web`, then rerun.
3. **#4614’s own disclosed residual:** `continue-on-error` on the wiring-contract **step itself**
   inside `plugin-tests.yml`’s `test:` job cannot be pinned by the contract (a contract cannot
   assert a property of the step that runs it). ~15 sibling `*-ci-wiring.test.mjs` steps in the
   same shared job carry the same latent property.
4. **#4610’s disclosed residuals (re-verified at the current head `c25b32ddf3`, moved from
   `09aece0d7` — see §0):** `buildInventoryAttestation` has **zero call sites** — `git grep -n
   buildInventoryAttestation c25b32ddf3` shows only its own definition and comments describing the
   absence, confirming this is still true after #4618's fix folded in; no real inventory scanner
   exists, so the γ activation gate refuses every caller today (fail-closed, but also unusable
   until the scanner is built); the package’s aggregate 105-script `npm test` chain was not
   runnable in the review worktree (pre-existing environmental failure, reproduced against the
   unmodified branch tip) — per-file `node` runs and CI stand in for it.
5. **#4591’s pinned KNOWN LIMIT:** a limit-only **first page** with no `orderBy` stays legal —
   the guard fires from `offset > 0`; the first-page ordering contract closes in B1a+
   (`orderingKeySpec` from the approved config version), not in B2.
6. **The shipped live OFFSET reader is still live on `main`:** `pipeline-runner.cjs` pages the
   `data-source:sql-readonly` adapter’s non-watermark branch by OFFSET with no `orderBy` —
   *exercised by shipped pipeline code, not merely reachable* — and stays that way until
   migration (§4 item 6) and then B2 (#4591) land. When B2 merges, that path fails closed at
   page 2; migration therefore precedes enforcement.
7. **Ledger §1 P3 (no dedicated PR):** one freeze negative control in the A5 conformance suite
   keeps a literal six-type anchor; convert to a comment-marked deliberate anchor at next touch.
8. **M1 runtime blind spot, by ruling:** with B1-observability closed, caller inventory rests on
   DB inventory + per-deployment access logs (window-scoped) + static enumeration; the runtime
   counter arrives only in its §4 slot. Any migration decision must state this residual, not
   gloss it.
9. **#4565’s head `828aeb4d6` must never merge** (pre-hardening fail-open; PR closed unmerged).
10. **No arming gate exists or is scoped** for any GIP profile or for the B1a substrate; the
    agent/protocol-version certification-scoped preflight — the hard gate before any
    activation/arming/runtime wiring — is **unbuilt** (see §3 item 5).

Claim-level residuals (honest even though no behaviour is wrong):

11. **PR bodies trail their commit histories.** #4610’s body documents review rounds 1–6 while
    its commits carry rounds 7–10 (incl. two retraction commits); #4614’s body tops out at its
    “round 3” section while its newest fix commit is labelled round 10. The commit trail, not
    the body, is the record of record for both.
12. **Every verdict here is head-scoped.** The B1b verdicts were re-verified at `7888ee7cc`; the
    CI states in §2 were captured at the listed heads (#4620 had two `test` matrix legs still
    running at capture). Re-derive before acting; do not cite this record as a substitute for
    `gh pr view --json headRefOid`.
13. **RETRACTED — #4591 is no longer BEHIND `main`.** This residual previously read "#4591 is
    BEHIND `main` and will need a refresh (strict required checks) at merge time." That refresh has
    already happened: #4591's head moved `436dc6a1c` → `b52a0b030b` via a content-free sync-merge
    (verified in §0) and `mergeStateStatus` now reads `BLOCKED`, not `BEHIND`. Recorded here rather
    than silently deleted, per this document's own retraction-first rule.
14. **#4620's own disclosed residuals (§10 of its PR body), added this pass — see §0/P2-1:**
    (i) the MySQL matrix declares exactly **8.0**; 5.7 and 8.4 are left open, and the isolation
    variable name is resolved from the declared version with no try-both; (ii) **M-4 is
    implemented and mutation-instrumented (CP-5's three controls all passed in CI) but kept
    non-load-bearing** — `MYSQL_PRECONDITIONS_PROVEN` is `M-1 ∧ M-2 ∧ M-3` only, matching the
    battery's own `(∧ M-4 if ratified)` and M-4's not-yet-ratified status; (iii) outcome-token
    naming is used verbatim from the battery §3; (iv) the workflow ships both `workflow_dispatch`
    and a path-filtered `pull_request` trigger and was **not** added to required checks — no
    branch-protection change was made or attempted. Net: the §5 `mysql::8.0::default open=true`
    verdict stands, but as a three-condition proof limited to one MySQL version — the owner is
    entitled to that qualification before ruling on §4 step 3.

---

## 7. WHAT “DONE” MEANS — stated plainly

**备料 (stock-prep): the development face of this line is closed.** There is no open stock-prep
code ticket on this line — every stock-prep engineering deliverable the line scheduled is merged,
and A1 (build + verify at `7bf2bd7a1`, run `30148584851`) is a recorded PASS with the loopback
check built and negatively-fixtured. What remains for 备料 is **not engineering**: the **A2
publish/freeze act (owner-only)** and the **M0-B ops window** (deploy → flag-OFF health →
`SHORT_PAGE` preflight → one flag-ON window → 11-item PASS), which is what finally closes issue
**#4437** — and closes it as a *bounded-subset mechanism acceptance*, one tenant, one source,
claiming no large-scale capability.

**GIP substrate: everything lands LATENT, and LATENT means it delivers nothing.** The landed
profile (`bridge.bounded_read.v2`) has zero runtime consumers; the B1a-2 registries ship
**empty** with zero runtime consumers and are not even merged; the B1b evidence certifies
nothing and its gate-check opens nothing; B1-observability is unwired by ruling. No user, tenant,
or integration behaves differently because of any of it, and none of it will deliver anything
until an **arming/activation gate that has never been scoped** — it appears in the ledger only as
a fence (“STILL FORBIDDEN — each its own later gate”), with the unbuilt agent/protocol-version
preflight as its hard precondition. Anyone reading this line as “integration capability
shipped” is misreading it: what shipped is **authority substrate + refusal machinery + evidence**,
deliberately inert. The single open PR whose merge changes runtime behaviour is #4591’s
fail-closed guard, and it is sequenced last precisely because it is the one that does.

That is the honest shape of the line at this snapshot — not a closeout: **the stock-prep face is
finished and waits on two
non-engineering acts; the GIP face is a fully-fenced latent substrate whose first user-visible
consequence has not yet been authorized, scoped, or scheduled.**

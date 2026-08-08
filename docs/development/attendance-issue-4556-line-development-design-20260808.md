# Attendance issue 4556 — line-level development design

> Status: **DESCRIPTIVE / PROPOSED — ratifies nothing**
>
> Date: 2026-08-08
>
> Pinned baseline: `origin/main@a45e1416002e6ca500eeda8d70e86c6443a10700`
> ("feat(directory): harden deprovision evidence ledger (#4646)", 2026-08-08 11:44:26 +0800)
>
> Live-state snapshot (PR states, check rollups, GitHub comment threads): **read 2026-08-08, second
> pass**, after `git fetch origin --prune`. PR mergeability and check state drift between reads; every
> such value below carries its head SHA and is stated as-of this snapshot, not as a standing fact.
>
> **The pinned baseline is deliberately not re-pinned, and `main` has since advanced.** At the
> second-pass read `git rev-parse origin/main` returned `bea44e12d5af45e9131d4f12ce7f0a6d2d2ffc9a`
> ("docs(approval): stamp PR 4806 merge closeout on canvas final-eligibility MDs (#4811)") — two
> commits ahead of the pinned baseline, neither on this line. Every blob citation below remains
> scoped to `a45e1416…`. Under branch protection `strict=true`, every open PR named below is
> therefore BEHIND again relative to current `main`, and a check-run rollup is **not** pinned by a
> SHA: check runs are re-runnable and mutable, so rollup counts are point-in-time observations, not
> properties of the commit.
>
> Scope: the whole of attendance issue 4556 (parent design lock §9 phases W0–W8), plus the two
> adjacent lines it consumes (issue 4709 fixed-schedule effectiveness / FSER, issue 4711 group
> context routes) and the deferred debt parked against it.

---

## Landing delta — historical baseline vs. current live state

> **Read this before anything below it.** The body of this document is a **historical baseline
> record**: it was verified against one pinned `main` SHA and a set of PR heads that were live at the
> time of writing. `main` and those PRs have moved since. This section separates the two so that a
> pinned PR head in the body is never read as the current live state.
>
> This section changes no verdict, count, or citation in the body. Nothing below it was rewritten to
> match the live state — preserving the pinned body *is* the point.

### A. Historical baseline — what the body is pinned to

| Item | Value |
| --- | --- |
| Pinned `main` | `a45e1416002e6ca500eeda8d70e86c6443a10700` — `feat(directory): harden deprovision evidence ledger (#4646)`, **2026-08-08 03:44:26 UTC** |
| Second-pass `main` observed while writing the body | `bea44e12d5af45e9131d4f12ce7f0a6d2d2ffc9a` — `docs(approval): stamp PR 4806 merge closeout on canvas final-eligibility MDs (#4811)`, **2026-08-08 04:46:01 UTC** |
| Scope of the pin | Every blob citation, `file:line` reference, ancestry verdict and mechanically-derived count in the body is scoped to `a45e1416…` and is **stated as of that SHA**. |
| Deliberately **not** SHA-pinned, by the body's own caveat | Check-run rollups and `mergeStateStatus`. Both are mutable and lazily recomputed; they are point-in-time observations, never properties of a commit. |
| Consequence | **Body citations are pinned to the baseline and may be superseded.** Where the live state below disagrees with the body, the live state is current and the body is the historical record — neither is an erratum against the other. |

### B. Current live state, re-read at landing

All values in §B were re-read from `git`/`gh` at landing on **2026-08-08, ~08:57 UTC**. The exact
commands are listed in §D. Nothing in §B is taken from the body's prose or from any PR body.

**This section is itself a point-in-time read, and it demonstrates its own caveat.** `main` advanced
once *during* this landing work — an earlier pass of §B pinned `a06ce31928293541995b00da57c75e9f40dad0f2`
and every figure was re-derived against `60659ddc3b…` after the rebase. The same drift will make §B
stale in turn; the correct response to a disagreement between §B and a fresh `gh` read is to trust
the fresh read, exactly as §A says for the body.

#### B.1 `main` and the merge gate

| Item | Value at landing |
| --- | --- |
| `origin/main` | `60659ddc3bb3042a8c2191f6468fe27a46a29bfa` — `feat(approval): a11y labels on ApprovalCanvasNodeInspector topology (#4819)`, **2026-08-08 08:56:06 UTC** |
| Distance from the pinned baseline | **14 commits** ahead of `a45e1416…`; **12 commits** ahead of the second-pass `bea44e12d5…` |
| Required status checks on `main` | **9 contexts**, `strict=true` — `contracts (strict)`, `contracts (dashboard)`, `pr-validate`, `test (20.x)`, `contracts (openapi)`, `web-tests`, `stock-prep PowerShell 5.1 acceptance`, `attendance-web-guard`, `integration-guard` (re-read from the branch-protection API at landing; this list has grown historically, so it is read, not recalled) |

#### B.2 Every open PR this document references, plus the two that did not exist at the baseline

`mergeStateStatus` (`mss`) is a **read-time** value, not a property of the head SHA — repeated reads
of the same head returned different values during this work. Each row states the value observed at
landing.

| PR | Head pinned in the body | Head at landing | State | `mss` at landing | Delta vs. the body |
| --- | --- | --- | --- | --- | --- |
| **4804** — W7/W8 design-lock drafts (docs-only) | `a1344c77c09725b757b5e9408b501e433bc3d385` | `a1344c77c09725b757b5e9408b501e433bc3d385` | OPEN, **Draft** | `BEHIND` | **No change.** Head identical; still Draft/HOLD. |
| **4805** — OBS-1 orphan-suite wiring + derived completeness guard | `40dfd4f3fb8bfaa987e2706c399e5e41a3b29451` | **`2985e03c078ae45f9f59f3da58b073fdecab4449`** | OPEN, ready-for-review | **`DIRTY`** | **Head superseded, and the PR now conflicts with `main`.** See §C.2 — this is the largest delta in this section. |
| **4810** — FSER-4 §3–4 frontend surface wiring | `4ca537c66bb00bede251cbabdcbdc7e730ec60f9` | `4ca537c66bb00bede251cbabdcbdc7e730ec60f9` | OPEN, **Draft** | `BEHIND` | **No change.** Head identical; still Draft/HOLD. `BEHIND` is base drift under `strict=true`, which a rebase clears; it is not `BLOCKED`. |
| **4813** — *this PR* (the two line-level MDs) | — | the commit carrying this section | OPEN, **Draft** | — | The body remains pinned to `a45e1416…`; only this section is re-read at landing. A PR's own head cannot be stated inside itself — committing this section changes it. |
| **4814** — W6-1 group effective-policy READ aggregate backend | **not referenced by the body** | `4cc0122883846900a1325cdacd5eda0355d77215` | OPEN, **Draft** | `BEHIND` | **New since the baseline.** Did not exist when the body was written. See §C.1. |
| **4821** — W6 lock durable RATIFY record (docs-only) | **not referenced by the body** | `a80ee9ba9c71e234d8b2c801d862d3a568d3eada` | OPEN, ready-for-review | `BLOCKED` | **New since the baseline.** Did not exist when the body was written. See §C.1. At the landing read its rollup had 3 contexts still `IN_PROGRESS` (`web-tests`, `test (18.x)`, `test (20.x)`); no command was run that attributes the `BLOCKED` value to a cause, so none is asserted. |
| **4745** — Windows-native exact-SHA QA v2 | `043851d3db7bb8d4b4514af3b1354265f9b2cdf3` | `043851d3db7bb8d4b4514af3b1354265f9b2cdf3` | OPEN, **Draft** | `BEHIND` | **Head unchanged.** The body's "16/16 check runs `success`" was read at an earlier pass on this head and was not re-executed at landing. |
| **4634** — Windows-native internal QA package | `66a980357078f9d243fd4b025b080ac9aca9fa21` | `66a980357078f9d243fd4b025b080ac9aca9fa21` | OPEN, **Draft** | `CLEAN` | **Head unchanged.** Base re-read at landing: `codex/attendance-onprem-package-workspace-deps-20260727` — i.e. PR 4630's branch, **not** `main`, so `CLEAN` here does not mean the 9 required contexts ran. |
| **4630** — on-prem package workspace runtime dep | (body states `DIRTY`, base = PR 4612's abandoned branch) | `7d8ba0d1d1deddfb47fd2cea5e00773b8e13d034` | OPEN, **Draft** | `DIRTY` | **No change.** Base re-read at landing: `claude/w4c2-live-scheduled-shadow-20260725`. |
| branch `claude/attendance-windows-qa-v2-0dc3596dd-20260806` (no PR) | `7e531be6d6c85e61709661a7d59db8fc975daf58` | `7e531be6d6c85e61709661a7d59db8fc975daf58` | **still no PR in any state** | — | **No change.** Re-confirmed by a `gh pr list --state all --head …` that returned zero rows. |

**Merged or closed since the baseline: none of the above.** Every PR the body inventoried as open
was still open at landing; no PR the body named as in-flight has merged or closed.

#### B.3 Every issue this document references

| Issue | State at landing | Comments | Last updated | Delta vs. the body |
| --- | --- | --- | --- | --- |
| **4556** — parent attendance line | OPEN | 18 | 2026-08-05T08:27:37Z | No change. |
| **4629** — W4C-2 Internal Preview QA feedback | OPEN | 15 | 2026-08-05T08:27:18Z | No change. |
| **4709** — derived fixed-schedule effectiveness (FSER) | OPEN | 1 | 2026-08-01T07:30:40Z | No change. |
| **4711** — preserve group context across navigation | OPEN | 1 | 2026-08-01T08:05:08Z | No change. |
| **4770** — sweep fairness / observability | OPEN | 0 | 2026-08-05T08:52:20Z | No change; still zero comments, so still no closure statement. |
| **4775** — W4C-5 §3 request-snapshot 8-cell set | OPEN | 0 | 2026-08-05T15:01:43Z | No change; still zero comments. |
| **4791** — 57P01 scratch-DB teardown race | **CLOSED / completed** | 3 | 2026-08-07T15:44:55Z | No change; matches the body. |
| **4792** — malformed `bpmn:timeCycle` residue | OPEN | 0 | 2026-08-06T09:02:37Z | No change; still unfixed and unowned. |
| **4802** — 7 K3-line ops suites never executed | **CLOSED / completed** | 3 | 2026-08-07T16:12:28Z | No change; matches the body. |
| **4822** — unify `rootDir`/`outDir`, package `main`/`types`, Docker `CMD` | OPEN | 0 | 2026-08-08T08:47:17Z | **New since the baseline** — not referenced by the body. See §C.4. |

### C. What changed between the two — the deltas that matter to a reader deciding what to do next

#### C.1 W6 now has a ratification-anchor PR — and it is **not merged**, so `main` is unchanged

Two PRs on the W6 phase were created after this PR was opened (`createdAt` read from `gh`: this PR
2026-08-08T05:40:27Z; PR 4814 2026-08-08T06:22:44Z; PR 4821 2026-08-08T08:46:37Z), which is why the
body references neither:

- **PR 4821** (OPEN, ready-for-review, head `a80ee9ba9c71…`, `mss=BLOCKED`) is docs-only: a single
  file, `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`,
  **+45 / −10**. It *proposes* transcribing an owner RATIFY of the W6 lock into that lock's §9.
- **PR 4814** (OPEN, head `4cc012288384…`, `mss=BEHIND`, 16 files) is the W6-1 group
  effective-policy READ aggregate backend slice — the runtime work that the ratification would
  authorize. Mechanically, `gh` reports `isDraft=true` and its title begins `[HOLD]`. That it is held
  **specifically pending PR 4821** is read from **PR 4821's own body**, which describes PR 4814 as
  open against an unratified lock; that dependency is therefore reported here as a PR-body claim, not
  as something this section independently derived.

**PR 4821 is unmerged, therefore `main` is unchanged.** Re-read at landing, the W6 design lock on
`origin/main` still carries `Status: **PROPOSED / runtime HOLD**`. The body's statement that
`OD-W6-0` and `OD-W6-1..9` are OPEN and that **W6-GATE is open** therefore **remains true of `main`
at landing**, and no statement in the body about W6 is superseded.

What a reader must not do with this row: PR 4821's body asserts an owner ruling, but *a PR body is
not the authorization* — that is precisely the self-authorization loop PR 4821 exists to break, and
its own body says so ("Merging this PR is the durable anchor"). This section records that the
proposal **exists and is pending**; it does not record that W6 is ratified, and nothing here should
be cited as evidence that it is. Whether the ruling is correctly transcribed is a review question on
PR 4821, and merging it is a separate owner act.

#### C.2 PR 4805's head is superseded **and it now conflicts with `main`**

The body pins PR 4805 at head `40dfd4f3fb8bfaa987e2706c399e5e41a3b29451` and reports a green check
rollup at that head. At landing the head is `2985e03c078ae45f9f59f3da58b073fdecab4449`, with
`mergeable=CONFLICTING` and `mergeStateStatus=DIRTY`.

This differs in kind from the `BEHIND` rows elsewhere in §B.2. `BEHIND` is base drift under
`strict=true` and a rebase clears it. **`CONFLICTING`/`DIRTY` is a merge conflict against `main` and
needs a conflict resolution, not a rebase-and-rerun.** The `mergeable` field is the load-bearing one
here: an intermediate read of the same head returned `mergeStateStatus=UNKNOWN` (GitHub had not yet
recomputed it) before a later read returned `CONFLICTING`/`DIRTY` — a live demonstration of why this
section labels `mss` a read-time value rather than a property of the SHA.

A reader planning the OBS-1 landing should also treat the body's green rollup for PR 4805 as
belonging to a **superseded head**. The rollup at the new head, read at landing, was 24 `SUCCESS` +
1 `SKIPPED` (`Strict E2E with Enhanced Gates`) — but a rollup is not pinned by a SHA, and a green
rollup does not clear a merge conflict.

#### C.3 Three files cited by the body changed on `main` — and **six of the body's seven `plugin-tests.yml` line citations are now off by +2 or +5**

Method: 55 distinct repository paths were extracted from the two documents by regex, then intersected
with `git diff --name-only a45e1416… 60659ddc3b…`. (The regex captures paths of the common source
extensions; it is not a proof that every citation form in the documents was enumerated.) Three cited
paths appear in that diff:

| Cited path | Change between baseline and current `main` | Effect on the body |
| --- | --- | --- |
| `.github/workflows/plugin-tests.yml` | **+5 / −0**, inserted in two hunks (after baseline line 103 → +2 lines; after baseline line 1100 → +3 more). File grew 1476 → 1481 lines. Landed by `882c292906` and `26d4be3e04`, both **directory/D4 work, not this line**. | **Six of the body's seven line-pinned citations moved; one did not.** The seven were enumerated by `grep -ohE 'plugin-tests\.yml:[0-9]+(-[0-9]+)?'` over both files (7 distinct refs, 10 occurrences), then each checked for content identity at both SHAs: **`:3-18` is unchanged (offset +0)** — it sits inside the 1–103 prefix, verified byte-identical at both SHAs, so it resolves at current `main` as well; `:223-224` and `:585` shift **+2** (→ `:225-226`, `:587`); `:1201`, `:1249-1250`, `:1265` and `:1305` shift **+5** (→ `:1206`, `:1254-1255`, `:1270`, `:1310`). The *content* every citation names is unchanged at both SHAs — only the line numbers moved. |
| `packages/core-backend/vitest.config.ts` | **+12 / −0**: three `directory-*` real-DB exclusions added at baseline line 234. | **No effect.** The body makes no line-pinned citation to this file. |
| `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` | Changed. | **No effect on any line citation.** The body makes no line-pinned citation to this file. |

Five attendance test files also changed on `main` (`attendance-w4pre1c-departure-org-scoped`,
`…-departure-permission-negative`, `…-departure-sweep-deprovision`, `…-manual-review-pending`,
`attendance-w4pre1d-departure-candidate-split`, all `.db.test.ts`). **None of the five is cited by
either document** (verified: zero occurrences of each filename in both files), and they are W4-pre
departure/deprovision files carried by the directory D4 work, not W4C/W5/W6 files. The body's
real-DB corpus count is unaffected: attendance `*.db.test.ts` under `packages/core-backend/tests`
counted **73 at the pinned baseline and 73 at current `main`**.

#### C.4 One new issue exists that the body does not reference

**Issue 4822** (OPEN, 0 comments, 2026-08-08T08:47:17Z) — "repo: unify `rootDir`/`outDir` + package
`main`/`types` + Docker `CMD`, and make `docker-build` actually boot the built backend". It is
recorded here for completeness because it postdates the baseline. Its relationship to this line, if
any, is **not assessed** by this document — no command was run that establishes one.

#### C.5 Summary for a reader deciding what to do next

1. **Nothing merged or closed** among the PRs the body inventoried; the in-flight picture is intact.
2. **W6 moved on paper only.** A ratification anchor (PR 4821) and the runtime slice it would unblock
   (PR 4814, Draft/HOLD) both exist and are both unmerged. `main` still reads PROPOSED / OPEN, so
   every W6 statement in the body stands.
3. **PR 4805 is `CONFLICTING` against `main`** — a conflict-resolution shape, not a rebase-and-rerun
   shape. It is the one row whose remediation shape changed.
4. **Six of the seven `plugin-tests.yml` line citations need +2 or +5** if you resolve them against
   current `main` instead of the pinned baseline; `:3-18` needs no adjustment. Everything they name
   is otherwise unchanged at both SHAs.
5. Every other pinned head in the body is byte-identical to the live head at landing.

### D. Commands run to produce §B and §C

Every state claim in §B and §C came from one of these. None was taken from either document's prose.
The **single** claim sourced from a PR body is the PR 4814 → PR 4821 dependency in §C.1, and it is
labelled as such at the point of use; every other value is a `git`/`gh` field or a command output.

```
git fetch origin --prune
git ls-remote origin refs/heads/main refs/heads/claude/attendance-windows-qa-v2-0dc3596dd-20260806
git log -1 --format='%H%x09%cI%x09%s' <each of a45e1416… bea44e12d5… 60659ddc3b…>
git rev-list --count a45e1416…..origin/main          # 14
git rev-list --count bea44e12d5…..origin/main        # 12
git diff --name-only a45e1416… 60659ddc3b…           # 69 paths; intersected with the cited-path set
git diff --numstat  a45e1416… 60659ddc3b… -- .github/workflows/plugin-tests.yml packages/core-backend/vitest.config.ts
git diff -U0        a45e1416… 60659ddc3b… -- .github/workflows/plugin-tests.yml   # hunk offsets
git show <sha>:.github/workflows/plugin-tests.yml | sed -n '<L>p'                # per-citation content identity
git ls-tree -r --name-only <sha> -- packages/core-backend/tests | grep -cE 'attendance.*\.db\.test\.ts$'
git show origin/main:docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
gh api repos/zensgit/metasheet2/branches/main/protection
gh pr view <N> --json number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,files,statusCheckRollup
gh pr list --state all --head claude/attendance-windows-qa-v2-0dc3596dd-20260806
gh api repos/zensgit/metasheet2/issues/<N>           # state, state_reason, comments, updated_at
```

---

## 0. Purpose, authority, and what this document is NOT

### 0.1 Purpose

This is a **line-level development design**: one document that states, against a single pinned
`main` SHA, (a) what has actually landed on the issue-4556 line and where it lives in the tree,
(b) the architecture those landings add up to, (c) the governance machinery the line runs on,
(d) the ordered remaining development with per-item scope / blocking condition / acceptance bar /
model tier, and (e) the open owner decisions collected so the owner can rule on all of them in one
pass.

It exists because the line's authoritative knowledge is currently spread across one parent design
lock, one W4 lock, three amendments, two unmerged W7/W8 lock drafts, one runbook, several
verification MDs, and a set of GitHub comment relays. No single artifact answers "where is this
line and what is next".

### 0.2 Authority — what this document has

**None.** Its statements are *descriptions of other artifacts' authority*, not authority. Where it
reports a phase as authorized, the authority is the cited lock section or the cited owner relay
comment, never this file.

### 0.3 What this document is NOT

This document does **not**:

- ratify anything — not the W6 lock, not the W7/W8 lock drafts, not any amendment;
- authorize any runtime slice, in any phase;
- authorize the merge of any pull request, including the ones it inventories as in-flight;
- authorize staging access, a staging transition, or the W4C-5 seven-day synthetic soak;
- authorize a flag change, a rollout-state transition, a deployment, or a production migration;
- authorize production or customer-data use, an external notification, a release claim, or a
  customer-UAT claim;
- close, or supply grounds for closing, issue 4556. Closure is an owner ruling governed by parent
  lock §10 and W4 lock §14 item 10; no gate, matrix, or empty ledger triggers it.

### 0.4 Reading rules used throughout

| Marker | Meaning |
| --- | --- |
| **verified** | Re-derived from a blob, command, or API read at the pinned SHA / snapshot time, with the command named in §7. |
| **unverified** | Stated by a document, PR body, or third party and not independently re-derived here. Never restated as fact. |
| *doc-header-derived* | Authorization status read from an in-repo `Status:` header. Per this line's own recorded failure mode (§3.4), an in-repo header is **not** an owner authorization. |
| *relay-derived* | Authorization status read from an owner decision relay comment on GitHub. |

Absolute quantifiers ("all", "every", "exactly N", "zero") appear only where a mechanical command
produced the count; the command is named at the point of use or in §7.

---

## 1. The line at a glance

### 1.1 Phase map (parent lock §9)

The canonical phase map is `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`
§9.1–§9.9 (headings at lines 645, 663, 675, 687, 707, 719, 731, 743, 755).

| Phase | Parent §  | Title | Status | Landed as (PR → squash SHA) |
| --- | --- | --- | --- | --- |
| W0 | 9.1 | Contract parity | landed | PR 4558 → `077fde47859c561a13f820fb8ccc285a2ed5c58f`; PR 4560 → `9f989396b765dac7ef87dfd0e689a69e5be8bec8` (both confirmed ancestors of the pinned main by `git log` enumeration; the two-witness API check applied to W1–W6 was **not** run on these two — see §1.4) |
| W1 | 9.2 | Effective group membership | landed | PR 4563 → `9055932e314265794b3baa8e80cff0828ba2902c`; follow-ups PR 4586 → `c81b3bc39202fe347d18ab58520671af3c706def`, record PR 4566 → `dca8d946160bd1a001e4ccc767a199125c024fef` |
| W2 | 9.3 | Shared work-date resolver | landed | PR 4567 → `f1e390977e57dc1239e312c7423f3cda2d1f055f` |
| W3 | 9.4 | Segment schema and authoring | landed (authoring only; authoritative segment calculation deliberately excluded) | backend PR 4569 → `c5f08aecd5732d70b616561398d8456240f62486`; frontend PR 4570 → `ee8e586f74a69ae03102a93abd39bfc659e1e7be`; contract PR 4568 → `d6fa5d19b7a3a4fda86161dcaf9d1ff61e11c65b`; hardening PR 4584 → `78b4133bac153ba39a3dff682d137bfdc26ae947`; record PR 4571 → `6c5ca571bec2ec73d3f8e0531ca1601a76a5db2c` |
| W4 | 9.5 | Segment calculation and snapshots | code landed across six slices (W4C-0…W4C-5); **enablement not landed** | see §1.2 |
| W5 | 9.6 | Flexible single-segment mode | landed | PR 4748 → `7da5d9e55b0f7c9b0a6ca471d38c3aa0115037ab` |
| W6 | 9.7 | Group effective-policy workspace | **preparation landed; runtime blocked on owner** | prep PR 4771 → `2967da018ceea41b91098e14d4c15a57236eb5f8` |
| W7 | 9.8 | Group policy calculation cutover | **not started**; design-lock draft exists only on an unmerged branch | draft in PR 4804 (open, Draft/HOLD) |
| W8 | 9.9 | Verification and closeout | **not started**; plan draft exists only on an unmerged branch | draft in PR 4804 (open, Draft/HOLD) |

A tree-wide search for issue-4556 W7/W8 artifacts at the pinned SHA returns only
`docs/development/w7-cross-base-resultwriteback-design-lock-20260703.md` and
`w7-resultwriteback-ui-design-lock-20260629.md`, which belong to the multitable cross-base
result-writeback line, not to attendance (verified).

### 1.2 W4 slice map

| Slice | Status | PR → squash SHA | Principal modules introduced |
| --- | --- | --- | --- |
| W4 lock + RATIFY | landed | PR 4588 → `a3e5765727ca608e8c49c7a44a025e6e4aae5d40`; ratification record PR 4592 → `d6ac495b947c0b42ed7bee66d9531fbe25a486ca` | `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md` |
| W4C-0 contracts + durable storage | landed | PR 4606 → `d4dc12d8a8cde38c8f04f1952b3ba0b8b317265f` (14,960 insertions) | 7 × `packages/core-backend/src/attendance/w4c0-*.ts`; migration `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts`; `scripts/attendance/w4c0-dml-inventory/` |
| W4C-1 pure calculator | landed | PR 4607 → `aebac4f8bef344b3ff3443ee045439c789a569a1` (8 files, 3,617 insertions, 0 deletions) | 4 × `w4c1-*.ts` |
| W4C-2 live + scheduled shadow | runtime **is on main**, but under PR 4670 → `5ae2cea0b2a84f0d36319f79c38ae2e796b5d20a`, not under the nominal PR 4612 (closed unmerged, title `⛔ OWNER-AUTHORIZATION-HOLD … DO NOT MERGE`) | 6 × `w4c2-*.ts`; migration `zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts`; follow-ups PR 4774 → `523d254b8ad4ea19bb3088aac566d39429074c3d`, PR 4779 → `2927a71fafd68dcb4896d1909c31f02ad710131f` |
| W4C-3a import + rollback | landed | PR 4688 → `9ce340e0f7939f1c1d786acc7eb99bd865a6fac5` (97 files, 44,814 insertions) | 18 × `w4c3a-*.ts` |
| W4C-3b approval + writer cutover | landed | PR 4716 → `ce7ffe8ce8eecae11f0ea497093fdcce2046888e` (12,958 insertions); precursor PR 4714 → `f4444e15e7a53e1381f1ef344c8f98c17327a116` | 4 × `w4c3b-*.ts`; `AttendanceLegacyMembershipOverlapAudit.ts` |
| W4C-3c zero-bypass cutover | landed | PR 4718 → `2d2b9eeccab22d77adf7f5b9c803dcf45afb4fdd` (11,300 insertions) | 6 × `w4c3c-*.ts`; `scripts/attendance/execute-ops-retirement-cleanup.cjs` |
| W4C-4 calculation detail + shadow ledger | landed | PR 4721 → `5edc118d5b7d895f5131818ece7bb3eb34796607` | `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts` (834 lines) |
| W4C-5 transition-boundary hardening | **code hardening landed; the named seven-day synthetic soak has no execution record** | PR 4773 → `3601817969affd06d8eed9ee8f359b6195b774b4`; PR 4780 → `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b`; prep docs PR 4747 → `2a2a5eee4f00abceff94ed6360e8c051708e35f7` | **no new source modules** — both PRs amend existing `w4c3a-rollout-control.ts` / `w4c3b-request-snapshots.ts` / `w4c0-identity.ts`. Each PR did add exactly one new **unit** suite under `src/attendance/__tests__/` (`w4c3a-rollout-control-inventory.test.ts`, `w4c3b-request-snapshot-metadata-fields.test.ts`) — see the correction below the table |

**Correction to an earlier statement of this row.** An earlier draft said the `--diff-filter=A`
sweep listed both W4C-5 commits "with no files beneath them". Run literally, it does not: at
`origin/main`, `git log -1 --diff-filter=A --name-only 3601817969…` returns
`packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts` (+251), and
the same command on `0dc3596ddb…` returns
`packages/core-backend/src/attendance/__tests__/w4c3b-request-snapshot-metadata-fields.test.ts`
(+141). Both commits are single-parent (`git rev-list --parents -n1` prints two fields each), so no
merge-commit suppression applies. **Each W4C-5 commit added exactly one file, and both are under
`packages/core-backend/src/attendance/__tests__/`.**

The surviving conclusion is narrower than the one withdrawn, and is re-derived from a pathspec that
excludes test paths rather than from an unscoped sweep: **W4C-5 introduced zero new *source*
modules.** Command:
`git show --diff-filter=A --name-only --format='' <sha> -- 'packages/core-backend/src' ':(exclude)packages/core-backend/src/**/__tests__/**'`
returns empty for both commits (verified). What W4C-5 added is two new **unit** suites, which the
verification record inventories with their evidence class.

Reporting W4C-5 as "landed" therefore means **the transition-boundary hardening code landed**; the
soak that gives the slice its name did not run, or left no in-repo evidence found at this SHA.

### 1.3 In-flight, as of the 2026-08-08 snapshot

**Read discipline for this table.** Head SHA, draft flag and merge state are *point-in-time*, read
on the 2026-08-08 second pass. A head SHA does not pin them: a rebase replaces the head, and
`mergeStateStatus` moves whenever `main` advances. `BEHIND` and `BLOCKED` are **different states and
are not interchangeable** — `BEHIND` means the base moved under `strict=true` and a rebase clears it;
`BLOCKED` means a gate or review requirement is unsatisfied. Where either value is used below as a
*blocking condition* rather than as a datum, that distinction is stated explicitly.

| PR | Head SHA (read 2026-08-08, 2nd pass) | Draft | Merge state (point-in-time) | Delivers | Line |
| --- | --- | --- | --- | --- | --- |
| PR 4805 | `1448615c5aaf27e70c3dd3f1b20400c8661b362d` | no | `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`. **Superseded reading:** an earlier pass recorded head `40dfd4f3fb8bfaa987e2706c399e5e41a3b29451` as DIRTY/CONFLICTING on `s6a-package-provenance-pins.json`; the branch has since moved | OBS-1: wires the two orphan W4C-3b real-DB suites into both CI points; converts `scripts/ops/attendance-w4c2-ci-wiring.test.mjs` from a 33-entry handwritten allowlist to a tree-derived corpus | 4556 (W4C-3b test wiring) |
| PR 4804 | `a1344c77c09725b757b5e9408b501e433bc3d385` | yes | `mergeable=MERGEABLE`, `mergeStateStatus=BEHIND` — **not** BLOCKED | docs-only: W7 cutover design-lock draft (+379) and W8 verification/closeout plan draft (+397), both PROPOSED/HOLD | 4556 (W7/W8 paper) |
| PR 4810 | `4ca537c66bb00bede251cbabdcbdc7e730ec60f9` | yes | `mergeable=MERGEABLE`, `mergeStateStatus=BEHIND` — **not** BLOCKED; an earlier pass of this document said BLOCKED and that is **retracted** | FSER-4 §3–4 frontend surface wiring: one strict parser + one strict client + 4 surface components + 5 mount points + 4 spec files + 12 browser-evidence PNGs; **zero backend / `.cjs` files touched** | 4709 (consumed by 4556's group workspace) |
| PR 4745 | `043851d3db7bb8d4b4514af3b1354265f9b2cdf3` | yes | OPEN, base `main` | Windows-native exact-SHA QA v2 harness. **This is the owner-frozen QA tooling SHA** named in the 2026-08-04 v2 freeze comment. All 16 check runs at that head conclude `success`, including every one of the nine required contexts | 4556 QA (issue 4629) |
| branch `claude/attendance-windows-qa-v2-0dc3596dd-20260806` | `7e531be6d6c85e61709661a7d59db8fc975daf58` | — | **no PR in any state** | Windows-native QA v2 tooling: 52 files, +11,104/−22, none under `packages`/`plugins`/`apps`/`package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` | 4556 QA (issue 4629) |

**PR 4804's head has been re-pinned, and the earlier pin was superseded by a rebase, not a
fast-forward.** An earlier pass of this document pinned `e941eea9c1186bb49522c67148023b5f4fb9428a`.
That object still resolves locally, but it is not reachable from the current head. Consequently the
draft sizes moved (W7 377→379, W8 370→397) and **every `file:line` anchor into those drafts must be
read at the current head**, not at the superseded one. §5.1's W7/W8 anchors are stated against
`a1344c77…` and were re-derived there.

**PR 4745 and the QA branch are two different candidates for the same deliverable, and they have
diverged.** `git merge-base --is-ancestor 043851d3db7b… 7e531be6d6c8…` returns rc=1 — the frozen
tooling head is **not** an ancestor of the branch. Their merge base is `783eb72fe038…`. The branch
additionally re-pins the campaign: `scripts/ops/attendance-windows-native-qa-v2.pin.json` on it
declares `"expectedSourceSha": "0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b"`, whereas the 2026-08-05
owner relay authorizes PQA-01..10 on the frozen **product** candidate `676ed2433813…`. Which of the
two is canonical is an owner decision, recorded at §5.3 — not a task this document assigns.

Two items the earlier inventory listed as in-flight are **merged**, not open: PR 4800 (merged
2026-08-08T01:28:23Z, merge commit `c5af484b3f745ad68de12753ece614ba7ab22008`, one docs file on the
K3/stock-prep ledger — not this line) and PR 4801 (merged 2026-08-07T16:12:27Z, merge commit
`7c7d550dbfba175a8c29afe0f59ba06b2287303d`, CI test-chain wiring — not this line).

### 1.4 Known limits of this inventory

- "Landed" here means *merged and the file is present at the pinned SHA*. No build, typecheck, or
  test suite was run for this document. Nothing here asserts any module is green today.
- W0's mapping to PRs 4558/PR 4560 comes from parent lock §9.1 prose plus `git log` ancestry; the
  two-witness API check (`merged=true` + the literal `(#N)` suffix on the main subject) that covers
  W1–W6 was not run on W0, and W0's own completion criterion (a focused OpenAPI contract test wired
  and green) was not independently checked. **unverified** at that granularity.
- `[HOLD]` and `[DRAFT/HOLD]` markers do not reliably survive squash. PR 4779 and PR 4783 both
  carry `[HOLD]` in their PR titles and lose it in the squashed main subject. An audit of hold
  posture done from `git log` on main alone will understate it.
- The `test (20.x)` required check on the pinned head `a45e1416` was still `in_progress` at the
  first read. Most CI evidence cited in this document comes from ancestor commits `51c3d872` (run
  31191954460) and `7c7d550d` (run 31196449251); the verification record re-derived the same numbers
  at the pinned head itself once `test (20.x)` concluded `success` (job `93053687144`).
- **Which GitHub surfaces were swept, stated because the answer bounds every authorization claim
  below.** Issue bodies, issue comment threads, and PR comment threads were read for the objects
  named in §7.5/§7.6. **PR *bodies* were not swept in the first pass**, and they are a distinct
  surface that carries load-bearing content on this line: PR 4772's and PR 4773's bodies contain
  verbatim owner in-session authorization transcripts, and PR 4773's body carries the amendment §6
  gate-by-gate self-assessment quoted at R1.5. §5.4's SQ-2/SQ-3 conclusions are stated about
  *threads*, and that scoping is now explicit in those rows. Review *verdicts* (`/pulls/N/reviews`)
  were swept on the second pass — see §3.4 G6.
- Check-run rollups, `mergeStateStatus`, and behind/ahead counts are **not** pinned by a SHA. They
  are mutable and re-runnable. Every such number carries its read pass.

---

## 2. Architecture of what landed

### 2.1 The W4C spine, in one paragraph

W4 replaced "a function that computes attendance" with a **write boundary**. Every calculation-
affecting write now has to name an operation, prove its authorization, freeze the exact inputs it
used, produce a fingerprint over those frozen inputs, and land the result and its outbox event in
one transaction. W4C-0 defines that boundary and gives it durable storage. W4C-1 supplies a pure
calculator that consumes only frozen inputs. W4C-2 gives scheduled work its own identity, an outbox
union, and a fair recovery sweep. W4C-3a/3b/3c cut the three families of caller (import/rollback,
approval/request, record/manual edit) over to the boundary until no bypass path is left. W4C-4 makes
the result explainable and diffable against legacy. W4C-5 hardens the state machine that would move
an org between rollout postures. W5 extends the calculator with a flex mode. W6 (prepared, not
running) is the read-only surface that tells a user which of all this is actually in effect for a
group.

### 2.2 W4C-0 — the write boundary and durable storage

Seven modules under `packages/core-backend/src/attendance/`, all introduced by
`d4dc12d8a8cde38c8f04f1952b3ba0b8b317265f` (verified via `git log --diff-filter=A`):

| Module | Lines | Role, with an anchor |
| --- | --- | --- |
| `w4c0-operation-contract.ts` | 136 | The batch/timeout envelope and the closed error surface. `ATTENDANCE_W4_OPERATION_ERROR_CODES_V1` at `:31`, its HTTP-status map at `:51`, `AttendanceW4OperationError` at `:77`, `failW4Operation` at `:94`, the outbox event-kind unions at `:114` and `:132`. Limits are constants, not magic numbers: `W4_MAX_BATCH_ITEMS` / `W4_MAX_DISTINCT_TARGETS` = 5000 at `:18-19`, statement timeout 180 s at `:20`, lock timeout 5 s at `:21`, max retries 2 at `:23`. |
| `w4c0-write-boundary-types.ts` | 341 | The frozen-input vocabulary. `AttendanceCalculationEntrypointV1` at `:23`, `AttendanceCalculationIntentV1` at `:59`, `FrozenWorkDateAttributionV2` at `:83`, `FrozenAttendanceContextV1` at `:124`, `PreparedAttendanceWritePlanV1` at `:281`, and the branded `LockedAttendanceCalculationSourcesV1` at `:303` — a phantom-typed token that makes "these sources were locked" unforgeable at the type level. |
| `w4c0-identity.ts` | 1,508 | Org/actor/entrypoint identity and the rollout allowlist env constant (`:363`). |
| `w4c0-authorization.ts` | 353 | Fail-closed authorization for boundary operations. |
| `w4c0-fingerprints.ts` | — | Storage fingerprint over frozen inputs. |
| `w4c0-source-commands.ts` | — | The typed command set (parent OD-4556-10: no universal group write endpoint). |
| `w4c0-operation-registry.ts` | — | Operation registration/dedup. |

Durable storage arrives with `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts`.

W4C-0 also shipped the line's most unusual gate: `scripts/attendance/w4c0-dml-inventory/` — eleven
`.cjs` modules (`collector.cjs`, `table-classification.cjs`, `classify-tracked-sites.cjs`,
`curated-debt-entries.cjs`, `sources.cjs`, `generate-baseline-manifest.cjs`,
`pinned-baseline-obligation.cjs`, `calculation-read-classification.cjs`,
`current-record-read-classification.cjs`, `p25-call-path-classification.cjs`,
`p26-approval-assignment-classification.cjs`) driven by
`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` (1,431 lines, 58 `node:test` cases),
against a frozen debt baseline `docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json`.
See §3.2.4.

### 2.3 W4C-1 — the pure calculator

Four modules, all introduced by `aebac4f8bef344b3ff3443ee045439c789a569a1` in a commit that modified
zero existing files, touched zero DB, added zero routes, and cut over zero callers (8 files: 4 src +
4 spec; 3,617 insertions, 0 deletions — verified from `git show --stat`).

- `w4c1-segment-calculator.ts` (1,224 lines) — engine version pinned as a string constant
  `ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 = 'w4c1-segment-calculator@1'` at `:62`; three closed
  enums (`ATTENDANCE_SEGMENT_STATUSES_V1` `:68`, `ATTENDANCE_SEGMENT_REASONS_V1` `:79`,
  `ATTENDANCE_DAILY_STATUSES_V1` `:94`) plus the outcome-reason union at `:107`;
  `validateFrozenContextShape` at `:335` (the fail-closed shape guard); the entry point
  `calculateAttendanceSegmentsV1` at `:836`.
- `w4c1-strict-time.ts` (322) — strict time arithmetic, no ambient clock.
- `w4c1-merge-policy.ts` (182) — segment merge rules.
- `w4c1-fingerprints.ts` — golden-pinned fingerprints over the frozen context.

### 2.4 W4C-2 — scheduled-run identity, outbox union, recovery sweep

Six modules (`w4c2-frozen-attribution`, `w4c2-live-scheduled-boundary`, `w4c2-outbox-dispatcher`,
`w4c2-scheduled-run-ops-worker`, `w4c2-scheduled-run`, `w4c2-shadow-expected-differences`), plus
migration `zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts`,
`packages/core-backend/src/index.ts` +114 and `src/types/plugin.ts` +103.

The recovery sweep's fairness property lives in `w4c2-scheduled-run.ts` (1,396 lines): the candidate
scan is a durable rotation, not a fixed prefix —

```
UPDATE attendance_scheduled_runs SET last_attempt_at = now()
 WHERE run_id IN (SELECT run_id FROM attendance_scheduled_runs
                   WHERE state = 'running'
                   ORDER BY last_attempt_at ASC NULLS FIRST, created_at ASC
                   LIMIT $1 FOR UPDATE SKIP LOCKED)
```

(`w4c2-scheduled-run.ts:1231-1242`, verified). Observability counters were added later by PR 4779
on `w4c2-scheduled-run-ops-worker.ts` (372 lines, +178 in that PR).

**Provenance anomaly, recorded not adjudicated.** The nominal W4C-2 runtime PR 4612 was never
merged: the API reports `merged=false`, `state=closed`, title
`⛔ OWNER-AUTHORIZATION-HOLD — W4C-2 live and scheduled shadow (issue 4556 W4 slice 3) — DO NOT MERGE`,
and its API `merge_commit_sha 61dee2d61e…` is a test-merge ref that does not resolve to a commit in
the clone. The six runtime modules reached main under PR 4670
(`5ae2cea0b2a84f0d36319f79c38ae2e796b5d20a`, 47 files, 19,070 insertions) whose subject prefix is
`test(attendance): W4C-2 option-A integration candidate` and whose own body reads "This PR is
**not authorized to merge**." It merged 2026-07-29T00:28:25Z. Whether a later owner authorization
superseded that body text is **unverified** — the comment threads of PR 4670 and PR 4669 were not
read. A post-merge provenance erratum is on main (PR 4637 → `d449aa7e6d02f94df2738a77cafffa778b12fde0`),
recording that PR 4612 was force-push rebased on 2026-07-27 so head `8dfde5a77…` was superseded by
`b0c7e2823e…`.

### 2.5 W4C-3a/3b/3c — the three cutovers

**W4C-3a (import and rollback)** is the largest single landing on the line: eighteen modules
`w4c3a-{canonical-import-kernel, import-proof, import-rollback-boundary, import-rollback,
legacy-execution-plan, legacy-plan-batch-effects, legacy-plan-enqueue, legacy-plan-group-effects,
legacy-plan-item-effects, legacy-plan-preconditions, legacy-plan-processor, legacy-plan-record-effects,
legacy-plan-reservation-host, legacy-plan-worker-repository, legacy-plan-worker, rollout-control,
sync-import-host, sync-import-kernel}.ts`, with `plugins/plugin-attendance/index.cjs` changed by
4,673 lines. It was preceded by six merged docs amendments (PRs 4672, PR 4677, PR 4679, PR 4685, PR 4686,
PR 4687 — SHAs in §7).

`w4c3a-rollout-control.ts` (1,298 lines) is the org rollout state machine and the module W4C-5 later
hardened. Its request-snapshot precondition is a frozen closed set:
`ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1` at `:814-823`, eight members —
`pendingMissing`, `pendingUnsupported`, `pendingPayloadStale`, `pendingReversalIncomplete`, and the
four `reversible*` mirrors (verified by reading the blob).

**W4C-3b (approval and writer cutover)** — `w4c3b-{approved-leave-cancellation,
central-approval-hooks, request-operation-boundary, request-snapshots}.ts`, plus modifications to
`packages/core-backend/src/routes/approvals.ts`, `src/services/ApprovalProductService.ts` (+168),
`src/services/ApprovalBridgeService.ts`, and `plugins/plugin-attendance/index.cjs` (4,552 lines).
`w4c3b-request-snapshots.ts` is 1,444 lines; `w4c3b-central-approval-hooks.ts` is 492.

**W4C-3c (zero-bypass cutover)** — `w4c3c-{active-current, manual-edit-apply, manual-override,
ops-retirement, recompute, record-operation-boundary}.ts`, plus
`scripts/attendance/execute-ops-retirement-cleanup.cjs` and
`scripts/ops/staging-attendance-tooling-teardown.mjs`. `w4c3c-record-operation-boundary.ts` is 450
lines; `w4c3c-manual-override.ts` is 401. "Zero-bypass" is not a slogan here: the DML-inventory gate
asserts the current-tree open-debt set is exactly empty (§3.2.4).

### 2.6 W4C-4 — calculation detail and shadow ledger

`packages/core-backend/src/services/AttendanceW4CalculationDetail.ts` (834 lines) is the read model
that makes a W4 result explainable and comparable:

- `ATTENDANCE_W4_SHADOW_DIFF_CODES` at `:8` with its label map at `:32` — a closed diff vocabulary,
  not free text;
- `AttendanceCalculationSchemaUnsupportedError` at `:135` — an unknown persisted schema fails closed
  rather than being coerced;
- `computeAttendanceW4ShadowDiff` at `:252` and `parseAttendanceW4ShadowDiff` at `:304`;
- `ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND` as a `Symbol` at `:384` — a not-found that cannot be
  confused with a legitimate value;
- `readAttendanceCalculationDetail` at `:505`, `readAttendanceW4ShadowBacklog` at `:593`,
  `readAttendanceW4TraceEvidence` at `:781`.

Surfaced through `routes/attendance-admin.ts` (+113) with OpenAPI in `packages/openapi/src/base.yml`
(+108) and `src/paths/attendance.yml` (+100). `AttendanceDecisionTrace.ts` gained +367.

### 2.7 W4C-5 — transition-boundary hardening (code) vs. the soak (not run)

W4C-5's landed content is hardening of the **rollout transition boundary**: PR 4773 (+694 on
`w4c3a-rollout-control.ts`, plus `w4c0-identity.ts` and `w4c3b-request-snapshots.ts`) and PR 4780
(+257 on `w4c3a-rollout-control.ts`, +73 on `w4c3b-request-snapshots.ts`) completing the 8-cell
closed-set predicate.

The governing amendment
`docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md` fixes the
legal state-transition matrix at `:40-57` — seven pairs, each with a comparison write posture
(`legacy→shadow` shadow; `shadow→eligible` shadow; `eligible→shadow` shadow;
`eligible→authoritative` authoritative; `shadow→legacy` legacy_projection_only;
`authoritative→suspended` preserved authoritative; `suspended→authoritative` preserved
authoritative) with "every other pair fails before rollout-state/event DML". Its §3 (`:84-108`)
fixes the database preconditions and states that a caller-supplied `ready=true` is not a substitute
for those queries; §4 (`:110-128`) fixes the out-of-database manifest; §5 (`:130-145`) forbids the
tooling from carrying direct rollout DML, a raw-SQL escape hatch, a wildcard org, an implicit
`--yes`, or a default target.

The amendment's header still reads `Status: **PROPOSED / staging HOLD**` on main at `:4`
(*doc-header-derived*) — but see §5.2: the owner **did** relay `OD-W4C-61=(a)` as RATIFIED on
2026-08-05. The header is stale, not the decision.

The soak itself has **no execution record**. `docs/deployment/attendance-issue-4556-w4c5-synthetic-soak-runbook-20260804.md`
is `DRAFT / NOT EXECUTABLE` (`:4-9`) and its §0 (`:11-23`) records that at publication no staging org
was named, no image SHA approved, and no soak authorization granted.

### 2.8 W5 — single-segment flex

`packages/core-backend/src/attendance/w5-flex-policy.ts` (246 lines) is deliberately small and
closed:

- `ATTENDANCE_FLEX_MODES_V1 = Object.freeze(['strict', 'flex_required_duration'])` at `:27` — a
  two-value union, `AttendanceFlexModeV1` at `:28`;
- the discriminated policy type at `:30`/`:34`/`:43`, with `ATTENDANCE_FLEX_MAX_REQUIRED_MINUTES_V1
  = 1440` at `:47`;
- `flexCoreHoursCoveredByAllClampedIntervalsV1` at `:117` — the core-hours predicate;
- `validateAttendanceFlexPolicyV1` at `:143`, `normalizeAttendanceFlexPolicyV1` at `:189`,
  `resolveAttendanceFlexExpectationV1` at `:222`.

Persistence via `zzzz20260804120000_attendance_shift_flex_policy.ts`; authoring UI via
`apps/web/src/views/attendance/AttendanceShiftFlexPolicyEditor.vue` (249 lines); calculator
integration via `w4c1-segment-calculator.ts` (+147) and `w4c1-strict-time.ts` (+40);
`attendanceShiftSegments.ts` (+211) and `plugins/plugin-attendance/lib/attendance-shift-service.cjs`
(+324). Parent lock closure condition 3 ("flex behavior is distinct from grace") is the semantic
this slice exists to satisfy.

### 2.9 W6 — preparation only

PR 4771 landed 14 new files, 1,552 insertions, and no runtime:

- `packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts` (206 lines) — types
  and closed sets only, no logic: `ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1` at `:25`
  (the five-value label union), `…_DOMAINS_V1` at `:36` (eight domains), `…_CONFLICT_CODES_V1` at
  `:50` (seven codes), the group-type and calculation-posture unions at `:63`/`:69`, the
  `editorRef` union at `:82`, the FSER embed type at `:116`, and the response shape at
  `:167`/`:203`;
- `apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue` — 52 lines, and its own
  header states it "is intentionally NOT imported or mounted by any runtime file in W6-0; it renders
  a static placeholder, makes zero API calls, and contains zero business logic" (verified by reading
  the file);
- `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` — note the path is
  `drafts/`, **not** the generated `src/paths/` surface. Whether the OpenAPI build or any required
  contract gate reads `drafts/` was **not** verified; so whether the draft is inert by construction
  or merely unwired is **unverified**;
- nine fixtures under `packages/core-backend/tests/fixtures/attendance/w6/`;
- the design lock itself.

The lock's red line W6-R9 (`:111`) makes the inertness a testable property: "The W6-0 preparation PR
is byte-inert: deleting its contract, fixtures, and shell files leaves every existing test green."

### 2.10 The FSER-4 prerequisite (adjacent issue 4709, consumed by W6/W7)

The issue-4709 chain is fully on main: lock PR 4712 → `7abd4e5872946c0ae3c95dfbacf14cf47e1fb700`
(RATIFIED 2026-08-03, "Ratification authorizes FSER-1 only"), FSER-1 PR 4727 →
`ebeafc08be265e458013077887d4b422ee15c09b`, FSER-2 PR 4730 →
`6b439a1ab05a8b2588e42f59499f9849bd3242b1`, FSER-3 PR 4735 →
`390841a645e07221f1769760af6c933a37644729`, ratification record PR 4725 →
`4086cef6262ccea8e1822afa5a34e19c7313f0f4`.

FSER-4's contract amendment (PR 4746 → `45d71c4209af35a63768ce7ce9f576377f6b8ce4`) exists because
of a real defect finding, not a style preference: its §0 records that a frontend-only FSER-4 would
be a permission / data-minimization defect, because the only effectiveness route was
`attendance:admin`-guarded and returned whole-group counts. Fetch-and-hide is not minimization.

The server repair landed as PR 4772 → `ce17ed321752d3adb96569f15a102c8986f303da`:
`plugins/plugin-attendance/lib/attendance-fixed-schedule-self-route-identity.cjs` (92 lines —
`flattenSelectorValues` `:39`, `hasSelector` `:44`,
`resolveAttendanceFixedScheduleSelfRouteIdentity` `:58`, single export at `:92`), extending
`attendance-group-fixed-schedule-effectiveness-service.cjs` (+110). Both routes now exist on main:
the admin aggregate at `plugins/plugin-attendance/index.cjs:44373` and the member-safe
`/api/attendance/groups/:groupId/fixed-schedule/effectiveness/me` at `:44419`, with the identity
helper required at `:18`.

The design point worth carrying into W6/W7: **identity comes only from the authenticated principal**
— no body, no `userId`/`orgId` query, and `x-user-id`/`x-org-id` never become identity sources
(amendment `:70-98`). W6-R3 states the same rule for the group aggregate.

### 2.11 Runtime posture: the whole W4 chain is gated OFF by default

`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` appears in `.env.example` only as commented lines 168
and 177, and zero times in `docker/app.env.example` (verified by grep). Production read sites do
exist — `w4c0-identity.ts:363` defines the allowlist env constant, `plugins/plugin-attendance/index.cjs`
reads `process.env` at `:29356` and `:49612`, and `lib/attendance-shift-service.cjs:56` — so the gate
is real code, not dead text, but it is unset in the shipped env templates. The rollout state machine
defaults to `legacy`.

This is what the repo's own erratum (PR 4613 → `df610db9ab6c403da6233a9c5dae2579941a6275`) means by
"production-inert": zero orgs in shadow, zero caller cutover in W4C-0, zero wiring in W4C-1.

---

## 3. The governance mechanisms this line runs on

### 3.1 The authorization ladder

The line's unit of work is not a PR; it is a **ratified scope**. The ladder:

1. **Design lock** — a document that fixes scope, red lines, decision menu (`OD-*`), completion
   gates, and a landing sequence. Merged as `PROPOSED / Draft / HOLD`, which authorizes nothing.
2. **Owner RATIFY of an exact merged SHA** — the owner names the 40-character SHA of the merged lock
   and answers its `OD-*` menu. Both halves are required: the W6 lock's landing step 2 (`:294-304`)
   reads "Owner RATIFYs the exact merged SHA **and answers OD-W6-1..9**".
3. **Gated implementation** — the ratified slices only, in order, each as its own fresh-`main`
   Draft/HOLD PR, enabling no org.
4. **Independent adversarial gate at the exact head** — a separate reviewer at the precise head SHA.
   Where the ladder has been *recorded* running, the bar has been 0 P1 / 0 P2: the W1 record doc
   states the final verdict was APPROVE 0 P1 / 0 P2 after five findings were repaired. **This rung is
   stated as the design, not as an observed property of every landing** — §3.4 G6 records six
   consecutive landings on 2026-08-05/06 with no independently recorded exact-head verdict at all.
5. **Owner merge ruling** — separate from the gate. "Gate green" does not mean "merge".

Each rung disclaims the next. The parent lock's ratification is explicit: "this ratification unlocks
W1 only. Each later slice remains sequential and separately gated. It does not authorize a runtime
flag, deployment, production migration, or issue closure" (`:16-18`).

### 3.2 Evidence disciplines

#### 3.2.1 Values-free surfaces

Aggregate and observability surfaces expose shapes, counts, and closed codes — never member-level
values. W6-R2 requires the aggregate to be values-free at member level; FSER-4 §2 requires the self
response to never serialize coverage counts, drift counts, managed sets, producer keys, or any user
ID; the W4C-2 sweep counters landed as values-free (`neverAttemptedRunning`,
`oldestRunningAttemptAgeSeconds`).

#### 3.2.2 Enum-strict closed sets that fail closed

Each vocabulary cited in §2 is a frozen array with a derived type, and unknown values are rejected
rather than defaulted: `ATTENDANCE_W4_OPERATION_ERROR_CODES_V1`, `ATTENDANCE_SEGMENT_STATUSES_V1`,
`ATTENDANCE_W4_SHADOW_DIFF_CODES`, `ATTENDANCE_FLEX_MODES_V1`, the three W6 unions, and
`ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1`. The last one shows the discipline's payoff: because
the eight cells are an exported frozen table, the test derives its expectation *by iterating the
exported table* rather than restating it, so a ninth cell cannot be added without the test noticing
(`attendance-w4c3a-rollout-control.db.test.ts:383-396`).

#### 3.2.3 Fail-closed authorization before any scoped SQL

The pattern is: resolve identity from the principal → reject identity selectors with a typed 400 →
reject header/principal mismatch with a 403 → prove membership/activation in one org-scoped query →
collapse every failure reason into one byte-identical 404. W6-R3 restates it for the group aggregate
("authorization precedes every aggregate SQL … one 404 shape"). The negative-proof requirement is
part of the rule: each predicate needs a *remove-the-predicate* leg that reds.

#### 3.2.4 Exact-tuple DML classification

`scripts/attendance/w4c0-dml-inventory/` + `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs`
(58 cases) scans the real tree and asserts three `deepEqual`-to-`[]` invariants: every business /
schedule-fact / shared-hook DML site resolves to a curated debt entry or the generic-shared
allowlist; every attendance-owned table hit is classified; `w4_canonical`-bucket tables are written
only from the canonical adapter path prefix. It adds W4C-3a/W4C-4 SELECT-inventory classification,
the W4C-3c hard zero-bypass assertion (current-tree open-debt set exactly empty), roughly ten
positive-control bypass probes (plugin-style INSERT, new route without discriminator, shared
`approval_instances` write, operator-script delete, raw `COPY` into a canonical table,
`COPY FROM STDIN`, `MERGE INTO`, runtime staging `CREATE TABLE`), byte-reproducibility of the
manifest against pinned baseline `e0defbe26d7f2e1747e74aa908ca710422812bf7`, and a self-assertion
that this very file has an explicit CI execution step. It ran on main and passed 58/58, 0 fail
(run 31196449251, job 92925709990).

**Scope limit, stated because it is easy to over-cite:** the collector excludes `/tests/`, `/test/`,
`/__tests__/`, `/__fixtures__/` path segments and `.test.` / `.spec.` filename markers by
construction. It gates *production* DML sites. It is structurally incapable of detecting an unwired
test file, and must not be cited as coverage evidence for the test corpus.

#### 3.2.5 Two-point CI wiring

A real-DB integration suite on this line must appear in **both** places: the `plugin-tests.yml`
real-DB run-list (step id `attendance-real-db-integration`) and `packages/core-backend/vitest.config.ts`
`test.exclude` (so the no-DB unit config does not skip-green it).

**This is not a convention or a lane habit — it is ratified lock text.** W4 lock §12.9 "CI collection
is part of each slice" (`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`,
heading `:3033`, text `:3035-3037`, RATIFIED at exact merged SHA `a3e5765727ca608e8c49c7a44a025e6e4aae5d40`)
reads verbatim:

> Every new test proves local collection, DB exclude/run-list wiring, workflow
> positive control, and exact mutation/failing leg. Frontend additions update both
> path filters and explicit web-guard run list. Skip-green is a failed gate.

An earlier pass of this document described the two-point rule as a repo *convention*. That
description is **retracted**: it is a ratified per-slice completion obligation with four named
components (local collection; DB exclude/run-list wiring; workflow positive control; exact
mutation/failing leg), and "skip-green is a failed gate" is the lock's own words.

At the pinned SHA, 40 files match
`packages/core-backend/tests/integration/attendance-w4c*.db.test.ts`; 38 are in the run-list; the
same 38 are in `test.exclude` (verified by `comm` over basenames). The invariant is real and held
for 38 of 40 **in the run-list→exclude direction at this scan width**.

The two exceptions are the line's live defect: `attendance-w4c3b-central-approval.db.test.ts` and
`attendance-w4c3b-request-snapshots.db.test.ts` are in neither list, so their `describeIfDatabase`
blocks skip-green under the no-DB required step and execute against a database nowhere. See §4.6 R1.1.

**The opposite-direction violation (C′), which the width-1 numbers hide.** Re-derived at the pinned
SHA by extracting both sets over the wider `attendance-*.db.test.ts` window and running `comm` in
both directions: `attendance-shift-segments-migration.db.test.ts` (9 `it()`) and
`attendance-shift-segments-writer-matrix.db.test.ts` (33 `it()`) are **in the run-list but absent from
`test.exclude`**. Both are W3-phase files from PR 4569. **No coverage is lost** — both execute in the
real-DB step — so this is bookkeeping, not a hole. It is recorded because it is load-bearing for
R1.1's acceptance bar: PR 4805 replaces the handwritten allowlist with a *tree-derived* corpus, and a
guard that checks both directions can red on exactly these two W3 files after rebase, for a reason
that has nothing to do with the two orphans. The reverse `comm` at width 1 returns empty, which is
why the narrow window did not surface it.

The real-DB step is itself pinned to the required gate: it carries id `attendance-real-db-integration`
in job `test` with deliberately no `if:`, and `attendance-w4c2-ci-wiring.test.mjs` asserts via a
fail-closed `python3` + PyYAML parse that the step id appears in exactly the job `test`.
That step's 98 files reported "Test Files 98 passed (98) / Tests 1300 passed (1300)" with zero skips.

#### 3.2.6 Provenance pins

Frozen baselines are pinned by full SHA and re-derived, not trusted: the DML debt baseline
(`e0defbe26…`), the W4C-1 fingerprint goldens, the Windows QA v2 candidate
(`SOURCE_SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b`, declared in ≥18 places on that branch
including `scripts/ops/attendance-windows-native-qa-v2.pin.json:3`), and the sealed-export package
pins in `s6a-package-provenance-pins.json`. The QA branch's product-freeze claim is proven by an
empty diff **with controls**: the six-pathspec diff base→head is empty; positive control A shows all
six pathspecs resolve at the base; positive control B shows the same pathspec set base→`origin/main`
is non-empty (25 files, +2,866/−181); the negative control (`-- packagez`) returns empty with exit 0,
which is exactly the vacuity hazard the controls rule out.

### 3.3 Required checks

Branch protection on `main` carries nine required contexts with `strict=true`: `contracts (strict)`,
`contracts (dashboard)`, `pr-validate`, `test (20.x)`, `contracts (openapi)`, `web-tests`,
`stock-prep PowerShell 5.1 acceptance`, `attendance-web-guard`, `integration-guard` (verified via the
protection API). `strict=true` means every merge pushes the others BEHIND; a rebase re-runs all nine.

### 3.4 Failure modes this line has already recorded about itself

These are not hypotheticals; each is on main or in a thread.

| # | Failure mode | Record |
| --- | --- | --- |
| G1 | **Self-certifying authorization.** PRs 4606 and PR 4607 merged while the PR 4595 AUTOMATION HOLD was in force, because the lane re-read the in-repo `RATIFIED` header that it had itself merged via PR 4600. The erratum names the mechanism ("授权检查成了自证循环") and bounds the blast radius as production-inert. | PR 4613 → `df610db9ab6c403da6233a9c5dae2579941a6275`; `attendance-issue-4556-w4-development-verification-20260726.md` §1.2 |
| G2 | **Doc-header lag in the opposite direction.** **Nine** amendment headers on main read `PROPOSED`, not two. G1 was an artifact *overstating* authority; this is an artifact *understating* it. Both prove the same thing: the header is not the authorization. Mechanical count, not an estimate — see the enumeration below the table. | `…fser4-member-projection-contract-amendment-20260804.md:4`; `…w4c5-transition-safety-amendment-20260804.md:4`; seven more enumerated below; relay comments in §7 |
| G3 | **Hold markers do not survive squash.** PR 4779 and PR 4783 carry `[HOLD]` in the PR title and lose it in the main subject; PRs 4772/PR 4773/PR 4774 happen to retain theirs, which makes the inconsistency easy to miss. | `git log` subjects vs. API titles |
| G4 | **Allowlist-shaped guards cannot converge.** `attendance-w4c2-ci-wiring.test.mjs` enforces run-list membership from a handwritten `FILES` array (`:72-134`) with no `readdirSync`/`globSync` (verified by grep), so it proves "these named files are wired" and structurally cannot notice a new unwired one. It missed both W4C-3b orphans for six days. | §3.2.5, §4.1 R1.1 |
| G5 | **A commit prefix that misdescribes its content.** Six runtime modules, a migration, and `src/index.ts` +114 landed under a `test(attendance):` prefix (PR 4670). Recorded as an observation about the subject line; intent was not investigated. | §2.4 |
| G6 | **The independent-reviewer channel failed silently across six consecutive landings, and nothing detected it.** For PRs 4771, 4772, 4773, 4774, 4779 and 4780 — the entire 2026-08-05/06 landing burst — `gh api repos/zensgit/metasheet2/pulls/N/reviews` returns **length 0** for all six, and `…/issues/N/comments` returns exactly **one** comment each, all from `chatgpt-codex-connector[bot]`, all reading verbatim: *"You have reached your Codex usage limits for code reviews."* Stated precisely: there is **no recorded independent exact-head verdict** for any of the six. This is not the same as "the work was ungated" — §5.4 SQ-1 and §4.6 both note that an out-of-band owner/Codex channel demonstrably exists and is not captured on GitHub, and PR 4773's body does record two self-authored gate verdicts. But those verdicts are at heads `69c902d7dfb5…` (CHANGES-REQUESTED, 2 P1 / 4 P2) and `c8cf5fad4…` (APPROVE-with-hardening, P1=0 / P2=3), **neither of which is the merged squash `3601817969…`**, so neither binds what landed. PR 4774's body cites an independent second opinion at `pr4774-second-opinion-20260805.md`; that path is **not on main** (`git ls-tree -r --name-only origin/main -- docs \| grep -i second-opinion` → empty). This is a **standing mechanism hazard**, not a backlog item: the only gate narrative *findable on GitHub* for those six landings is in PR bodies authored by the implementing lane, which is the G1 self-certification shape recurring six times in 48 hours. Stated with its limit: an out-of-band owner/Codex channel demonstrably exists (§5.4 SQ-1, and PR 4669's own RATIFY comment describes itself as "a relay" of a decision made "directly in the Codex thread"), so this is **"no *recorded* independent gate at the exact head"**, not "no gate happened". | `gh api …/pulls/{4771,4772,4773,4774,4779,4780}/reviews` → 0 each; `…/issues/N/comments` → 1 bot comment each; PR 4773 body; `git ls-tree` for the 4774 second-opinion path |

**G2 enumerated mechanically.** Command:
`for f in $(git ls-tree -r --name-only origin/main -- docs/development | grep -iE 'attendance.*amendment.*\.md$'); do git show origin/main:$f | sed -n '3,5p' | grep -i Status; done`
Eleven amendment files match that pathspec; **two** read `RATIFIED`
(`…w4c0-identity-proof-amendment-20260725.md`, `…w4c3a-durable-legacy-plan-amendment-20260729.md`)
and **nine** read `PROPOSED`:

1. `attendance-4709-fser4-member-projection-contract-amendment-20260804.md` — `PROPOSED / runtime HOLD` *(named in §5.2; RATIFY relayed 2026-08-05)*
2. `attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md` — `PROPOSED / staging HOLD` *(named in §5.2; RATIFY relayed 2026-08-05)*
3. `attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md`
4. `attendance-issue-4556-w4c2-per-target-failure-taxonomy-amendment-20260729.md`
5. `attendance-issue-4556-w4c3a-legacy-preimage-restore-amendment-20260729.md`
6. `attendance-issue-4556-w4c3a-byte-parity-field-amendment-20260730.md`
7. `attendance-issue-4556-w4c3a-group-precondition-freeze-amendment-20260730.md`
8. `attendance-issue-4556-w4c3a-locked-race-lockset-amendment-20260730.md`
9. `attendance-issue-4556-w4c3a-result-slots-amendment-20260730.md`

The pathspec is printed because the enumeration is only as complete as its window: it matches
`attendance.*amendment.*.md` under `docs/development`, which is deliberately wider than
`attendance-issue-4556-*amendment*` (that narrower glob would drop entry 1, whose basename begins
`attendance-4709-`). Whether each of items 3–9 has a corresponding ratification is a separate
question, answered per-ID in §5.2. The header-repair sweep in §4.6 R6.5 is therefore sized at
**seven files** beyond the two already named, not at two.

---

## 4. Remaining development, ordered

### 4.0 Model tier legend

| Tier | Use for | Rationale |
| --- | --- | --- |
| **sonnet5** | Implementation inside an already-ratified scope: writing the slice, its tests, its fixtures, its CI wiring. | The scope decision is already made; the work is mechanical breadth against a fixed contract. |
| **opus5** | Adversarial gates, design judgment, contract/amendment authoring, anything where the question is "is this claim actually true" or "is this the right shape". | These are the steps where an over-strong claim or a mis-shaped contract is the failure, and where §3.4's failure modes recur. |
| **fable5** | Orchestration: watching CI, sequencing merges, rebases, evidence collection runs, log sweeps. | High volume, low judgment, long wall-clock. |

Rule of thumb visible in the records read for this line: **the lane that writes a slice does not
gate it.**

---

### 4.1 (i) In-flight landing

#### R1.1 — PR 4805: repair of a **failed ratified slice-completion gate** for W4C-3b (highest priority)

> **Reclassification, stated because an earlier pass got the class wrong.** This item was previously
> filed as "OBS-1", an in-flight observability/hygiene fix parallel to W6. It is not hygiene. W4 lock
> §12.9 (`:3033`, text `:3035-3037`) makes DB exclude/run-list wiring a **per-slice completion
> obligation** of the ratified W4 lock and states "Skip-green is a failed gate." W4C-3b shipped two
> dedicated real-DB suites that are in neither list. **On the lock's own words, W4C-3b's
> slice-completion gate is FAILED**, which means W4 lock §15's statement that "W4C-0, 1, 2, 3a, 3b,
> 3c, 4, and 5 are on main in order" is not satisfied in the sense §12.9 requires. This places R1.1
> **upstream of W4 completion, and therefore upstream of the W6 → W7 → W8 chain** — not beside it.

| Field | Value |
| --- | --- |
| **Scope** | Two-point CI wiring (real-DB run-list arg + `vitest.config.ts` `test.exclude` entry) for `attendance-w4c3b-request-snapshots.db.test.ts` and `attendance-w4c3b-central-approval.db.test.ts`; plus conversion of `scripts/ops/attendance-w4c2-ci-wiring.test.mjs` from the 33-entry handwritten allowlist to a corpus derived from the on-disk tree, with negative controls. |
| **Why first** | It closes a *currently live* verification hole **and** repairs a ratified gate: 20 real-DB assertions — 16 `it()` in central-approval, 4 DB-gated `it()` in request-snapshots — execute nowhere. They cover W4C-3b central approval classification, the bulk-reassign authorization matrix, fail-closed terminal/mutation guards, reassign-vs-decision serialization, and the real-PostgreSQL request-snapshot legs. Both files were introduced together on 2026-08-02 by `ce7ffe8ce8ee…` and were never wired: a ~6-day-old standing gap, not a regression from PR 4779/PR 4780 (whose new legs all landed in run-list-covered files). The guard conversion is what stops the *next* one (§3.4 G4). |
| **Model tier** | **sonnet5** for the rebase and re-pin; **opus5** for the exact-head gate — the derived-corpus guard is a judgement surface and its own mutation proofs were read, not re-run. |
| **Blocking condition** | Mechanical only, and **point-in-time**: at the 2026-08-08 second pass the head is `1448615c5aaf…` with `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`; an earlier pass saw head `40dfd4f3fb…` DIRTY/CONFLICTING on `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`. Re-read before acting. Then, separately, an owner merge ruling. |
| **Acceptance bar** | (1) The two suites appear in **both** the run-list and `test.exclude`, and the on-tree/in-list `comm` difference is empty. (2) The derived guard reds when a wiring point is removed — **re-run, not inherited**: any pre-rebase green is non-predictive because the guard derives its corpus from the tree, so a post-rebase tree with new or moved attendance suites can red it. (3) The 20 previously-unexecuted assertions actually **pass** against a real database — this has never been observed and must not be assumed. (4) **Determine explicitly whether the derived guard treats run-list-without-`test.exclude` as a violation.** If it does, the two W3 files identified as C′ in §3.2.5 (`attendance-shift-segments-migration.db.test.ts`, `attendance-shift-segments-writer-matrix.db.test.ts`) must be repaired in the same PR, or the guard scoped — otherwise PR 4805 reds for a reason unrelated to the orphans. The existing acceptance language ("new or moved attendance suites") does not name this case. (5) All nine required contexts re-run green post-rebase (`strict=true`). |
| **What this item does *not* close** | PR 4805's derived guard covers the `*.db.test.ts` class only. The `scripts/ops/attendance*.test.mjs` corpus — 48 files on main — has **no completeness guard of any kind**, and the derived guard does not extend to it. See §4.6 R6.6. |

**The consequent step that follows from the reclassification, and that no artifact on the line
currently carries.** Once the 20 assertions actually execute, **W4C-3b requires a re-verdict.** Its
slice completion was asserted on the strength of suites that had never run; wiring them can only
produce evidence *after* the fact, and that evidence has to be read before W4C-3b is treated as
complete. This is a distinct step from "PR 4805 merged".

**A §12.9 obligation audit that no artifact on the line performs.** §12.9 names **four**
obligations per new test — local collection, DB exclude/run-list wiring, workflow positive control,
and an exact mutation/failing leg. Only the second is inventoried anywhere on this line (here and in
the verification record). Whether the other three hold across all eight W4C slices is **not mapped by
any artifact**, and this document does not map them either — it records the gap. Sizing that audit is
itself work; it is filed at §4.6 R6.7.

#### R1.2 — PR 4804: W7/W8 design-lock drafts (docs-only, Draft/HOLD)

| Field | Value |
| --- | --- |
| **Scope** | Two new documents, zero runtime: `attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md` (+379) and `attendance-issue-4556-w8-verification-and-closeout-plan-20260807.md` (+397), both `PROPOSED / Draft / runtime HOLD`. Sizes re-derived at the current head `a1344c77…`; the earlier +377/+370 figures were read at the superseded head `e941eea9…`. |
| **Why next** | These are the artifacts the owner must read to rule on §5's W7/W8 rows. Until they are on main, the W7/W8 decision IDs exist only on a branch and are not conveniently rulable. |
| **Model tier** | **opus5** — docs whose entire value is design judgment and honest self-limitation. (Notable: the W7 draft's OD-W7-2 rejects option (b) while explicitly retracting one of its own arguments — "the fingerprint argument does **not** carry" — and cites the W5 precedent that contradicts it. That is the standard to hold.) |
| **Blocking condition** | Owner instruction to merge. The W7 draft's own authorization clause (`:13-20`) states it authorizes no merge "including the Draft/HOLD docs PR that carries it, which merges only on explicit owner instruction". *Mechanical state is a datum, not a blocker:* at the second pass `mergeable=MERGEABLE`, `mergeStateStatus=BEHIND` (base moved under `strict=true`, cleared by a rebase) — **not** BLOCKED, which an earlier pass recorded and which is retracted. |
| **Acceptance bar** | Exact-head independent review at the rebased head; nine required contexts green at that head; and — because both documents pin baseline `origin/main@4e6a35d99ea64291dd0588bbf5daa74dccec385b`, an ancestor of the current main — their internal `file:line` provenance re-verified against current main before merge. Those line citations were **not** re-verified here. |

#### R1.3 — PR 4810: FSER-4 §3–4 frontend surface wiring

| Field | Value |
| --- | --- |
| **Scope** | One strict parser (`attendanceFixedScheduleEffectiveness.ts`), one strict client (`useAttendanceFixedScheduleEffectiveness.ts`), four surface components (group drawer panel, self card, decision trace with `audience` discriminant, report widget), five mount points in `AttendanceView.vue`, four spec files, one `attendance-web-guard.yml` wiring change, 12 browser-evidence PNGs. +2,817/−2 across 24 files; **zero backend / `.cjs` files** (verified from the file list). |
| **Why next** | It completes the read-side of the fixed-schedule effectiveness line that W6's aggregate will compose (W6-R4: exactly one fixed-schedule effectiveness derivation). Landing it before W6-1 avoids a second derivation appearing in frontend code. |
| **Model tier** | **sonnet5** for the surface work (contract already fixed by the amendment); **opus5** for the gate — gates 6, 7 and 8 (exact-key rejection at any nesting depth, single-parser scan, mount-removal red/restore) are precisely the class where a naive assertion looks green against nothing. |
| **Blocking condition** | One real blocker, plus one datum. (a) *Datum, not a blocker:* at the second pass, head `4ca537c66bb00bede251cbabdcbdc7e730ec60f9` reports `mergeable=MERGEABLE`, `mergeStateStatus=**BEHIND**` — the base moved under `strict=true` and a rebase clears it. An earlier pass of this document recorded `BLOCKED` and elevated it into a named blocking condition; that is **retracted**. BEHIND and BLOCKED are not interchangeable. (b) **The actual blocker — a scope question for the owner** (§5.4 SQ-1): the PR's body cites RATIFY of `45d71c4209…` with `OD-4709-2=(a)` as its authority for §3–4, while the text of that same relay scopes itself to "**only** the section 7 prerequisite" and explicitly disclaims "the subsequent frontend slice". Whether a later owner authorization exists is **unverified** — see §5.4 for the exact surfaces read. |
| **Acceptance bar** | The amendment's §4 ten gates, with the frontend-owned ones re-executed at the final head rather than inherited: gate 6's forbidden-key legs **plus** its not-narrower positive control (an unrecognized-but-not-forbidden key must not fail closed); gate 7's scanner unit-tested against synthetic positive/negative strings before the real walk; gate 8's mount-removal red **and** restore-by-`cp`; gate 9's three viewports in a real browser. Plus the resolved scope question. |

#### R1.4 — Windows QA v2 harness: **an owner decision between two candidates, not a task**

> **Correction.** An earlier pass of this document reported that no PR existed for the Windows QA v2
> harness and prescribed opening one for the `claude/attendance-windows-qa-v2-0dc3596dd-20260806`
> branch. **PR 4745 exists** — "test(attendance): Windows native exact-SHA QA v2", OPEN, Draft, base
> `main`, head `043851d3db7bb8d4b4514af3b1354265f9b2cdf3`. That head **is the owner-frozen QA tooling
> SHA** quoted from the 2026-08-04 v2 freeze comment at §4.6 R6.3. At it, `check-runs` totals 16 and
> **every conclusion is `success`**, including all nine required contexts (`test (20.x)`,
> `test (18.x)`, the three `contracts` legs, `web-tests`, `integration-guard`,
> `attendance-web-guard`, `pr-validate`, `stock-prep PowerShell 5.1 acceptance`). Prescribing a new
> PR for the other branch would have created a **third** candidate and a second harness artifact for
> an owner-frozen deliverable, while reporting the frozen one as nonexistent.

| Field | Value |
| --- | --- |
| **The two candidates** | (i) **PR 4745** at `043851d3db7b…` — the owner-frozen QA tooling SHA, green on all nine required contexts. (ii) branch `claude/attendance-windows-qa-v2-0dc3596dd-20260806` at `7e531be6d6c8…` — 52 files, +11,104/−22, confined to `.github/workflows` (2 files, +616), `docker/`, `docs/deployment`, `docs/development`, `ecosystem.windows-native.config.cjs`, `scripts/attendance`, `scripts/ops`; no PR in any state, so 0 check-runs have ever executed at that head. |
| **They have diverged; this is not a fast-forward** | `git merge-base --is-ancestor 043851d3db7b… 7e531be6d6c8…` → rc=1 (**NOT an ancestor**); merge base `783eb72fe038…`. |
| **The candidates disagree about what is being tested** | `scripts/ops/attendance-windows-native-qa-v2.pin.json` on the branch declares `"expectedSourceSha": "0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b"`. The 2026-08-05 owner relay authorizes PQA-01..10 on the frozen **product** candidate `676ed2433813139216d77685021a5b5c1acdb235`. Adopting the branch therefore re-pins the campaign to a different product SHA than the one the relay names. |
| **The frozen-SHA constraint, stated because it has already bitten once** | The 2026-08-04 v2 freeze comment states that PQA-04/PQA-07 evidence "remains valid only for that old candidate and must not be transferred as PASS on v2". That rule voided the `66a98035…` evidence. On its own terms it would void v2 evidence too if the campaign moves to a third product SHA — restarting the clock a second time. |
| **What is owed to the owner** | The choice itself: **which harness is canonical** — PR 4745 at the owner-frozen tooling SHA `043851d3…`, or the divergent branch that re-pins the product candidate to `0dc3596dd…`? Filed at §5.3. This document does not resolve it and prescribes no PR. |
| **Model tier if and when the owner rules** | **fable5** to drive CI to a verdict; **opus5** to gate the workflow changes on whichever candidate is chosen — the branch carries a commit `c9e14d53a2` claiming to wire a package-verifier test into the required `test (20.x)` lane that has **never been executed by CI**, which is exactly the "green test against nothing" shape. |
| **Acceptance bar (either candidate)** | Nine required contexts green at the chosen head; the package-verifier wiring **observed executing** in a `test (20.x)` log, not merely present in YAML; the product-freeze diff re-proven with its three controls at that head; and an explicit statement of which product SHA the campaign is pinned to. |

#### R1.5 — W4C-5 read-only operator tooling and runbook completion (**open owner question; not startable on this document's say-so**)

> **Retraction.** An earlier pass of this document headed this item "**authorized; startable today**",
> called it "the one build item on the line that needs no new owner ruling to start", and set its
> blocking condition to "None to start". **All three statements are withdrawn.** They were the single
> affirmative start signal in the document, and they contradict its own §0.3 (which disclaims
> authorizing "any runtime slice, in any phase") and §6.2's standing not-authorized list. Two
> independent defects sat under them — one about authorization scope, one about evidence — and both
> are recorded below without being resolved here.

| Field | Value |
| --- | --- |
| **Scope, if and when the owner rules it startable** | Amendment §8 step 4 (`:184`): "Land read-only/tooling and runbook completion in a separate Draft/HOLD PR." Contents are fixed by amendment §5 (`:130-145`): a read-only status/plan command, a manifest validator/hasher, renderers, and a transition command that is **compiled but refuses execution** unless the §1–4 boundary is present and explicit owner/staging authorization inputs are supplied. Forbidden by the same section: direct rollout DML, a raw-SQL escape hatch, a wildcard org, an implicit `--yes`, a default target. |
| **Current state** | A scan of `origin/main` found **no** `w4c5`-named file under `scripts/` and no `w4c5` match in `scripts/` at all (`git ls-tree -r --name-only origin/main -- scripts \| grep -i w4c5` → empty; `git grep -li 'w4c5' origin/main -- scripts` → empty). Both negatives carry a positive control on the same constructs: the identical commands for `w4c3c` return 7 paths, and `scripts/` holds 627 paths overall, so neither command is silently reading nothing. The **non-docs source** matches for `w4c5` are the hardening code and its tests (`w4c0-identity.ts`, `w4c3a-rollout-control.ts`, `w4c3a-rollout-control-inventory.test.ts`, `attendance-w4c3a-rollout-control.db.test.ts`). *The unqualified "only" is withdrawn:* `git grep -li 'w4c5' origin/main -- . ':(exclude)docs'` returns **five** paths, the fifth being `pnpm-lock.yaml`. So: no W4C-5 operator tooling was found by this scan. If something exists under a different name, this item becomes "complete it" rather than "build it". |
| **Model tier if and when it starts** | **sonnet5** to build against the fixed §5 contract; **opus5** to gate — the load-bearing assertion is *zero-DML fail-closed in both plan and apply mode*, which is precisely the shape that passes vacuously if the test never reaches the DML site. |
| **Blocking condition — (a) an unresolved authorization-scope question, routed to the owner** | The 2026-08-05 relay's affirmative grant is narrow and names step 3 only: on issue 4556 (comment 2026-08-05T08:27:37Z) it reads verbatim *"PR 4747 exact merged SHA `2a2a5eee4f00abceff94ed6360e8c051708e35f7` is **RATIFIED** with `OD-W4C-61=(a)`. Its **core transition-boundary hardening** may start from fresh `main` as Draft/HOLD."* The same relay's not-authorized list reads *"no executable W4C-5 tooling"*. Whether amendment §8 **step 4** falls inside the grant or inside that exclusion is **not settled by any text this document can read**, and the two readings both have support: amendment §5 (`:136-138`) explicitly permits a transition command that is *"compiled but refuses execution"* as part of **preparation**, and §7(a) (`:170-171`) says hardening comes "before any executable W4C-5 transition tooling is **accepted**" — which reads as a sequencing rule, not a prohibition on building the refusing form; against that, §5 places the refusing command inside the tooling-preparation set that the relay's exclusion names. **This document adopts neither reading and asserts nothing about which is right.** Filed as SQ-6 in §5.4. |
| **Blocking condition — (b) evidence residuals at the merged head, independent of (a)** | Even on the permissive reading of (a), the gate that would make the runbook executable is **not recorded as met**. Runbook §8 gate 1 (`:152-162`) requires that "transition hardening passes an exact-head real-PostgreSQL/race/mutation review", and amendment §8 step 3 (`:182-183`) requires the hardening to land "after a real PostgreSQL and concurrency gate". **No such exact-head verdict is recorded for the merged squash `3601817969…`** (§3.4 G6). PR 4773's own body grades amendment §6 gate-by-gate and reports three cells short of clean — reproduced verbatim below. So the honest state is not "gate 1 clear" but "**gate 1 unrecorded at the merged head; §6 gates 5 and 6 self-reported Partial; gate 10 out of scope**". |
| **Acceptance bar if it starts** | Amendment §6's ten hardening gates as the reference bar, and for the tooling specifically: plan mode proven to issue zero DML (by observation at the connection, not by reading the code); apply mode proven hard-blocked without exact owner/staging authorization **and** an expected state/version; a repository inventory proving no second transition-DML site exists; exact-key event evidence requiring the manifest hash plus a correlation ID and rejecting secrets. Landing this tooling authorizes no staging action — runbook §8 still requires three further gates plus the owner campaign packet. |

**Amendment §6 gate residuals, quoted from PR 4773's own body** (self-reported by the implementing
lane; **not** an independent verdict, and not re-derived here):

| §6 gate | Self-reported status | Named residual |
| --- | --- | --- |
| 5 — each §3 predicate has positive / negative / remove-the-predicate legs on real PostgreSQL | **"Partial → improved"** | "remove-the-predicate is a manual mutation cycle for the original 5 predicates"; only the staleness-version half, gate 9's three bypass syntaxes, and the resume operation-rows predicate became permanent CI-run tests |
| 6 — two-connection races cover request snapshot, review, operation, retryable job, legacy batch, suspend, resume | **"RETRACTED as originally graded (P1-2) → now genuinely Partial"** | "Still not raced live: legacy-batch-closure and resume's operation-rows predicate" (both real-DB positive/negative tested, not raced) |
| 10 — tool plan mode zero DML; apply mode hard-blocked | **"Out of scope"** | "no tool exists in this PR; deferred to the separately authorized, separately gated tooling PR (amendment §8 step 4)" |

Gate 10's own wording is worth noting for question (a): PR 4773's body calls the step-4 tooling PR
"separately authorized", which is consistent with the exclusion reading — but a PR body is the
implementing lane's own characterisation, not an owner ruling, and is recorded here as such.

#### R1.6 — author the W4 verification MD covering W4C-2 … W4C-5 (**a ratified W4 completion condition with no artifact**)

| Field | Value |
| --- | --- |
| **The gap** | `git ls-tree -r --name-only origin/main -- docs/development \| grep -i 'attendance-issue-4556.*verification'` returns **exactly four** files: W1 (`…-w1-effective-group-membership-development-verification-20260723.md`), W2–W3 (`…-w2-w3-development-verification-20260724.md`), W4 (`…-w4-development-verification-20260726.md`), and W5 (`…-w5-flex-single-segment-development-verification-20260804.md`). **There is no verification MD on main covering W4C-2, W4C-3a, W4C-3b, W4C-3c, W4C-4 or W4C-5.** The one named "W4" is dated 2026-07-26 — authored *before* the W4C-2 runtime merged on 2026-07-29 under PR 4670 — so it cannot cover it. |
| **Why this is a completion condition, not a nice-to-have** | W4 lock §15 (`:3125-3126`) lists among W4's own completion items: "verification MD records exact SHAs, runs, real-DB evidence, mutations, rollout state, and honest residuals". That is a **W4** condition, distinct from the parent §9.9 / W8 obligation — different lock, different scope. W8 is not a substitute for it. |
| **Scope** | One document covering W4C-2 through W4C-5 to the §15 standard: exact SHAs, the runs and job IDs that executed each slice's suites, real-DB evidence, the mutation legs, rollout state, and honest residuals — explicitly including the §6 W4C-5 gate residuals recorded at R1.5 and the W4C-3b skip-green repair from R1.1. |
| **Model tier** | **opus5** — a verification MD is a claim surface, and this one has to record residuals that the implementing lanes reported about themselves. |
| **Blocking condition** | **None.** It is unowned, not blocked. Its content is *better* after R1.1 lands (the W4C-3b evidence would then exist rather than being recorded as absent), but it is not gated on it. |
| **Closure coupling** | W4 lock §14 item 10 (`:3103-3104`) reads "Production enablement and issue closure require separate final decisions **after verification MD is on main**". On its own words, **closure cannot be ruled on until this document exists.** Recorded so the owner sees the coupling; this document does not rule on closure and nothing here triggers it. |
| **Acceptance bar** | Every claim carries the command or job ID that produced it; every absolute is mechanically derived or hedged; residuals are stated as residuals rather than omitted; and the completion claim stops at "code landed, gates green" per the standard the W6 lock sets at `:291-292`. |

---

### 4.2 (ii) W6 — the group effective-policy workspace

All four slices share one blocking condition and it is not partially satisfiable.

> **Read every scope bullet in §4.2 in the subjunctive.** The W6 rows describe what each slice
> *would* build **if** the owner picks the recommended option. They are not settled scope. The W6
> lock's own §9 (`:306-309`) reads: "`OD-W6-0` (adopt this lock) and `OD-W6-1..9` are **OPEN**. This
> document carries no default", and §5.1 below lists all ten as open. Wherever a bullet names an
> endpoint, a union, a derivation rule or a gate, it is naming **option (a) of an open OD**, not a
> decision. (This is the same marker the W7 row carries at the end of its scope paragraph; it was
> missing here, so a W6 bullet lifted out of this section read as settled.)

> **Common blocker (W6-GATE).** Owner RATIFY of the exact merged SHA of the W6 lock —
> `2967da018ceea41b91098e14d4c15a57236eb5f8` — **and** answers to OD-W6-1..9. The lock's landing
> step 2 requires both (`:294-304`); §9 states "This document carries no default: absent owner
> RATIFY, W6 remains preparation-only" (`:306-309`). The 2026-08-05 owner relay authorized W6
> *preparation only* and named "no W6 runtime" in its not-authorized list; it does not mention
> `2967da018` and answers no OD-W6-x. **W6-GATE is open.**

#### R2.1 — W6-1 backend aggregate

- **Scope (all per the W6 lock's OD menu, all OPEN).** `GET /api/attendance/groups/:groupId/effective-policy` (per OD-W6-1(a)) returning the
  `AttendanceGroupEffectivePolicyAggregateV1` shape already fixed at
  `w6-group-effective-policy-contract.ts:167`: per-domain summaries with the five-value source label,
  the conflict list from the seven-code closed set, `preview_only` derivation for segments/flex, the
  FSER effectiveness object embedded verbatim for `fixed_shift` groups, and an `editorRef` per row.
- **Why next.** It is step 3 of the lock's own sequence and everything else in W6 depends on its
  response shape. It is also the first slice on the line whose whole job is to *explain* the W1–W5
  machinery to a human — parent lock closure condition 8.
- **Model tier.** **sonnet5** to implement against the frozen contract; **opus5** for the gate, with
  specific attention to W6-R3 (authorization before *every* aggregate SQL) and W6-R4 (compose the
  FSER service; no second predicate, no cache).
- **Acceptance bar.** Read-only proven (W6-R1: zero write side effects); values-free at member level
  (W6-R2) proven by exact-key rejection, not by inspection; one byte-identical 404 across missing
  group / missing-or-inactive org membership / non-membership; enum-strict fail-closed on unknown
  labels/domains/conflict codes with a remove-the-predicate leg per authorization predicate; the
  membership-overlap query inside whatever cost envelope OD-W6-8 selects; and a proof that no
  calculation writer consumes the aggregate (W6-R5).

#### R2.2 — W6-2 contract wiring

- **Scope (all per the W6 lock's OD menu, all OPEN).** Promote `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` into
  the generated contract surface and regenerate.
- **Why next.** Step 4; the UI must consume generated types, not hand-written ones.
- **Model tier.** **sonnet5**; **opus5** only if the promotion changes the shape.
- **Acceptance bar.** `contracts (openapi)`, `contracts (strict)` and `contracts (dashboard)` green
  with a clean generated diff; and — because `drafts/` may or may not be read by the current build —
  an explicit determination of whether the draft was previously inert or merely unwired (currently
  **unverified**, §2.9).

#### R2.3 — W6-3 UI

- **Scope (all per the W6 lock's OD menu, all OPEN).** Mount `AttendanceGroupEffectivePolicyPanel.vue` inside the existing four-stage group
  workspace behind the OD-W6-7 gate (org opt-in + env gate, default OFF), with label mapping and
  `editorRef` resolution in a standalone `.ts` module per lock §5.5 — not in the SFC. Editor
  navigation reuses the issue-4711 closed route family (W6-R8), which is fully on main: lock PR 4713
  → `8806e9679e3e7a19ba57d310f799c2962dd01680`, PR 4726, PR 4729 (introducing
  `AttendanceGroupContextHost.vue`, `attendanceGroupRouteHydration.ts`,
  `useAttendanceGroupRouteContext.ts`), PR 4733.
- **Why next.** Step 5; it is the surface parent lock closure condition 8 actually names.
- **Model tier.** **sonnet5** implement; **opus5** gate the default-OFF proof.
- **Acceptance bar.** `disabled = byte-identical` (the OD-W6-7(a) acceptance shape): with the gate
  off, the rendered output is byte-identical to today's. Labels derive only from persisted config +
  org rollout posture, never from client hints (W6-R7). Real-browser verification at three
  viewports — jsdom does not settle CSS questions on this line.

#### R2.4 — W6-4 verification MD

- **Scope.** The verification record closing the W6 code scope.
- **Model tier.** **opus5** — a verification MD is a claim surface.
- **Acceptance bar.** The lock caps the claim itself: "W6 completion claims stop at 'code landed,
  gates green'; enablement, staging, soak, and issue-4556 closure remain separately owner-gated"
  (`:291-292`). A W6-4 that claims more than that is defective regardless of how green it is.

---

### 4.3 (iii) W7 — group policy calculation cutover

- **Scope.** Change which policy source feeds authoritative accounting for an org: a dedicated
  in-transaction resolver over persisted facts (W1 membership, group row, FSER-composed schedule
  facts) under the existing lock order; frozen-context `schemaVersion: 2` with a discriminated
  `selector: 'legacy' | 'group_effective'`; a **second** org-keyed state machine for context source
  (`off ↔ group_shadow ↔ group_eligible → group_authoritative ↔ suspended`) cloning the hardened
  boundary pattern rather than extending the W4 machine; all source entrypoints flipping atomically
  per org; first org = the named synthetic staging org only. (All per the W7 draft's OD menu, all
  **OPEN**.)
- **Why next in the order.** Parent §9.8, and the W7 draft's §8 item 1 makes it a hard precondition:
  W6 owner sign-off and W6 runtime completion come first. W7 is also the first slice since W4C-3
  whose risk class is "changes which producer writes authoritative history" — the draft classifies it
  as *same risk class as the W4C-3 cutover arc* and inherits every house rule from it.
- **Model tier.** **opus5** for the lock ratification review, the resolver contract, and every gate;
  **sonnet5** for slice implementation once OD-W7-1..8 are answered; **fable5** for the real-DB race
  and soak-adjacent evidence runs.
- **Blocking condition.** Three, in order: (1) W6-GATE answered and W6 runtime complete; (2) PR 4804
  merged so the W7 lock exists on main; (3) owner sign-off of that lock's exact merged SHA plus
  answers to OD-W7-0..8. Nothing about W7 is startable today.
- **Acceptance bar.** Per the draft's §8 skeleton: W7-0 byte-inert contract/fixtures; W7-1 resolver +
  frozen-context v2 where v1 stays valid and immutable with untouched golden bytes and the calculator
  accepts exactly {v1-legacy, v2-either} and fail-closes otherwise; W7-2 `group_shadow` + compare
  machinery + expected-differences roster; W7-3 cutover transitions + drills on synthetic staging
  only; W7-4 verification MD feeding W8. Plus the inherited W4C-3 rules: fresh-`main` PRs, 0 P1/P2
  independent gate, exact-head tests with mutation legs, real-DB two-connection races, no org enabled.

---

### 4.4 (iv) W8 — verification execution and the closure input

- **Scope.** Execute the verification matrix on one named head SHA; run soak entry/exit per topology;
  reconcile every parked debt with an explicit disposition; produce the closure checklist that feeds
  the owner's ruling.
- **Why last.** Parent §9.9. The W8 draft is unusually clear about its own status: "**Closure is an
  owner ruling, never automatic** … Nothing in this plan — no green matrix, no completed soak, no
  empty ledger — closes the issue or triggers closure. W8's entire output is *evidence for* that
  ruling."
- **Model tier.** **opus5** for the matrix design, the ledger dispositions, and the closure-checklist
  authoring; **fable5** for the seven-day observation runs and daily evidence collection;
  **sonnet5** for any tooling gaps found mid-execution.
- **Blocking condition.** W7 gates complete (which requires W6 sign-off and W6 runtime), the W8 plan
  ratified, and — separately, before any staging touch — the W4C-5 soak authorization packet.
- **Acceptance bar.** Parent lock §10's eight closure conditions each mapped to a merged slice or an
  explicit owner removal:
  1. every acceptance item mapped to a merged slice or explicitly removed by owner decision;
  2. multi-segment actual minutes exclude breaks and expose segment anomalies;
  3. flex behavior distinct from grace;
  4. calculation-group changes effective-dated and historically explainable;
  5. all work-date entry points use the shared resolver;
  6. OpenAPI, runtime, frontend, migrations and tests agree — **note**: this condition does have a
     standing main-branch evidence source, contrary to what an earlier pass implied. The
     `contracts` family runs nightly on `main` via `attendance-gate-contract-matrix.yml`'s
     `schedule: cron '45 4 * * *'`, with eight consecutive `main` runs all `success` (§7.7). What is
     absent is a run **at an issue-4556 head**, not a run at all;
  7. staging migration, rollback and synthetic accounting evidence are durable;
  8. the user-facing group workflow shows what is effective, inherited, preview-only, or conflicting.

  Conditions 3, 4 and 5 are plausibly already satisfied by W5, W1 and W2 respectively; that mapping
  is **unverified** here and is exactly W8's job to establish, not to assume.

#### The soak, stated once

The seven-day synthetic soak is a distinct owner-gated action, not a W8 sub-task. Its nearest
dependency is R1.5 (the read-only operator tooling), **which is itself blocked on the open
authorization question SQ-6 and on unrecorded exact-head evidence** — see R1.5. Nothing in this
section states that R1.5 may start. Its entry conditions are already fixed by W4 lock §12.8
(`:3000-3031`) and the W4C-5 amendment §3/§4:

- **Owner packet** (runbook `:25-40`): exact synthetic org ID; exact 40-character deployed backend
  **and** web image SHAs; authorized first target (`shadow` only for a new campaign); approved start
  timestamp and minimum seven calendar-day window; confirmation the data is synthetic and externally
  isolated; confirmation external notifications and destinations are disabled; authorization limited
  to the named org/image/campaign; explicit exclusions for production, customer data, release tags
  and issue closure. "An old campaign, old image, agent-authored approval, or broad 'continue' does
  not satisfy this packet."
- **Preflight** (runbook `:67-86`): staging status showing exact image SHAs, pending migrations 0,
  healthy services — "Status failure or ambiguity stops the campaign without any repair, restart,
  deployment, or flag change" — then a plan-mode PASS. "Plan output never authorizes apply."
- **Daily acceptance** (runbook `:104-123`): exact image and tool SHAs unchanged; services healthy,
  migrations pending 0; zero critical shadow codes; zero unresolved review items; zero external
  notification/destination attempts; no unknown entrypoint/reason/posture/schema; residue accounted
  for. "A failed day is recorded, not rerun into disappearance. Repair, image change, or contract
  change ends the campaign."
- **Exit** (runbook `:125-150`): reversal, suspend/resume, offline-replay and pointer/hash drills,
  each separately recorded; cleanup only via canonical reversal/retirement paths from the P16
  inventory; residue report showing zero campaign-owned live data. The final summary "may state only
  'internal synthetic W4C-5 soak evidence PASS' … It must not state customer UAT, production
  acceptance, deployment approval, release readiness, or issue closure."
- **Five gates before the runbook is even executable** (runbook `:152-162`): transition hardening
  passes an exact-head real-PostgreSQL/race/mutation review; tool plan/apply tests prove zero-DML
  fail-closed behavior; the staging workflow/package contains the exact reviewed tools; the owner
  separately authorizes the exact campaign packet; a final read-only boundary audit confirms no
  staging action occurred during preparation.

#### R4.1 — root-cause the deploy-environment red (a **soak-entry blocker**, not a footnote)

This item exists because §7.7's environment red is not informational once the soak is in view, and no
prior pass of this document assigned it an owner or a tier.

| Field | Value |
| --- | --- |
| **What is red** | At the pinned head, five distinct non-required check names conclude `failure`: `strict-gates`, `deploy`, `smoke`, `perf`, and `verify-main` (§7.7 carries the enumeration and its command). `attendance-strict-gates-prod.yml` run 31238058092 reports `failed=apiSmoke,playwrightProd,playwrightDesktop reasons=apiSmoke=AUTH_FAILED playwrightProd=TIMEOUT playwrightDesktop=TIMEOUT`, preceded by "No valid attendance admin token". |
| **Why it is on the soak critical path** | The runbook's preflight (`:67-86`) requires "staging status showing exact image SHAs, pending migrations 0, healthy services" and states that "**Status failure or ambiguity stops the campaign without any repair, restart, deployment, or flag change.**" On today's evidence the campaign's *first* gate would stop. |
| **Why it cannot be deferred into the campaign** | The same clause forbids repairing it *during* a campaign. Any repair therefore has to happen **before** a packet is authorized, or the packet is authorizing a campaign that is already going to stop. |
| **Ordering consequence** | It sits alongside R1.5 on the soak critical path, not after W8. |
| **Model tier** | **fable5** to collect run/host evidence across the failing workflows; **opus5** to classify — the signature (auth + timeout against the deploy host) *looks* environmental, but "looks environmental" is a classification, not a root cause, and this document explicitly did not root-cause it. |
| **Blocking condition** | None technical. Unowned, not blocked. Note that none of the five names is among the nine required contexts, which is exactly why it has gone unnoticed: no merge is blocked by it. |
| **Acceptance bar** | A named root cause (token / deployment / host) with evidence, **or** an explicit owner-accepted statement that the deploy environment is out of scope for this line — in which case the runbook's preflight gate needs an owner ruling on how it is to be satisfied at all. |

---

### 4.5 (v) FSER-4 line closure (after R1.3 lands)

The frontend slice itself is R1.3 — it is already in flight as PR 4810, so it is not a separate
future build. What remains *after* it lands:

- **Scope.** The FSER-4 verification record; the disposition of OD-W8-5 (whether FSER-4 §3–4 is
  tracked under issue 4709 outside the issue-4556 closure set, or pulled into it); and updating the
  amendment's `Status:` header, which still reads `PROPOSED / runtime HOLD` on main despite the
  2026-08-05 relay (§3.4 G2).
- **Model tier.** **opus5** — all three are claim/scope surfaces.
- **Blocking condition.** R1.3 merged under an owner ruling; OD-W8-5 answered.
- **Acceptance bar.** The completion claim stops at "code landed, gates green"; the amendment's §5
  non-scope (no flag, deployment, staging, production/customer data, or issue closure) restated
  rather than quietly dropped.

---

### 4.6 (vi) Deferred debt

#### R6.1 — issue 4791 (scratch-DB teardown flake on a required check)

**CLOSED / COMPLETED** 2026-08-07T15:44:55Z. Root cause: `DROP DATABASE … WITH (FORCE)` in
scratch-DB teardown terminated live backends, and node-postgres surfaces `pg_terminate_backend` as a
Client/Pool `'error'` **event** — not an in-flight query rejection — so a `.catch()` could not see
it; node treated it as uncaught, vitest reported `Errors: N`, and every test passed while the
process exited 1, intermittently redding the required `test` check for any PR. Fix: PR 4799 merged
2026-08-07T15:18:34Z. The closure criterion was deliberately *not* "CI went green" but "the
unconditional drain line reports CLEAN on a main required gate", and that criterion was independently
re-derived: run 31191954460 (`event=push`, `head_sha=51c3d872…`), job 92910698439 `test (20.x)` =
success, log carrying `scratchDrain=CLEAN suite=bpmn-poller-disabled drainMs=66 residualBackends=0`
and `scratchDrain=CLEAN suite=w4c2-sweep-call-through drainMs=74 residualBackends=0`, with
`scratchDrain=FORCED` count 0, `57P01` count 0, `Unhandled Errors` count 0; and again on the next
main push (run 31196449251). The instrumentation is real code
(`packages/core-backend/tests/helpers/scratch-database.ts:368/381/395`) and its guard
`tests/integration/scratch-database-drain.db.test.ts` is in the required run-list
(`plugin-tests.yml:1305`).

**Residual work:** only the `test (18.x)` leg is unverified (the third CLEAN line cited by the
closure comment was not read), and OD-W8-3 still asks the owner to record the disposition formally.

#### R6.2 — issue 4792 (malformed `timeCycle` residue)

**OPEN**, created 2026-08-06, **no fix PR** — the only PR referencing it is the docs-only HOLD PR 4804. Shape: `BPMNWorkflowEngine.startProcess` persists the process + activity, then
`scheduleRecurringTimer` feeds a raw ISO-8601 `<bpmn:timeCycle>` (e.g. `R/PT1M`) to node-cron, which
throws; `startProcess` 500s and leaves `bpmn_process_instances` ACTIVE plus `bpmn_incidents` OPEN
with 0 timer rows. The cycle branch returns before the poller-flag check, so PR 4783's zero-write
entry gate does not cover it.

- **Model tier.** **sonnet5** for the fix (validate the cycle expression before any persistence, or
  make the whole entry transactional); **opus5** to gate, because the interesting assertion is a
  *residue* assertion and residue assertions are easy to write vacuously.
- **Blocking condition.** None technical; it is unowned, not blocked.
- **Acceptance bar.** A real-DB leg proving that a malformed `timeCycle` leaves zero
  `bpmn_process_instances` and zero `bpmn_incidents` rows, with a positive control proving a
  well-formed cycle still creates its timer.

#### R6.3 — the Windows PQA matrix (issue 4629)

**OPEN**; every one of PQA-01..PQA-10 in the issue body is an unchecked `- [ ]`. Fifteen comments,
most recent 2026-08-05T08:27:18Z.

Two cases have ever reached PASS with real Windows-host evidence — PQA-07 authorization isolation
(posted 2026-07-28T00:26:28Z, owner-accepted 2026-07-28T01:49:53Z) and PQA-04 legacy compatibility
(posted 2026-07-28T01:58:12Z, independently reviewed 2026-07-28T18:48:44Z) — both against the **old**
frozen preview candidate `66a980357078f9d243fd4b025b080ac9aca9fa21`. The 2026-08-04T13:12:02Z comment
froze a v2 candidate (product SHA `676ed2433813139216d77685021a5b5c1acdb235`, QA tooling SHA
`043851d3db7bb8d4b4514af3b1354265f9b2cdf3`) and states verbatim: "Previous PQA-04/PQA-07 evidence
remains valid only for that old candidate and must not be transferred as PASS on v2", with state
"PACKAGE/RUNTIME LIFECYCLE VERIFIED — PQA-01..10 NOT STARTED".

**Provenance of the two PASSes, recorded because it is an independent reason not to transfer them.**
`66a980357078…` is the head of **still-open Draft PR 4634** ("feat(attendance): add Windows-native
internal QA package"), whose base is **PR 4630** (`codex/attendance-onprem-package-workspace-deps-20260727`,
OPEN Draft, `mergeStateStatus=DIRTY`), whose own base is `claude/w4c2-live-scheduled-shadow-20260725`
— PR 4612's abandoned DO-NOT-MERGE branch. Because that chain never targeted `main`, **only 2 of the
9 required contexts have ever run on it**: `pr-validate` and `attendance-web-guard`, both `SUCCESS`
(re-derived via `gh pr view 4634 --json statusCheckRollup`). So the line's only two PQA PASSes were
produced on an un-gated stacked chain rooted at a branch that was never merged, and both PRs in the
chain are still open. This is separate from, and additional to, the v2 freeze rule.

**What the frozen v2 product candidate excludes — the decisive input to OD-W8-4, and absent from
every prior pass.** `676ed2433813139216d77685021a5b5c1acdb235` is PR 4733's squash
("feat(attendance): wire group route entry points", 2026-08-04). Re-derived with
`git merge-base --is-ancestor <slice-sha> 676ed2433813…` (rc=1 for each): **five landed slices of
this very line are NOT in it** —

| Slice | Squash SHA | In `676ed243…`? |
| --- | --- | --- |
| W5 single-segment flex (PR 4748) | `7da5d9e55b0f7c9b0a6ca471d38c3aa0115037ab` | **no** |
| W6 preparation (PR 4771) | `2967da018ceea41b91098e14d4c15a57236eb5f8` | **no** |
| FSER-4 server prerequisite (PR 4772) | `ce17ed321752d3adb96569f15a102c8986f303da` | **no** |
| W4C-5 transition hardening (PR 4773) | `3601817969affd06d8eed9ee8f359b6195b774b4` | **no** |
| W4C-5 8-cell closed set (PR 4780) | `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b` | **no** |

Consequence the owner needs before ruling OD-W8-4: **even a clean 10/10 PQA v2 pass evidences a
product tree missing five landed slices of issue 4556.** And the same "must not be transferred as
PASS" rule that voided the `66a98035…` evidence would, on its own terms, void v2 evidence at any W8
head. That is the trade-off inside OD-W8-4 option (b) ("complete 4629 as-is first").

**Net position:** zero PQA cases have reached PASS on the current v2 candidate; PQA-01/02/03/05/06/
08/09/10 have never reached PASS on any candidate. What is proven for v2 is package/runtime lifecycle
only (build-package PASS, verify-windows-native PASS on a native Windows runner, no-WSL assertion,
isolated PostgreSQL migrate/start/health/stop, failed-start PM2 cleanup) — and the v2 comment itself
says these "do not satisfy the product matrix".

- **Model tier.** **fable5** to drive the ten cases and collect host evidence; **opus5** to gate each
  result comment against its case definition (this matrix is manual, so the gate is the only thing
  standing between "I ran something on Windows" and "PQA-05 passed").
- **Blocking condition.** The 2026-08-05 owner relay authorizes PQA-01..10 on the frozen `676ed243…`
  candidate using synthetic data and the isolated `metasheet_windows_qa` database. Not blocked —
  unexecuted. Its harness dependency is R1.4, which is now an **owner choice between two diverged
  candidates** (PR 4745 at the frozen tooling SHA vs. the branch that re-pins the product candidate),
  not a task to open a PR.
- **Acceptance bar.** Per case: real Windows-host evidence at the v2 candidate SHA, synthetic data
  only, independent review of each result comment, and an explicit statement that no PASS is
  transferred from the `66a98035…` candidate. OD-W8-4 asks whether to instead author `PQA-W8-*`
  against the W8 head and retire this checklist by owner note.

#### R6.4 — soak-precondition issue bookkeeping (4770, 4775)

Both are **OPEN** with **zero comments**, and both bodies call themselves a "hard prerequisite for
actual W4C-5 staging/soak".

- **issue 4770** (sweep starvation + zero observability): PR 4774 merged 2026-08-05T16:48:20Z and
  PR 4779 merged 2026-08-06T09:54:55Z. Its four named gates map to real legs in run-list-covered
  files: gate 1 at `attendance-w4c2-sweep-fairness.db.test.ts:235` ("durable rotation over a >25
  persistently-blocked backlog"); gate 3 at `:373` (values-free tick observability — closed
  all-numeric key set, warn `tick_errors`, silent default); call-through legs 1–4 at
  `attendance-w4c2-sweep-call-through.db.test.ts:376/418/444/532`. **Gate 2 is the exception**: the
  PR body itself reports it as "PASS (hand-verified, not automated as a permanent CI leg)", so a
  future regression to the fixed `ORDER BY created_at ASC LIMIT 25` prefix would be caught by no
  standing gate.
- **issue 4775** (W4C-5 §3 request-snapshot 8-cell closed set): PR 4780 merged 2026-08-06T11:45:34Z.
  The closed set is mechanically closed (§2.5) and its legs execute in the required gate; RACE F, G,
  H, I, J, K two-connection legs are present in `attendance-w4c3a-rollout-control.db.test.ts`, which
  is in the run-list.

**The bookkeeping gap:** merged-PR titles ("complete the 8-cell closed set") are not a discharge.
Neither issue records an owner discharge, a closure criterion, or what remains. On the available
evidence the W4C-5 staging/soak precondition is **not formally discharged**, whatever the code says.

- **Model tier.** **opus5** — the work is writing an honest discharge statement (or an honest "still
  open because X"), which is a claim surface.
- **Acceptance bar.** Each issue carries either a closure with a stated criterion and its evidence,
  or a named remaining item. For 4770, gate 2 either gets a permanent CI leg or its absence is
  recorded as an accepted residual.

#### R6.5 — documentation debt

Three cheap, real items:

1. **Doc-header lag (§3.4 G2).** **Nine** amendment headers read `PROPOSED` on main, of which two are
   already named in §5.2 as decided-but-stale. The sweep is therefore sized at **seven further files**,
   not two — enumerated with the exact pathspec under §3.4. Correcting them is a docs PR; leaving them
   is a trap for the next reader. Per-ID ratification status is at §5.2, so the repair is mechanical
   rather than judgemental for the IDs recorded there.
2. **W4C-2 provenance (§2.4).** The erratum PR 4637 records the force-push, but the fact that the
   runtime landed under PR 4670 rather than PR 4612, and under a `test(attendance):` prefix, is not
   reflected in any phase ledger.
3. **The `[HOLD]` squash-loss (§3.4 G3).** Anyone auditing hold posture from `git log` on main alone
   will understate it. Worth one sentence in the line's ledger.

#### R6.6 — the `scripts/ops/attendance*.test.mjs` corpus has no completeness guard at all

`git ls-tree -r --name-only origin/main -- scripts/ops | grep -cE 'attendance.*\.test\.mjs$'` → **48**
files. Neither of the two completeness guards on this line covers them: the plugin-integration-core
chain guard is scoped to that plugin's suites, and PR 4805's proposed derived-corpus guard is scoped
to attendance `*.db.test.ts`. A name-reference sweep (`git grep -l -F <basename> origin/main --
.github/workflows package.json scripts`, excluding self-matches) finds **22 of the 48** referenced
nowhere executable — for example `attendance-check-metrics.test.mjs`,
`attendance-onprem-package-verify-migrations.test.mjs`, `attendance-locale-zh-workflow-contract.test.mjs`,
and six `staging-attendance-*-smoke.test.mjs`.

**Caveat stated deliberately, because it changes the severity:** **none of the 22 are issue-4556 slice
suites.** The 4556-relevant members of this corpus — the W4C-0 DML collector, the W4C-2 CI wiring
guard, the W1 contract test, and the 4556 OpenAPI parity test — are all wired. And no workflow uses a
`scripts/ops/*` glob that could sweep them up (`git grep -nE 'scripts/ops/\*' -- .github/workflows` →
empty). **This is a class-level gap, not a 4556 coverage hole.** It is recorded because the class is
precisely the one that produced the W4C-3b orphans, and because R1.1's guard closes the
`*.db.test.ts` class only — the ops-suite class would still admit the next orphan.

- **Model tier.** **sonnet5** to build a guard; **opus5** to design its corpus definition, because a
  completeness guard whose corpus is narrower than the class is §3.4 G4 rebuilt.
- **Blocking condition.** None. Unowned, not blocked.
- **Acceptance bar.** The guard derives its corpus from the tree (never a handwritten list), carries a
  negative control proving it reds on a synthetic unwired file, and states explicitly which files it
  deliberately exempts and why.

#### R6.7 — map W4 lock §12.9's other three obligations across the eight W4C slices

§12.9 (`:3033`, text `:3035-3037`) names **four** per-slice obligations: local collection, DB
exclude/run-list wiring, workflow positive control, and an exact mutation/failing leg. Only the
second is inventoried anywhere on this line. **No artifact on the line maps the other three**, and
this document does not map them either — R1.1 records the gap, and this item is where the mapping
work would live.

- **Model tier.** **opus5** — the question is "does this evidence exist", which is the class where an
  over-strong answer is the failure.
- **Blocking condition.** None. Unowned, not blocked. Best sequenced with R1.6 (the W4 verification
  MD), since its output is exactly what §15 asks that document to record.
- **Acceptance bar.** A per-slice × per-obligation table where every cell is either a named executing
  leg with a job ID, or an honest "absent". A cell filled by inference is worse than an empty one.

#### R6.8 — issue 4616: a two-way disposition that has been due since 2026-07-29

Issue 4616 ("attendance: scheduled 结果是否需要 per-record 粒度事件（(b2) 之后重估）", **OPEN**,
references issue 4556 and issue 4612) appears in no prior pass of this document. Its body sets an
explicit, executable two-way disposition:

> 处置条件（二选一，待 (b2) amendment 落地后执行）— **关闭**：若届时无任何具名的 per-record 粒度消费需求
> （当前全仓订阅方为零，故默认倾向关闭）; **保留并改写**：若存在具名需求…

The `(b2)` amendment landed (`attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md`
is on main and the W4C-2 runtime shipped under it on 2026-07-29), so the condition has been executable
since then and nobody has executed it. The issue also carries a standing prohibition —
「不得在 (b2) 之前以本票为由实现任何 per-record 事件」— which bears on W7's event surface.

The close-vs-rewrite choice is put to the owner at §5.4 SQ-7. **This document does not close it and
takes no position**; recording that a disposition is due is not performing it.

#### R6.9 — issue 4641: a defect produced by one of the line's only two PQA PASSes

Issue 4641 ("test(attendance): temporary MetaSheetServer stop leaves scheduler process alive after
PQA-07", **OPEN**, **0 comments**, created 2026-07-28) appears in no prior pass of this document. It
was produced *by* the PQA-07 run that R6.3 cites as one of only two PASSes on this line, and it names
its own acceptance targets: "Add a positive shutdown test proving the process has no remaining
server-owned timer/listener handles… a discriminating regression that fails if the scheduler continues
to query after pool shutdown."

- **The stale-candidate caveat.** It is frozen to candidate `66a980357078f9d243fd4b025b080ac9aca9fa21`
  and artifact `attendance-onprem-package-30243591566-1` — the candidate the v2 freeze already
  declared must not be transferred, and (per R6.3) the head of an un-gated stacked chain. **Its
  reproduction identity therefore has to be re-frozen before it can be worked**, which couples its
  disposition to OD-W8-4.
- **Model tier.** **sonnet5** for the shutdown test; **opus5** to gate it — "no remaining handles" is
  a residue assertion, and residue assertions are easy to write vacuously.
- **Blocking condition.** Unowned. Technically blocked only on re-freezing a reproduction identity.
- **Acceptance bar.** The discriminating regression its body names, plus a positive control proving
  the test can fail.

---

## 5. Open owner decisions — one table to rule from

### 5.1 Still open

**Anchor provenance for this table, because two anchor sets were wrong in an earlier pass.** The
nine W6 anchors are against the W6 lock blob at exact merged SHA
`2967da018ceea41b91098e14d4c15a57236eb5f8`, re-derived by `grep -nE '^\| OD-W6-[0-9]'`: OD-W6-1 is at
`:238` and OD-W6-9 at `:246`. An earlier pass cited `:236`…`:244`, which are the decision-table
**header row** and **markdown separator** plus a two-line offset on every row — a reader following the
old `:244` for OD-W6-9 landed on OD-W6-7. §7.2's *range* `236-246` was correct throughout, which is
what made the per-row error easy to miss. The W7 and W8 anchors are against PR 4804's **current** head
`a1344c77c09725b757b5e9408b501e433bc3d385`, not the superseded `e941eea9…`: at `e941eea9…` the W8
rows sat one line earlier (OD-W8-1 `:293` … OD-W8-7 `:299`), so an anchor set that is correct at one
head is wrong at the other. Both sets were re-derived at the head named here.

| ID | Where | Question (options, recommended first) | Blocks |
| --- | --- | --- | --- |
| **OD-W6-0** | W6 lock `:306-309` | Adopt the W6 lock at exact merged SHA `2967da018ceea41b91098e14d4c15a57236eb5f8`. No default: absent RATIFY, W6 stays preparation-only. | All of W6 (R2.1–R2.4), and transitively W7 and W8 |
| **OD-W6-1** | W6 lock `:238` | Aggregate endpoint path/permission. (a) `GET /api/attendance/groups/:groupId/effective-policy` under `attendance:admin`, org from principal, delegated-admin active-membership check. (b) Fold into the existing group detail response. | R2.1 |
| **OD-W6-2** | `:239` | Fixed-schedule effectiveness composition. (a) Call the existing FSER service inside the aggregate, embed verbatim for `fixed_shift`, `null` otherwise. (b) Link-only, no embed. | R2.1 |
| **OD-W6-3** | `:240` | Machine spelling of the label union. (a) `effective / org_inherited / preview_only / needs_configuration / conflict_action_required`. (b) Other spellings — must stay a closed 5-value union. | R2.1, R2.2 |
| **OD-W6-4** | `:241` | v1 conflict/domain closed inventory. (a) Seven conflict codes + eight domains. (b) Narrower v1 (drop `TIMEZONE_MISSING`, `SCHEDULE_STRATEGY_INCOMPLETE`); any later addition is a contract amendment, not a silent widening. | R2.1, R2.2 |
| **OD-W6-5** | `:242` | Employee/self projection. (a) **OUT** of W6 — the FSER-4 amendment already proved fetch-and-hide is a data-minimization defect. (b) Include a `/me` aggregate. | R2.1 scope |
| **OD-W6-6** | `:243` | `preview_only` derivation. (a) Single-segment `strict` is `effective` under any posture; multi-segment and `flex_required_duration` are `preview_only`. (b) Other. | R2.1 |
| **OD-W6-7** | `:244` | UI gate for the panel. (a) Org opt-in + env gate, default OFF, `disabled = byte-identical`. (b) Env gate only. | R2.3 |
| **OD-W6-8** | `:245` | Membership-overlap detection cost. (a) Bounded per-group query, current date only, count-of-users output. (b) Date-range scan (deferred; needs a performance budget). | R2.1 |
| **OD-W6-9** | `:246` | `editorRef` union shape. (a) Two-kind union (`group_stage` + `group_context_route`). (b) Extend the issue-4711 route family with `basics|people` routes. | R2.1, R2.3 |
| **OD-W7-0** | W7 draft §9 (branch only, at PR 4804 head `a1344c77…`) | Adopt the W7 lock. No default; absent sign-off **and** absent the W6 preconditions, W7 is a paper plan. | All of W7 |
| **OD-W7-1** | W7 draft `:294` | Source of group policy for calculation. (a) A dedicated in-transaction resolver over persisted facts; W6-R5 intact, aggregate stays display-only. (b) Consume the W6 aggregate in-process — rejected by default. | W7-1 |
| **OD-W7-2** | `:295` | Frozen-context evolution. (a) `schemaVersion: 2` with a discriminated selector; v1 stays valid/immutable with untouched golden bytes. (b) Widen v1 in place — rejected, because W7 widens the *value domain of mandatory keys*, unlike W5's optional-key precedent. | W7-1 |
| **OD-W7-3** | `:296` | Cutover state carrier. (a) A second org-keyed context-source state machine in its own table. (b) Extend the existing five-state machine — rejected: breaks the ratified closed matrix, its trigger, and every landed test pinning the 7 legal pairs. | W7-2, W7-3 |
| **OD-W7-4** | `:297` | Suspended-from-group fallback direction. (a) No legacy fallback from `group_authoritative`; suspend/resume only. (b) Allow an owner-driven fall-back-to-legacy with its own manifest. | W7-3 |
| **OD-W7-5** | `:298` | Read-side provenance spellings. (a) Extend existing closed enums by amendment. (b) A parallel provenance field — rejected: second spelling of the same fact. | W7-1, W7-4 |
| **OD-W7-6** | `:299` | Group-policy snapshot form. (a) Freeze group policy into the frozen context. (b) A separate snapshot table keyed by group/date. | W7-1 |
| **OD-W7-7** | `:300` | Which entrypoints cut over together. (a) All source entrypoints flip atomically per org. (b) Phased per-entrypoint — rejected by default: two producers per org/date makes evidence ambiguous. | W7-3 |
| **OD-W7-8** | `:301` | First-org scope. (a) The named synthetic staging org only. (b) That org plus a second synthetic org with a different group topology. Real named-org opt-in is a separate later decision either way. | W7-3, W8 |
| **OD-W8-1** | W8 draft `:294` (at PR 4804 head `a1344c77…`) | Adopt this plan as the W8 contract. (a) Adopt. (b) Re-scope — any narrowing of parent §10 coverage is an owner-level contract change, recorded per item. | All of W8 |
| **OD-W8-2** | `:295` | Soak topology. (a) Two sequential soaks if W7 lands (W4-authoritative, then W7-cutover). (b) One combined soak — shorter, but a critical diff becomes ambiguous between engine and policy source. | W8 calendar |
| **OD-W8-3** | `:296` | Disposition of issue 4791. (a) Fix before W8 execution. (b) Owner-accepted residual with a named rerun protocol. *(Note: the fix already merged as PR 4799 and its criterion was re-verified — see R6.1. This row is now about formally recording the disposition.)* | W8 verdict integrity |
| **OD-W8-4** | `:297` | Disposition of the issue-4629 manual matrix. (a) Author `PQA-W8-*` against the W8 head and retire the checklist by owner note. (b) Complete 4629 as-is first. **Decisive input, re-derived and previously absent from this row:** the frozen v2 product candidate `676ed2433813…` (PR 4733's squash) **excludes five landed slices of this line** — W5 PR 4748 `7da5d9e55b0f…`, W6-prep PR 4771 `2967da018cee…`, FSER-4 server PR 4772 `ce17ed321752…`, W4C-5 PR 4773 `3601817969…`, W4C-5 PR 4780 `0dc3596ddb59…`, each `git merge-base --is-ancestor <sha> 676ed2433813…` → rc=1. So option (b) buys a clean 10/10 on a **five-slice-stale tree**, and the freeze comment's own "must not be transferred as PASS" rule would void that evidence again at any W8 head. Full table at R6.3. | R6.3, R6.9 |
| **OD-W8-5** | `:298` | FSER-4 §3–4 relative to issue-4556 closure. (a) Track under issue 4709, outside the closure set. (b) Pull into the closure set. | R1.3, R4.5 |
| **OD-W8-6** | `:299` | Customer-acceptance evidence standard. (a) Closure checklist item 1 may complete with synthetic-staging evidence only, stating plainly that no customer-acceptance claim is made. (b) Require a named customer evidence artifact. | Closure |
| **OD-W8-7** | `:300` | Acceptance-ledger form. (a) One reviewed MD table in `docs/development/`. (b) Issue-comment ledger — rejected by default: unreviewable and mutable. | W8 output |

### 5.2 Decided — recorded here because the in-repo artifacts still say otherwise

| ID | Ruling | Where the ruling lives | In-repo artifact state |
| --- | --- | --- | --- |
| **OD-4709-2** | **(a)** RATIFIED against exact merged SHA `45d71c4209af35a63768ce7ce9f576377f6b8ce4` | Owner decision relay, issue 4556 comment 2026-08-05T08:27:37Z, and PR 4746 comment 2026-08-05T08:26:52Z | `…fser4-member-projection-contract-amendment-20260804.md:4` still reads `PROPOSED / runtime HOLD` on main — **stale header, not an open decision** |
| **OD-W4C-61** | **(a)** RATIFIED against exact merged SHA `2a2a5eee4f00abceff94ed6360e8c051708e35f7` | Same relay comment | `…w4c5-transition-safety-amendment-20260804.md:4` still reads `PROPOSED / staging HOLD` on main — same stale-header situation |
| OD-4556-1..12 | All DECIDED as recommended at parent-lock ratification; any deviation requires an amendment and a new ratification before the affected runtime slice starts | Parent lock `:619-641` | Consistent |
| OD-W4C-1..42 | All DECIDED by exact merged-SHA RATIFY of `a3e5765727ca608e8c49c7a44a025e6e4aae5d40`, each as option (a) without extending §0/§14 scope | W4 lock `:3041-3088` | Consistent |

**OD-W4C-43 … OD-W4C-61 — nineteen decision IDs that no prior pass of this table accounted for.**
The heading of this section promises "one table to rule from"; without these rows it was missing
nineteen. Each ratification below is a durably transcribed `zensgit` comment, re-derived via
`gh api repos/zensgit/metasheet2/issues/<N>/comments`:

| ID | Ratifying PR thread | Comment ID(s) | In-repo amendment header state |
| --- | --- | --- | --- |
| OD-W4C-43 | PR 4595 | 5077319936, 5077323797, 5077411053, 5082071635, 5082275704 | n/a (W4C-0 authorization hold thread, not an amendment file) |
| OD-W4C-55 | PR 4672 | 5113759839 | `…w4c3a-legacy-preimage-restore-amendment-20260729.md:3` reads **PROPOSED** |
| OD-W4C-56 | PR 4677, PR 4679 | 5125676385, 5125818320 | `…w4c3a-byte-parity-field-amendment-20260730.md:3` reads **PROPOSED** |
| OD-W4C-57 | PR 4679, PR 4685 | 5125993049, 5128070751 | `…w4c3a-group-precondition-freeze-amendment-20260730.md:3` reads **PROPOSED** |
| OD-W4C-58 | PR 4685 | 5132416517, 5137577915 | `…w4c3a-locked-race-lockset-amendment-20260730.md:3` reads **PROPOSED** |
| OD-W4C-59 | PR 4686 | 5132419831, 5137578736 | `…w4c3a-result-slots-amendment-20260730.md:3` reads **PROPOSED** |
| OD-W4C-60 | PR 4687 | 5132423206, 5137579132 | `…w4c2-per-target-failure-taxonomy-amendment-20260729.md:3` reads **PROPOSED** |
| OD-W4C-61 | issue 4556 relay 2026-08-05T08:27:37Z | — | `…w4c5-transition-safety-amendment-20260804.md:4` reads **PROPOSED / staging HOLD** (row above) |

**Two limits on the table above, stated rather than papered over.** (1) The ID→amendment-file mapping
is inferred from thread adjacency and slice naming, **not** from a machine-checkable link — each
amendment file would have to be opened and its own `OD-W4C-<n>` header read to bind the pair. That
per-file confirmation was **not** performed here, so treat the fourth column as *which stale header
most plausibly corresponds*, not as a verified binding. (2) OD-W4C-44 … OD-W4C-54 are not
individually tabulated here; OD-W4C-54 is recorded in the verification record via PR 4669. The
correct statement is therefore **"nineteen IDs exist in the 43–61 range and eight of them are
tabulated above"**, not that the range is now closed.

The direction of the G2 discrepancy repeats across every row: the owner comment is the
authorization, the in-repo header is a lagging record of it.

The direction of the §5.2 discrepancy is worth naming: here the in-repo artifact **understates**
authorization. The G1 failure (PR 4613) was an artifact **overstating** it. Both are the same
lesson — the header is a record, not the authorization — and the mitigation is the same: read the
relay, not the header.

### 5.3 Merge rulings pending on the open PRs

Merging is a separate owner decision from any gate verdict (§3.1 rung 5). These are the rulings
currently waiting, stated as-of the 2026-08-08 second-pass read.

> **Every head SHA in this table must be re-read immediately before any ruling is made on it.** Head
> SHAs here are not stable: PR 4805's head moved between this document's two passes, and PR 4804's
> head moved twice and by **rebase**, not fast-forward — the earlier pin `e941eea9…` is not reachable
> from the current head, so any `file:line` anchor or check rollup taken at it does not transfer. A
> ruling attached to a stale head is a ruling about a tree that no longer exists.

| PR | Head SHA (read 2026-08-08, 2nd pass) | Merging it authorizes | Precondition before the ruling is meaningful | Detail |
| --- | --- | --- | --- | --- |
| **PR 4805** | `1448615c5aaf27e70c3dd3f1b20400c8661b362d` | Putting the two orphan W4C-3b real-DB suites into a required lane, and replacing the handwritten wiring allowlist with a tree-derived corpus. No runtime change. **Reclassified:** this is repair of a *failed ratified slice-completion gate* under W4 lock §12.9, not hygiene — see R1.1. | Whatever mechanical state the head is in when read (BLOCKED at the second pass; DIRTY/CONFLICTING on `s6a-package-provenance-pins.json` at the first), then all nine required contexts re-run green at the final head. Any earlier green is not predictive (derived corpus). Also settle the C′ question in R1.1's acceptance item (4). | R1.1 |
| **PR 4804** | `a1344c77c09725b757b5e9408b501e433bc3d385` | Publishing the W7 and W8 design-lock drafts on main as PROPOSED/HOLD. Authorizes no runtime and does not itself ratify them — ruling on OD-W7-\* / OD-W8-\* stays separate. | The W7 draft's own clause (`:13-20`) states it merges "only on explicit owner instruction". Re-verify the drafts' `file:line` provenance against current main first — they pin `4e6a35d99…`. **The head cited by an earlier pass (`e941eea9…`) has been superseded by a rebase**, and §5.1's W7/W8 anchors are stated against `a1344c77…`. | R1.2 |
| **PR 4810** | `4ca537c66bb00bede251cbabdcbdc7e730ec60f9` | Landing the FSER-4 §3–4 frontend surfaces (5 mount points, zero backend files). | **SQ-1 must resolve first**: the relay it cites as authority scopes itself to the §7 prerequisite and disclaims "the subsequent frontend slice". Its mechanical state at the second pass is `BEHIND`, which a rebase clears and which is **not** a gate block. | R1.3, SQ-1 |
| **PR 4745** | `043851d3db7bb8d4b4514af3b1354265f9b2cdf3` | Landing the Windows-native QA v2 harness at the **owner-frozen tooling SHA**. All 16 check runs at that head conclude `success`, including all nine required contexts. | **SQ-8 must resolve first**: which harness is canonical, PR 4745 or the diverged `claude/…-0dc3596dd-…` branch that re-pins the product candidate. Adopting the branch instead would create a third candidate for an owner-frozen deliverable. | R1.4, SQ-8 |
| *(no PR)* | branch `7e531be6d6c85e61709661a7d59db8fc975daf58` | — | No PR exists for this branch, so 0 check-runs have ever executed at that head. It is the **alternative** in SQ-8, not an independent item; this document does **not** recommend opening a PR for it. | R1.4, SQ-8 |

### 5.4 Scope questions the gates flagged

| # | Question for the owner | Mechanical facts, no adjudication |
| --- | --- | --- |
| **SQ-1** | Does the 2026-08-05 relay's `OD-4709-2=(a)` RATIFY authorize the FSER-4 **§3–4 frontend slice** (PR 4810), or only the §7 prerequisite? | **Attribution corrected.** The quoted string — "Authorize only the section 7 prerequisite … This does not authorize prerequisite merge, **the subsequent frontend slice**, flags, deployment, staging/soak, production/customer data, external notifications, or issue closure" — is from the **PR 4746 comment (2026-08-05T08:26:52Z) alone**. An earlier pass attributed it to two comments. The **issue-4556 comment (2026-08-05T08:27:37Z)** carries the same substance in different words; its not-authorized list reads "No implementation PR merge; **no FSER-4 follow-on frontend slice**; no W6 runtime; no executable W4C-5 tooling; no staging transition, soak, flag, deployment, production/customer data, external notification, release, customer-UAT claim, or issue-closure action." The conflict with PR 4810 is unaffected by the correction: PR 4810 was created 2026-08-08T04:12:24Z and its body cites "RATIFIED `45d71c4209…`, OD-4709-2=(a)" as authority for "§3 (surface wiring) + the §4 gates not already covered by PR 4772". **Surfaces read for a later authorization:** the issue/PR **comment threads** of issue 4556, issue 4709, and PRs 4746, 4771, 4772, 4773, 4774, 4779, 4780, 4804, 4805, 4810. No later owner relay appears in those eleven threads. **PR bodies were not swept in that pass** (§1.4), and PR 4772's and PR 4773's bodies do carry verbatim owner in-session authorization transcripts — so "not in the threads" is a statement about threads. Whether a later authorization exists elsewhere is **unverified**. This is a gap in what could be seen, **not** a finding that the work is unauthorized. |
| **SQ-2** | The same relay says "No implementation PR merge", yet PR 4772 merged 2026-08-05T15:54:09Z, and PRs 4773/4774/4779/4780 merged after it. Where does the merge authorization for those live? | Same eleven **comment threads** read; no owner authorization comment appears in any of them (PRs 4773/4774/4779/4780 have zero `zensgit` comments at all — re-derived). **Evidence-base correction:** PR **bodies** were not swept in that pass, and PR 4772's and PR 4773's bodies carry verbatim owner in-session authorization transcripts. Those transcripts still read 「不授权 PR 合并」 ("PR merge is not authorized"), so **SQ-2 survives the correction** — but its evidence base is "threads plus two bodies now read", not "every surface swept". Timeline recorded; **unverified** whether some other in-session authorization occurred. Raised because §3.4 G1 is the line's own recorded failure of exactly this shape, and the cheap mitigation is to relay merge authorizations into the PR thread going forward. |
| **SQ-3** | Was PR 4670's merge (carrying the W4C-2 runtime) authorized? | PR 4612 is closed unmerged with a DO-NOT-MERGE title; PR 4670's own body says "This PR is **not authorized to merge**"; the merge happened 2026-07-29T00:28:25Z. PR 4670's and PR 4669's comment threads were **not** read. **unverified**. |
| **SQ-4** | Is `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` inert by construction, or merely unwired? | Whether the OpenAPI build or any required contract gate reads `drafts/` was not checked. **unverified**. Cheap to settle and it changes W6-2's shape. |
| **SQ-5** | Should issue-4770 gate 2 (the fixed-prefix reversion mutation) get a permanent CI leg, or be recorded as an accepted residual? | PR 4774's own body reports it as "PASS (hand-verified, not automated as a permanent CI leg)". No standing gate would catch a regression to `ORDER BY created_at ASC LIMIT 25`. |
| **SQ-6** | Does amendment §8 **step 4** ("land read-only/tooling and runbook completion") fall inside the 2026-08-05 relay's affirmative grant, or inside its "**no executable W4C-5 tooling**" exclusion? | The affirmative grant is narrow and names step 3: "Its **core transition-boundary hardening** may start from fresh `main` as Draft/HOLD" (issue 4556, 2026-08-05T08:27:37Z). The exclusion is in the same comment. Amendment §5 (`:136-138`) permits a transition command "compiled but refuses execution" as **preparation**, and §7(a) (`:170-171`) reads "before any executable W4C-5 transition tooling is **accepted**" — sequencing language, not a build prohibition. Against that, §5 places the refusing command inside the tooling-preparation set the exclusion names, and PR 4773's own body describes the step-4 PR as "separately authorized". **This document adopts neither reading**; R1.5's earlier "authorized; startable today" is retracted. Blocks R1.5. |
| **SQ-7** | Issue 4616's own two-way disposition is due and unexecuted: **close** it (no named per-record consumer; the issue records zero repo-wide subscribers and defaults to closing), or **keep and rewrite** it (a named consumer exists)? | Its `(b2)` precondition landed — the W4C-2 scheduled-run identity amendment is on main and the W4C-2 runtime shipped under it on 2026-07-29 — so the condition has been executable since then. The issue also carries a standing prohibition 「不得在 (b2) 之前以本票为由实现任何 per-record 事件」 that bears on W7's event surface. Recorded at R6.8. It is a short ruling that is sitting open against the closure set. |
| **SQ-8** | Which Windows QA v2 harness is canonical: **PR 4745** at the owner-frozen tooling SHA `043851d3db7b…`, or the branch `claude/attendance-windows-qa-v2-0dc3596dd-20260806` at `7e531be6d6c8…`? | They have diverged (`--is-ancestor` rc=1; merge base `783eb72fe038…`). PR 4745 is green on all nine required contexts; the branch has never had a PR and 0 check-runs. The branch's `attendance-windows-native-qa-v2.pin.json` declares `expectedSourceSha: 0dc3596ddb59…`, whereas the relay authorizes PQA on product candidate `676ed2433813…` — so adopting the branch re-pins the campaign and, by the freeze comment's own transfer rule, restarts the evidence clock. Recorded at R1.4. |

---

## 6. Explicit non-scope and the standing not-authorized list

### 6.1 Out of scope for this line as currently locked

- **W7 winner selection, precedence, and cutover** — out of W6 (W6 lock `:89-98`).
- **Any write endpoint, including a universal group save** — parent R4 and OD-4556-10; typed
  commands only.
- **Per-group punch-policy enforcement** — OD-4556-9 keeps it org-inherited and read-only on this
  line.
- **Employee/self projection inside the W6 aggregate** — OD-W6-5 recommends OUT; the member-safe
  `/me` route stays FSER-4's own gated line.
- **Changes to FSER-4's `/effectiveness/me` contract** — explicitly excluded from W6.

### 6.2 Standing not-authorized list

Nothing in this document, and no gate described by it, authorizes any of the following. Each requires
a separate owner decision at the time it is wanted.

| Action | Standing basis (cited, not paraphrased into permission) |
| --- | --- |
| Merging any implementation PR | W6 lock `:14`, `:296-297`; FSER-4 amendment `:11`, `:217-221`; W4C-5 amendment `:183-186`; W7 draft `:13-20` |
| Staging access or a staging transition | W4 lock §14.9 `:3102` and §12.8 `:3008`; runbook `:6-9`, `:25-40` |
| The seven-day synthetic soak | W4C-5 amendment `:172-173`, `:185-186`; W6 lock `:303-304`; runbook `:4-9` (DRAFT / NOT EXECUTABLE) |
| A runtime flag change or rollout-state transition | Parent lock `:16-18`, `:31-34`; W4 lock `:14-20`, `:3101`; W4C-5 amendment `:8-10`; W6 OD-W6-7 default-OFF and undecided |
| Deployment or production enablement | Parent lock `:16-18`, `:88-92`; W4 lock `:3103-3104`, `:3031`; W6 lock `:96`; runbook `:148-150` |
| Production or customer-data use, external notification, release or customer-UAT claims | W4 lock §12.8; runbook `:148-150`; every amendment's header disclaimer |
| Closing issue 4556 | Parent lock §10 `:764-779`; W4 lock §14 item 10 `:3103-3104` and §15 `:3127`; W6 lock `:14-15`, `:303-304`; FSER-4 `:11-13`; W4C-5 `:9-10`. Closure is an owner ruling; no gate triggers it. |

### 6.3 A note on the "14-10" pointer

The clause commonly cited as "the parent lock's §14-10" does **not** exist in the parent lock:
`attendance-shift-group-advanced-capability-design-lock-20260723.md` has sections 0–10 and no
section 14 (verified by heading scan). The clause with that number is the **W4 lock** §14 item 10:
"Production enablement and issue closure require separate final decisions after verification MD is on
main" (`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:3103-3104`). The parent
lock's actual closure clause is its §10 "Issue closure definition" (`:764-779`). Both are quoted in
§4.4 and §6.2.

---

## 7. Provenance

### 7.1 Baseline and method

- `git fetch origin --prune`; `git rev-parse origin/main` → `a45e1416002e6ca500eeda8d70e86c6443a10700`;
  `git log -1 --format='%H %ci %s' origin/main`.
- `file:line` citations are against blobs at that SHA, read via `git show origin/main:<path>`, with
  two qualifications. (1) The W7/W8 draft citations are against
  `origin/claude/attendance-4556-w7-w8-design-locks-20260807` (unmerged) and are labelled as such.
  (2) Not every citation was re-read in this session: the source-module anchors in §2 and §7.3, the
  W6/W7/W8 lock anchors, and the CI-wiring counts were read here; the lock/amendment/runbook line
  numbers in §7.2 were carried from a pinned inventory taken against the **same** SHA using the same
  `git show` method. Carried citations are therefore same-SHA but not independently re-derived here.
- PR→SHA pairs from the inherited inventory used two witnesses: GitHub API `merge_commit_sha` with
  `merged=true`, **and** the literal `(#N)` suffix on that commit's subject on main. Ancestry used
  exit-code-aware `git merge-base --is-ancestor`, distinguishing rc=0 / rc=1 / unresolvable object.
  Three negative controls fired correctly: a fabricated SHA reported UNRESOLVABLE (not NOT_ANCESTOR);
  a local branch head reported rc=1 NOT_ANCESTOR; and a wrong path guess reported MISSING, which is
  how the W6 draft's real `packages/openapi/drafts/` location was found.
- Live state (PR states, check rollups, comment threads) read 2026-08-08 via `gh`.

### 7.2 Documents

| Path (at `origin/main@a45e1416…` unless noted) | Landed by | Cited lines |
| --- | --- | --- |
| `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md` | PR 4561 → `fb9244711c583bf9e04a9a47257058a44445ef05`, amended by PR 4568 | 1-13, 16-18, 31-34, 88-95, 198-202, 619-641, 645/663/675/687/707/719/731/743/755, 743-762, 764-779 |
| `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md` | PR 4588 → `a3e5765727ca608e8c49c7a44a025e6e4aae5d40`; RATIFY persisted by PR 4592 | 3, 11-20, 3000-3031, **3033 (§12.9 heading), 3035-3037 (§12.9 text)**, 3041-3088, 3101-3104, **3125-3126 (§15 verification-MD completion item)**, 3127-3130 |
| `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md` | PR 4771 → `2967da018ceea41b91098e14d4c15a57236eb5f8` | 3, 12-17, 89-98, 103-111, 236-246, 257, 291-292, 294-304, 306-309 |
| `docs/development/attendance-4709-fser4-member-projection-contract-amendment-20260804.md` | PR 4746 → `45d71c4209af35a63768ce7ce9f576377f6b8ce4` | 4, 9-13, 70-98, 121-127, 136-153, 155-183, 185-193, 195-210, 212-221 |
| `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md` | PR 4747 → `2a2a5eee4f00abceff94ed6360e8c051708e35f7` | 1-6, 8-10, 40-57, 84-108, 110-128, 130-145, 147-164, 166-176, 178-186 |
| `docs/deployment/attendance-issue-4556-w4c5-synthetic-soak-runbook-20260804.md` | PR 4747 | 4-9, 11-23, 25-40, 67-86, 104-123, 125-150, 152-162 |
| `docs/development/attendance-issue-4556-w4-development-verification-20260726.md` | — | §1.2 (the PR 4613 erratum) |
| `docs/development/attendance-issue-4556-w4-remaining-slice-plan-20260726.md` | — | 122-125 (the forward sequence W5 → W6 → W7 → W8) |
| `docs/development/attendance-issue-4556-w1-effective-group-membership-development-verification-20260723.md` | PR 4566 | §3 |
| `docs/development/attendance-issue-4556-w2-w3-development-verification-20260724.md` | PR 4571 | §1 items 3-4, §2 ledger |
| `docs/development/attendance-4709-fixed-schedule-effectiveness-read-model-design-lock` (via PR 4712 → `7abd4e5872946c0ae3c95dfbacf14cf47e1fb700`) | PR 4712 | header ("Ratification authorizes FSER-1 only") |
| `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md` **(branch only)** | PR 4804, unmerged | 3-27, 290-301, 303-318, 319-323 |
| `docs/development/attendance-issue-4556-w8-verification-and-closeout-plan-20260807.md` **(branch only)** | PR 4804, unmerged | 3-30, 290-300 |

### 7.3 Source modules cited

`packages/core-backend/src/attendance/`: `w4c0-operation-contract.ts` (:18-23, :31, :51, :77, :94,
:114, :132) · `w4c0-write-boundary-types.ts` (:23, :59, :83, :124, :281, :303) · `w4c0-identity.ts`
(:363) · `w4c0-authorization.ts` · `w4c0-fingerprints.ts` · `w4c0-source-commands.ts` ·
`w4c0-operation-registry.ts` · `w4c1-segment-calculator.ts` (:62, :68, :79, :94, :107, :335, :836) ·
`w4c1-strict-time.ts` · `w4c1-merge-policy.ts` · `w4c1-fingerprints.ts` ·
`w4c2-scheduled-run.ts` (:1231-1242) · `w4c2-scheduled-run-ops-worker.ts` ·
`w4c2-frozen-attribution.ts` · `w4c2-live-scheduled-boundary.ts` · `w4c2-outbox-dispatcher.ts` ·
`w4c2-shadow-expected-differences.ts` · `w4c3a-rollout-control.ts` (:814-823) · the other 17
`w4c3a-*.ts` · the 4 `w4c3b-*.ts` · the 6 `w4c3c-*.ts` · `w5-flex-policy.ts` (:27-28, :30, :34, :43,
:47, :117, :143, :189, :222) · `w6-group-effective-policy-contract.ts` (:25, :36, :50, :63, :69, :82,
:116, :167, :203).

`packages/core-backend/src/services/`: `AttendanceW4CalculationDetail.ts` (:8, :32, :135, :252, :304,
:384, :505, :593, :781) · `AttendanceDecisionTrace.ts` · `AttendanceCalculationGroupMembership.ts` ·
`AttendanceLegacyMembershipOverlapAudit.ts`.

`packages/core-backend/tests/helpers/scratch-database.ts` (:368, :381, :395).

`plugins/plugin-attendance/`: `index.cjs` (:18, :29356, :44373, :44419, :49612) ·
`lib/attendance-work-date-resolver.cjs` · `lib/attendance-work-date-adapters.cjs` ·
`lib/attendance-shift-service.cjs` (:56) ·
`lib/attendance-fixed-schedule-self-route-identity.cjs` (:39, :44, :58, :92) ·
`lib/attendance-group-fixed-schedule-config-service.cjs` ·
`lib/attendance-group-fixed-schedule-effectiveness-service.cjs`.

`apps/web/src/views/attendance/`: `AttendanceShiftSegmentsEditor.vue` · `attendanceShiftSegments.ts` ·
`AttendanceShiftFlexPolicyEditor.vue` · `AttendanceGroupEffectivePolicyPanel.vue` ·
`AttendanceGroupContextHost.vue` · `attendanceGroupRouteHydration.ts` ·
`useAttendanceGroupRouteContext.ts`.

Migrations: `zzzz20260723140000_create_attendance_calculation_group_memberships.ts` ·
`zzzz20260724120000_create_attendance_shift_segments.ts` ·
`zzzz20260724130000_attendance_dispatch_target_shift_set_null.ts` ·
`zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts` ·
`zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts` ·
`zzzz20260803120000_create_attendance_group_fixed_schedule_configs.ts` ·
`zzzz20260804120000_attendance_shift_flex_policy.ts` ·
`zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts`.

Gates and CI: `scripts/attendance/w4c0-dml-inventory/` (11 `.cjs`) ·
`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` (1,431 lines, 58 cases; named tests at
:83, :106, :123, :140, :168, :252-295, :320, :340-387, :400, :521, :1033, :1386) ·
`scripts/ops/attendance-w4c2-ci-wiring.test.mjs` (:72-134 the handwritten `FILES` allowlist; :191,
:259 the step-id/job assertion) · `.github/workflows/plugin-tests.yml` (:585-594 DML gate step;
:1194-1207 real-DB step id; :1207-1305 the 98-file run-list; :1233-1270 the 38 w4c entries) ·
`packages/core-backend/vitest.config.ts` (`test.exclude` array spanning :31-987) ·
`docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json`.

Tests cited by anchor: `attendance-w4c3a-rollout-control.db.test.ts` (:383-396 `emptyDefectCounts` /
`expectSingleCellDefect`; RACE legs A, C, D, E, F, G, H, I, J, K, L) ·
`attendance-w4c2-sweep-fairness.db.test.ts` (:235, :373) ·
`attendance-w4c2-sweep-call-through.db.test.ts` (:376, :418, :444, :532) ·
`attendance-w4c3b-central-approval.db.test.ts` (:54-55, :95 — the `describeIfDatabase` gate; 16
`it()`) · `attendance-w4c3b-request-snapshots.db.test.ts` (:54 plain describe, :166
`describeIfDatabase`; 3 + 4 `it()`) · `tests/integration/scratch-database-drain.db.test.ts`.

### 7.4 Pull requests

W0 PR 4558, PR 4560 · W1 PR 4563, PR 4566, PR 4586 · W2 PR 4567 · W3 PR 4568, PR 4569, PR 4570, PR 4571, PR 4584 ·
W4 lock PR 4588, PR 4592 · W4C-0 PR 4606, PR 4595, PR 4600, PR 4608, erratum PR 4613 · W4C-1 PR 4607 ·
W4C-2 PR 4612 (closed unmerged), PR 4670, PR 4617, PR 4627, PR 4637, PR 4669, PR 4774, PR 4779 ·
W4C-3a PR 4672, PR 4677, PR 4679, PR 4685, PR 4686, PR 4687, PR 4688 · W4C-3b PR 4714, PR 4715, PR 4716 ·
W4C-3c PR 4718 · W4C-4 PR 4721 · W4C-5 PR 4747, PR 4773, PR 4780 · W5 PR 4748 · W6 PR 4771 ·
FSER PR 4712, PR 4725, PR 4727, PR 4730, PR 4735, PR 4746, PR 4772 · route family PR 4713, PR 4726, PR 4729, PR 4733 ·
infra PR 4783, the issue-4791 repair PR 4799, PR 4800, PR 4801, PR 4803 · in-flight PR 4804, PR 4805, PR 4810.

**Open PRs added on the second pass:** **PR 4745** (Windows-native exact-SHA QA v2, OPEN Draft, base
`main`, head `043851d3db7b…`, 16/16 checks `success`) · **PR 4634** (Windows-native internal QA
package, OPEN Draft, head `66a980357078…`, base = PR 4630's branch) · **PR 4630** (on-prem package
workspace deps, OPEN Draft, `mergeStateStatus=DIRTY`, base `claude/w4c2-live-scheduled-shadow-20260725`
= PR 4612's abandoned branch). The 4634→4630→4612-branch chain never targeted `main`, so only 2 of
the 9 required contexts have ever run on it (§4.6 R6.3).

**Ratification-comment IDs** for OD-W4C-43/55/56/57/58/59/60 are tabulated at §5.2 with their PR
threads.

Squash SHAs for every PR named as "landed" appear in §1.1, §1.2 and §2; each was confirmed an
ancestor of the pinned main.

### 7.5 Issues

issue 4556 (OPEN; 18 comments; task checkboxes in the body all unchecked) · issue 4709 (OPEN) ·
issue 4711 · issue 4629 Windows PQA (OPEN; PQA-01..10 all unchecked; 15 comments, last
2026-08-05T08:27:18Z) · issue 4770 (OPEN, 0 comments) · issue 4775 (OPEN, 0 comments) ·
issue 4791 (CLOSED/COMPLETED 2026-08-07T15:44:55Z) · issue 4792 (OPEN, no fix PR) ·
issue 4802 (CLOSED 2026-08-07T16:12:28Z; the closure *mechanism* — intentional vs. a closing keyword
in PR 4801's body — is **unverified**, though the delivery is proven).

**Two issues added on the second pass, absent from every earlier inventory:**

- **issue 4616** — "attendance: scheduled 结果是否需要 per-record 粒度事件（(b2) 之后重估）", **OPEN**,
  references issue 4556 and issue 4612. Carries a two-way disposition whose precondition has been
  met since 2026-07-29 and which nobody has executed. Recorded at R6.8, put to the owner at SQ-7.
- **issue 4641** — "test(attendance): temporary MetaSheetServer stop leaves scheduler process alive
  after PQA-07", **OPEN**, **0 comments**, created 2026-07-28. A defect produced by the PQA-07 run
  that R6.3 counts as one of only two PASSes on this line; frozen to the retired `66a98035…`
  candidate. Recorded at R6.9; disposition coupled to OD-W8-4.

### 7.6 Owner decision relays read

- issue 4556, comment 2026-08-05T08:27:37Z — "Owner decision relay — next parallel closeout step":
  RATIFY `45d71c4209…` with `OD-4709-2=(a)`; RATIFY `2a2a5eee4f…` with `OD-W4C-61=(a)`; both lanes
  may proceed in parallel as Draft/HOLD, each stopping at a fresh exact-head gate; Windows v2
  PQA-01..10 may continue on the frozen `676ed243…` candidate with synthetic data only; W6
  preparation authorized for a lock, contract, fixtures and a non-runtime shell only. Not authorized:
  "No implementation PR merge; no FSER-4 follow-on frontend slice; no W6 runtime; no executable
  W4C-5 tooling; no staging transition, soak, flag, deployment, production/customer data, external
  notification, release, customer-UAT claim, or issue-closure action."
- PR 4746, comment 2026-08-05T08:26:52Z — the same ruling, scoped to "only the section 7
  prerequisite".
- PR 4746, comments 2026-08-04T10:06:09Z (exact-head gate APPROVE, 0 P1/P2/P3, 14/14 checks) and
  2026-08-04T13:49:53Z (fresh-main landing verification, land as PROPOSED only).

### 7.7 CI evidence

- Branch protection: `gh api repos/zensgit/metasheet2/branches/main/protection/required_status_checks`
  → `{"strict":true,"contexts":[…9…]}`.
- Run 31196449251 @ `7c7d550dbfba` (an ancestor of the pinned main), job 92925709990 `test (20.x)`:
  DML gate 58/58 pass 0 fail; real-DB step "Test Files 98 passed (98) / Tests 1300 passed (1300)";
  unit step "Test Files 603 passed | 191 skipped (794) / Tests 8322 passed | 1709 skipped (10031)";
  `scratchDrain=CLEAN` ×2, `FORCED` 0, `57P01` 0, `Unhandled Errors` 0; the two orphan suites' DB
  describe titles appear 0 times.
- Run 31191954460 @ `51c3d872…` (PR 4799's merge commit), job 92910698439 `test (20.x)`: success,
  two `scratchDrain=CLEAN` lines.
- `attendance-strict-gates-prod.yml` run 31238058092 (`workflow_dispatch`, branch main,
  `head_sha=a45e1416…`): **FAILED** — "Strict gates failed after optional retry
  (failed=apiSmoke,playwrightProd,playwrightDesktop reasons=apiSmoke=AUTH_FAILED
  playwrightProd=TIMEOUT playwrightDesktop=TIMEOUT)", preceded by "No valid attendance admin token".
  An earlier pass named three failing checks (`strict-gates`, `deploy`, `smoke`) and presented that
  set as complete. **It is not complete.** Re-derived at the second pass with
  `gh api repos/zensgit/metasheet2/commits/a45e1416002e6ca500eeda8d70e86c6443a10700/check-runs --paginate`,
  the failing set at the pinned SHA is **five distinct names**: `strict-gates`, `deploy`, `smoke`,
  **`perf`**, and **`verify-main`**. A `verify-main` failure on a `main` commit is the kind of signal
  an owner reading a line-status document should see, and it was previously absent. **None of the five
  is among the nine required contexts** — which is exactly why nothing blocks on them. The failure
  signature (auth + timeouts against the deploy host) is *classified* as environment/deploy-side
  rather than a repo unit/integration gate, but it was **not** root-caused: whether the token, the
  deployment, or the host is at fault is **unverified**. This is promoted out of provenance and into
  §4.4 R4.1 as a soak-entry blocker with an owner and a tier.
- **Check-run rollups are point-in-time, not SHA-pinned.** At the second-pass read the same command
  returns a different rollup from the first pass (7 failures, with `perf` appearing three times, and
  0 pending where the first pass saw 2). Check runs are mutable and re-runnable; a SHA does not pin
  them. Rollup counts in this document are observations with a read pass attached, not properties of
  the commit.
- **Nightly contract-matrix runs on `main` — an evidence source earlier passes reported as
  unavailable.** `attendance-gate-contract-matrix.yml:3-11` carries
  `schedule: - cron: '45 4 * * *'` alongside `pull_request` and `merge_group`, and it **does** run on
  `main`: `gh run list --workflow=attendance-gate-contract-matrix.yml --event=schedule --branch=main`
  returns eight consecutive `main` runs, **all `success`** — 2026-08-01 (`a45a2fe3fa81`) through
  2026-08-08 (run **31240958190** @ `bea44e12d5af`), including run **31150277495** @ `fceee2909612`
  (2026-08-07). So the `contracts` family, which §2.2 of the verification record correctly reports as
  having **no push trigger**, nevertheless has a standing nightly main-branch evidence source. Both
  documents previously called closure condition 6 "not observable at the pinned HEAD"; that
  characterisation is corrected in place.
- **W0's "focused OpenAPI contract test" is wired, and this is where it lives.** The test is
  `scripts/ops/attendance-openapi-parity-4556-contract.test.mjs`, invoked at
  `scripts/ops/attendance-run-gate-contract-case.sh:217` under the matrix `openapi` case, with a
  wiring guard asserting that exact invocation at
  `scripts/ops/attendance-strict-import-advanced-contract.test.mjs:92` (a `assert.match` against the
  literal `node --test ./scripts/ops/attendance-openapi-parity-4556-contract.test.mjs` command).
  Re-derived this pass. What remains **unverified** is narrower than "does it exist": it has never
  been re-derived green **at an issue-4556 head**, because the matrix is PR-scoped plus nightly and no
  4556 head has been run through it in this document's evidence.
- **The contract-matrix corpus is a fourth evidence class that neither document's coverage map
  enumerates.** The verification record's §1.2 map is built from `*.db.test.ts` plus the no-DB vitest
  step; the `scripts/ops/*.test.mjs` corpus run by `attendance-run-gate-contract-case.sh` is a
  separate surface with a separate trigger (PR-scoped **and** nightly-on-main). It is added to that
  map rather than left implicit.

### 7.8 Standing unverified items

1. Owner ratification for OD-W6-0..9 (§4.2 W6-GATE) — no relay found; **open** on the evidence read.
2. SQ-1, SQ-2, SQ-3, **SQ-6, SQ-7, SQ-8** authorization and scope questions (§5.4).
3. SQ-4 — whether `packages/openapi/drafts/` is read by any build or gate.
4. Whether the 20 unexecuted W4C-3b real-DB assertions would pass against a real database.
5. Whether W7/W8 draft `file:line` citations still resolve against current main (they pin
   `4e6a35d99…`).
6. The parent lock's W0 completion criterion. **Narrowed, not closed.** The "focused OpenAPI contract
   test" is now identified and its wiring re-derived — `scripts/ops/attendance-openapi-parity-4556-contract.test.mjs`,
   invoked at `attendance-run-gate-contract-case.sh:217`, with the invocation itself guarded at
   `attendance-strict-import-advanced-contract.test.mjs:92` (§7.7). What remains unverified is
   precisely: **it has never been re-derived green at an issue-4556 head.** The workflow that runs it
   is PR-scoped plus nightly-on-main, and no 4556 head appears in this document's run evidence.
7. The `test (18.x)` matrix leg of the issue-4791 drain evidence.
8. Root cause of the environment red at the pinned head — five failing non-required checks
   (`strict-gates`, `deploy`, `smoke`, `perf`, `verify-main`), now filed as §4.4 R4.1.
9. Whether any module inventoried as "landed" is green today — no build, typecheck, or suite was run
   for this document.
10. Whether the ID→amendment-file mapping in §5.2's OD-W4C-43..61 table is correct per row; it is
    inferred from thread adjacency and slice naming, not from opening each amendment's own header.
11. Whether §12.9's other three per-slice obligations (local collection, workflow positive control,
    exact mutation/failing leg) hold across the eight W4C slices — no artifact on this line maps them
    (§4.6 R6.7).
12. Whether an independently recorded exact-head verdict exists **anywhere** for the six 2026-08-05/06
    landings. What is established (§3.4 G6) is only that none is recorded on GitHub as a review or a
    thread comment, and that the automated reviewer returned a usage-limit message on all six.

### 7.9 Absolute-claim self-audit

§0.4 promises that absolute quantifiers appear only where a mechanical command produced the count.
That promise is re-tested here rather than asserted, because this pass added many new absolutes.
Swept mechanically with `grep -oiwE '(all|every|never|only|none|nothing|zero|always|exactly)'`.

| Claim | Backing command |
|---|---|
| "**nine** amendment headers read `PROPOSED`" | the loop printed at §3.4, with its **pathspec printed** so the scan window is auditable; 11 files match, 2 read `RATIFIED` |
| "**zero** new *source* modules in W4C-5" | `git show --diff-filter=A --name-only --format='' <sha> -- 'packages/core-backend/src' ':(exclude)packages/core-backend/src/**/__tests__/**'` → empty for both. The **unscoped** form returns one file each, which is why the earlier unqualified claim was retracted (§1.2) |
| "**no** `w4c5` file under `scripts/`" | `git ls-tree … -- scripts \| grep -i w4c5` → empty **and** `git grep -li 'w4c5' origin/main -- scripts` → empty, each with a positive control on the same construct (`w4c3c` → 7 paths; `scripts/` holds 627 paths) |
| "the **non-docs source** matches for `w4c5`" | `git grep -li 'w4c5' origin/main -- . ':(exclude)docs'` → **five** paths, the fifth `pnpm-lock.yaml`. The earlier unqualified "only … four" is retracted at R1.5 |
| "**five** landed slices excluded from `676ed243…`" | `git merge-base --is-ancestor <sha> 676ed2433813…` → rc=1 for each of the five, enumerated with SHAs at R6.3 |
| "**five** distinct failing check names at the pinned SHA" | `gh api …/check-runs --paginate`, enumerated by name (§7.7). **Point-in-time, not SHA-pinned** — an earlier pass named three |
| "**zero** reviews on the six landings" | `gh api …/pulls/N/reviews` → length 0 for each of 4771/4772/4773/4774/4779/4780; `…/issues/N/comments` → exactly one bot comment each |
| "**eight** consecutive nightly `main` runs, all `success`" | `gh run list --workflow=attendance-gate-contract-matrix.yml --event=schedule --branch=main`, run IDs and head SHAs printed at §7.7 |
| "**48** ops suites, **22** unreferenced" | `git ls-tree … \| grep -cE 'attendance.*\.test\.mjs$'` → 48; per-basename `git grep -l -F` excluding self-matches. Negative control: `git grep -nE 'scripts/ops/\*' -- .github/workflows` → empty |
| "the **two** W3 files in run-list but not `test.exclude`" | `comm` in **both** directions over the wider `attendance-*.db.test.ts` window; the reverse `comm` at width 1 returns empty, which is why the narrow window hid it (§3.2.5) |
| "PR 4745: **all** 16 check runs `success`" | `gh api …/commits/043851d3db7b…/check-runs --paginate`, enumerated by name |
| "**2 of 9** required contexts ever ran on the 4634 chain" | `gh pr view 4634 --json statusCheckRollup` → `pr-validate`, `attendance-web-guard`, both `SUCCESS` |
| "no closing-keyword `#N` form in this document" | `grep -inE '\b(close[sd]?\|fix(e[sd])?\|resolve[sd]?)[[:space:]]+#[0-9]+'` → empty, with a **positive control**: the same regex fed a synthetic keyword-plus-number string via `printf` matched it. The control string is not reproduced here so this row cannot itself trip the sweep |

**Absolutes retracted on this pass, listed so the retraction propagates instead of being silently
overwritten:** "authorized; startable today" and "None to start" (R1.5); "needs no new owner ruling to
start" (R1.5); "no files beneath them" (§1.2 W4C-5 sweep); "the only non-docs `w4c5` matches … and two
test files" (five paths, not four); "**None** of these three is among the nine required contexts"
presented as a complete failing set (five names, not three); "Two amendments still read `PROPOSED`"
(nine); "no PR in any state" for the Windows QA harness (PR 4745 exists).

**Deliberately NOT asserted as absolutes:** that §5.2's OD-W4C-43..61 table closes that ID range (it
tabulates eight of nineteen); that the ID→amendment-file mapping in that table is verified per row;
that no independent gate happened for the six landings (only: none *recorded*); that §12.9's other
three obligations are unmet (only: unmapped); that any module inventoried as "landed" is green today.

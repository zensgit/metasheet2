# Database & System Integration Line — CLOSEOUT RECORD (2026-07-26)

**What this document is.** The consolidation the line never had: six-plus merged PRs, five open
tickets, a ratified ledger with owner amendments, a real-engine capability spike, a four-decision
roster and roughly ten rounds of adversarial findings — none of it previously readable in one
place. An owner should be able to act on every open ticket from this record alone, without
reconstructing a conversation.

**What this document is not.** It is not the ledger and does not compete with it. The single
authoritative design-and-verification document remains
`docs/development/database-system-integration-line-design-and-verification-20260724.md`
(“the ledger”; on `main` at blob `7b6931a9e6ceb24a5ef62051eb29176e08ecfea8`, verified
`git rev-parse origin/main:<path>` 2026-07-26). Where this record and the ledger disagree, the
ledger wins and this record is the thing to fix. This record adds **no** decisions, opens **no**
gates, and authorizes nothing.

**Verification basis.** Every claim below was re-derived against the repo on 2026-07-26, not
copied from prose: merge SHAs via `git log origin/main`; open-PR heads via
`gh pr view <n> --json headRefOid`; CI verdicts read from the actual run logs. Basis:

```
$ git rev-parse origin/main
4be09076d192cb7bedc7f95e895c5e9305089720
```

Head-scoped discipline applies throughout: every verdict below is bound to the exact SHA it was
taken at. If a branch has moved past the SHA cited here, the verdict must be re-derived, not
carried forward.

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

## 2. OPEN — five tickets, each actionable from this table

Heads re-derived 2026-07-26 via `gh pr view <n> --json headRefOid`. All five are **Draft** by
design. CI states are point-in-time at those heads.

| PR | head SHA | CI @ head | what it contains | gate verdict | **waiting on — exactly** |
|---|---|---|---|---|---|
| **#4610** B1a-2 — identity read + registries | `09aece0d7` | 14/14 SUCCESS; merge state CLEAN | 3 **latent** modules in `plugins/plugin-integration-core/lib/`: `gip-connector-kind-registry.cjs` (β, ships **empty**, `SYSTEM_IDENTITY_KIND_UNCERTIFIED`), `gip-system-identity-read.cjs` (GIP-D0 §6 verbatim, decision α two-materials rule), `gip-canonical-object-contract-registry.cjs` (γ, ships **empty**, `CANONICAL_OBJECT_CONTRACT_UNREGISTERED`, activation refuses caller-asserted evidence). +2440/−2 across 8 files; zero runtime consumers proven by grep in the PR body | owner **HARD HOLD** (3 P1 + 1 P2) closed in round 5 (`8a39cb1de`, owner’s exact probes reproduced); rounds 6–10 closed further P3s/retractions. ⚠️ the PR **body documents rounds 1–6 only**; commits carry rounds 7, 8 and 10 (`89db68fd6`, `4022e5623`, `db28a16ed`, `c79576296`) — read the commit trail, not just the body | **Owner decision:** lift the HARD HOLD and merge (or return findings). Nothing else blocks it. Downstream: B1a-3 (steps 1.4–1.6) is explicitly held until this PR closes |
| **#4614** integration-guard required-wiring | `6b01ebb53` | 14/14 SUCCESS; CLEAN | **wiring only, not promoted**: classifier + a 27-assertion wiring-contract test inside `plugin-tests.yml`’s `test:` job so that promoting `integration-guard` to a required context later cannot false-green. 9 commits; latest fix `3994073c3` (“round 10”: load-bearing empty-`relevant` test + self-covering NUL pin, mutation-verified both directions) | three documented review rounds (r3: 1 P1 — unpinned classifier `env:` block, universal false negative — 1 P2, 3 P3, all closed) plus later commit-level rounds; body’s top section is r3 — same body-staleness caveat as #4610 | **Owner decision + admin act:** whether to add `integration-guard` to `main`’s required status-check contexts (branch-protection change). The PR itself needs only a merge decision; promotion is a separate act it deliberately does not perform |
| **#4619** ⟲OD3 ledger amendment | `467ec6b31` | 13/13 SUCCESS; CLEAN | **doc-only.** Four amendments: (1) Gate bullet 4 — core-backend statement seam removed from v1; (2) §3.2 seam ownership corrected; (3) §4 step 1.4 — seam **and** certified source-column translation removed (both travel with the SQL path, (b′)+B1c, own gate); (4) GIP-D0 §9.2 widening’s live scope narrows to the validator change alone — recorded so no item appears to vanish silently | resolves the (δ)-created contradiction: under v1=(c) the seam’s justification and consumer are both unreachable, so building it in 1.4 would land a second-package production surface with zero v1 consumers — the exact owner-P1-1 class | **Owner sign-off (ratification):** it amends RATIFIED text. Until signed, the ledger stands as amended by ⟲OD2 only, and step 1.4’s scope is formally the un-amended one |
| **#4620** B1b capability spike harness | `7888ee7cc` | 18 SUCCESS + `test (18.x)` / `test (20.x)` still running at capture time (merge state BLOCKED on those); the spike workflow itself is green **on this head** (run `30204851861`-series; spike run `30204851845` success) | CI harness + probes for §4 step 2 against real, ephemeral, first-party **MySQL 8.0 + SQL Server 2019 + SQL Server 2022** service containers; 112/112 mutations; **evidence only** — mints no certification, registers no strategy, `gip-b1b-registry-unchanged.test.cjs` pins that the registry is untouched | four review rounds including an adversarial gate review (1 P1 — vacuous CP-1 comparison — + 5 P2 harness-honesty defects), all closed; **none of the five frozen cell outcomes changed** across rounds. Full verdicts: §5 below | **Owner decision, two-fold:** (a) merge the harness; (b) the §4 **step 3** per-cell certification-opening decision, for which this PR’s output is an *input* and never the act. Opened ahead of its §4 slot deliberately (zero dependency on B1a); it does not claim B1a is done |
| **#4591** B2 enforcement | `436dc6a1c` | 19 SUCCESS + 1 SKIPPED; merge state **BEHIND** (expected — cut from an older `main`; strict checks will require a refresh at merge time) | exactly the owner-listed three: OFFSET-ordering fail-fast guard (`offset > 0` without `orderBy` ⇒ fail-closed, all three SQL adapters, registry-derived roster); typed closed **422** (`DataSourceOffsetOrderingError` / `DATA_SOURCE_OFFSET_ORDERING_REQUIRED`; generic errors still 500, pinned); deletion of MSSQL’s `ORDER BY (SELECT NULL)` fallback. Observability deliberately excluded (own gate) | 16/16 conformance; mutation-verified both ways (guard-neuter reds exactly the fail-closed cases; mapping-removal reds exactly the 422 case); full unit suite green; `tsc` clean | **Nothing in-ticket.** By §4 item 7 it merges **LAST**, after items 1–6 — so it waits on the *completion of the rest of the line*, then an owner merge decision. It is the only open PR whose merge changes runtime behaviour (fail-closed at page 2 on the shipped offset path), which is exactly why it is last and why migration precedes it |

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
| **6. Customer migration** | ⛔ **not started** | *Engineering:* the per-deployment `/select`-caller inventory script the ledger specifies **does not exist** (verified: `scripts/ops/` carries only the β/γ authority-substrate inventory, which is a different artefact). *Ops authorization:* per-deployment runs incl. access-log windows. The migration decision must state the runtime blind spot explicitly (no counter until item 5) |
| **7. B2 merge (#4591)** | 🔄 code **complete**, PR open, **BEHIND** | blocked **by construction** on items 1–6 (owner-set order), then an *owner* merge decision. No in-ticket engineering. “Log-zero alone can never green-light enforcement” stands |

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

---

## 6. KNOWN RESIDUALS — carried forward, none dropped

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
4. **#4610’s disclosed residuals:** `buildInventoryAttestation` has **zero call sites** — no real
   inventory scanner exists, so the γ activation gate refuses every caller today (fail-closed,
   but also unusable until the scanner is built); the package’s aggregate 105-script `npm test`
   chain was not runnable in the review worktree (pre-existing environmental failure, reproduced
   against the unmodified branch tip) — per-file `node` runs and CI stand in for it.
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
13. **#4591 is BEHIND `main`** and will need a refresh (strict required checks) at merge time —
    expected for a merges-LAST PR, recorded so the BEHIND badge is not misread as a defect.

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

That is the honest shape of the closeout: **the stock-prep face is finished and waits on two
non-engineering acts; the GIP face is a fully-fenced latent substrate whose first user-visible
consequence has not yet been authorized, scoped, or scheduled.**

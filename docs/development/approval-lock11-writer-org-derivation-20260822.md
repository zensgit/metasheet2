# Approval Lock-11 (DRAFT r3) — create-time `org_id` derivation for the four ESCALATE `approval_instances` writers

**Status: RATIFIED 2026-08-22 (design only) — see §10 for the ratification block, the ruled arm per
decision, and the verbatim by-reference provenance.** The body below is the r3 RATIFY-READY draft
exactly as independently reviewed (sha256 `5222a094519a2ba7c0c0b1c4af562eecdccfa69b5b7f5043c47350360414bb8d`);
its per-OD `DRAFT — OWNER-CONFIRM` rows are retained verbatim for the record and are each RESOLVED by
§10's table. Where the body and §10 conflict, §10 governs.
**This document reports NO verification of any kind.** §4 *specifies* acceptance gates; none has been
run, and no probe in §8 has been executed. Per `feedback_implementation_is_not_the_ratified_contract`,
an implementer may not treat a recommendation in §3 as a ruling.

**Revision r2 (2026-08-22)** folded the independent refute-first review of r1
(`/tmp/lock11-review-20260822.md`, verdict REQUEST-CHANGES, bound to r1 sha256
`1e31c85f21fe655e91ff1a83cf2031051ecc3e84e6e1d03ef67256ba2ef398e1`). **§9.1–§9.7 is that ledger** —
every P1/P2/P3/NIT, every "strengthener", and every answered review question has a row there, folded
or rebutted with evidence. No finding was dropped.

**Revision r3 (2026-08-22)** folds the round-2 review of r2
(`/tmp/lock11-review2-20260822.md`, verdict REQUEST-CHANGES — 2 P1, 2 P2, 3 P3, 6 NIT — bound to r2
sha256 `2933f56669f1f30f0d57cfd48dd59d06e7dcb23a18087baab1ead41dd1d0f600`). **§9.8 is the r3 ledger.**
Both r2 P1s were **inherited-premise errors, not fold failures**, and both are corrected here against
`604ae14e26` anchors this session re-read directly rather than against a review sentence:

- **P1-A** — OD-L11-9 arm (i)'s stated consequence was false. The org pin conjoins **outside** the
  readability disjunction, so a stale row goes dark for **everyone including the subject and admins**.
  **D-10's recommendation of (i) is WITHDRAWN**; D-10 is now an escalated fork with a fourth arm posed.
- **P1-B** — §2.3 concluded the attendance approval-create path has no membership validation. It has
  `requireActiveMembership`, in-transaction, before any approval DML — **on the leg the client opts
  into**. §2.3 is rewritten as a **two-level path split**, which is sharper than the review's own
  framing in one direction (the validated leg is client-opt-in, and the unvalidated leg is the
  posture every org is in today) and than the parent task's in another (the validation principal is an
  actor∧subject **conjunction**, not subject alone).

**Where r3 goes beyond the round-2 review, declared** (§9.8 carries the evidence for each): the
`legacy_projection_only` posture is universal, not a narrow legacy edge; `operationId` is `.optional()`
on every request-create schema; `subjectScope.kind === 'org_scheduler'` skips the subject check
entirely; and G-L11-9's conflict-branch witness cannot be `version`.

- **Baseline (re-based)**: `origin/main` = `604ae14e2685f1f6f2c32e8238f0df7fb3525d29`
  (`perf(comments): comment-summary row ids move to POST body (#5062)`), fetched 2026-08-22.
  r1 was written against `85b2dd30a5`; the review was written against `85b2dd30a5` and flagged the
  move to `2171b07fb3`. **main has moved seven commits past r1's baseline**, and two of those moves
  are load-bearing for this document:
  - `2171b07fb3` — `ci(approval): make the three evidence suites required … (#5095)`. Changes §4 (see
    §4's CI-wiring block and §9/P2-4).
  - **`45490f57ec` — `test+ci(approval): pin the PLM mirror writer's zero-org derivation (S1 closeout
    slice 1, G-W2) (#5098)`. PR #5098 is MERGED.** r1's evidence-base block described it as OPEN at
    head `70475849b36d`; that is now stale. Writer 2's "write nothing" ruling is pinned **in the tree**
    by `packages/core-backend/tests/integration/approval-org-writer-plm-mirror-s1.db.test.ts`, wired by
    `.github/workflows/approval-realdb-org-writer-plm-mirror-s1.yml`.
  - The other five (`ea5ad16216`, `8a400b1df4`, `21a24b45a0`, `a4dbd3a0a0`, `604ae14e26`) are docs /
    multitable + comments perf and do not touch any anchor in this document.
  - **`origin/main` moved again while r2 was being written**, to `1b77c71348be3a9e161762f351b97535b6245d6a`
    (`f8d0f7315d` multitable provenance panel, `d795a4c450` stock-prep customer pack, `1b77c71348` web
    lazy-load). `git diff --name-only 604ae14e26..1b77c71348` returns **thirteen** files:
    `apps/web/src/multitable/**` (4), `apps/web/src/plugins/viewRegistry.ts`,
    **`apps/web/tests/multitable-record-provenance-panel.spec.ts`** — *r3 (NIT-5): r2's enumeration gave
    three globs and this file falls outside all of them; the conclusion is unaffected* — and
    `plugins/plugin-integration-core/**` (7, incl. `__tests__/` and `package.json`). **No file this
    document cites**, and no `packages/core-backend/src`, `plugins/plugin-attendance`,
    `packages/openapi`, `.github/workflows`, or Lock-10 change. One of them rewrites
    `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`, which
    is the pin §4.1 discusses; that is a pin **value** move, not a procedure change. **Anchors in r2 are
    bound to `604ae14e26` and were not re-read at `1b77c71348`** — an implementer must re-run U6's census
    at their own head (`feedback_verify_against_current_main_not_stale_base`).
- **Every anchor below was re-read at `604ae14e26`** via `git show 604ae14e26:<path>` — the canonical
  working tree is on `chore/approval-wave3-base` and was not touched. **Re-verified unchanged at the
  new tip**: the six-production-site `INSERT INTO approval_instances` census and its line numbers
  (`ApprovalProductService.ts:7560`, `ApprovalBridgeService.ts:1121`, `AfterSalesApprovalBridgeService
  .ts:515`, `plugin-attendance/index.cjs:24061`, `seed-approvals.ts:6`,
  `scripts/test-approvals-contract.mjs:138`). This is the anchor set the whole lock rests on, so its
  re-verification is stated rather than assumed.
- **Path convention (NIT-1)**: every citation is repo-root-relative on first mention. Backend source
  lives under `packages/core-backend/src/`; after first mention a path may be shortened, and the
  short form always resolves under that prefix (e.g. `multitable/automation-approval-bridge-service.ts`
  = `packages/core-backend/src/multitable/automation-approval-bridge-service.ts`).
- **Evidence base**: the merged #5098 (escalation table E-1…E-4 is the input this lock resolves), plus
  `/tmp/stamp-gate-20260822.md` (FIX-ROUND @ `d546b9a90d8e`), `/tmp/stamp-requal-20260822.md`
  (FIX-ROUND @ `70475849b36d`), and `/tmp/lock11-review-20260822.md` (the r1 review).
- **Subject**: writers **1a/1b/3/4** of the six-site census. Writer 2 (`upsertPlmMirror`) is settled —
  "write nothing" — and is now **landed and gated**, not merely pinned by an open PR.
  Writers 5/6 (`packages/core-backend/src/seeds/seed-approvals.ts:6`,
  `packages/core-backend/scripts/test-approvals-contract.mjs:138`) are **out of scope here** and belong
  to Phase 3's writer census (#5098 P3-1).

---

## 0. What this lock does NOT do

- It does **not** amend Lock-10 (`docs/development/approval-lock10-instance-readability-20260821.md`),
  and it mints no numbers into Lock-10's OD namespace. Its own ODs are `OD-L11-*`.
- It does **not** adjudicate Lock-10's internal contradiction at `:412`
  ("PLM rows reach `SET NOT NULL` under OD-S1-18(b)" — the opposite of `:377` and `:820`). That is
  #5098's **P3-3**, an open owner-erratum request; it is **recorded here, not resolved**.
- It does **not** authorize org-pin activation, Migration B, or Phase 3. Lock-10 §5.1.2 makes each of
  those a separately-authorized step with its own ledger row.
- It asserts nothing about surfaces it did not enumerate (`feedback_empty_read_is_not_absence`). Where a
  scan returned nothing, the text says "this scan did not surface X".
- It does **not** claim the r1 review's findings were resolved by re-reading r1. Every fold in §9 that
  changes a factual claim cites a `604ae14e26` anchor, not an r1 sentence
  (`feedback_implementation_is_not_the_ratified_contract`).

---

## 0.1 Executive summary

*(r1 had no executive-summary section; this one is new, and it is the section most likely to be
quoted downstream, so it is written to be safe when quoted alone. Rewritten at r3, not patched.)*

**What this document is.** A derivation lock for the four `approval_instances` writers that still
stamp no `org_id`. It rules **how** each writer should derive the org — not whether the org pin
activates, not the backfill of existing rows, and not the implementation. **Ten ODs, every one
`DRAFT — OWNER-CONFIRM`; eleven owner decisions D-1…D-11, none answered here.** r3 adds no OD and no
decision; it withdraws one recommendation (D-10) and re-bases two (D-1's and D-3's W-4 halves).

**The one sentence that must survive any quotation.** Stamping an org derived from `user_orgs` does
**not** make the org pin protective. In a deployment whose only org is `'default'`, it stamps
`'default'` on ~everything and the pin admits ~everyone. What it buys is that the pin becomes **safe to
activate** — rows are non-NULL, so OD-S1-9(e) does not take them dark. Those are different claims.

**Per-writer recommendation, after the r3 fold:**

| Writer | r1 recommendation | r3 recommendation | Changed at r3? |
|---|---|---|---|
| **W-1** `POST /api/approvals` | **(a)**, dominant; (f) as follow-up iff D-1 rules (ii) | **(a) as the floor, with arm (g) posed as a strictly-narrower alternative the owner must choose between (D-7)**; (f) still the follow-up iff D-1 rules (ii) | **No.** (r2 re-derived the basis (P1-1), added (g) (P2-2), withdrew "dominant") |
| **W-2** multitable automation bridge | (a) | (a) | **No.** (r2 withdrew the "cannot be ruled independently from W-1" constraint — same-slice landing is a *preference*, not physics) |
| **W-3** after-sales refund bridge | escalate (c)-vs-(d); if forced, (d) now + (a)-with-validation later | unchanged | **No.** The `'system'` requester is one instance of the **structural zero-membership class**, not a W-3 peculiarity |
| **W-4** attendance plugin | (f) if D-1 permits, else (a); ~~"most dangerous of the four"~~ *(that grading was WITHDRAWN at r2 — see OD-L11-7's risk re-grade and §7's withdrawn-absolutes list; it is reproduced here only because this column records r1 verbatim)* | **(f) if D-1 permits, else (a) — basis STRENGTHENED and SCOPE CORRECTED.** On the leg the client opts into, the membership validation arm (f) proposes **already runs in production**, in-transaction, before any approval DML (§2.3). What the slice adds there is the **stamping**, not the validation. On the **legacy leg** (`operationId` omitted) no validation runs, and the slice must choose whether to inherit that bypass — a named residue in OD-L11-7, not a new decision | **YES — basis and scope (r2 P1-B).** Arm unchanged |

**The five things an owner should read before ruling anything else:**

1. **A structurally-guaranteed population is refused by every arm on the menu except (c) and (d).**
   Self-service registration (`packages/core-backend/src/auth/AuthService.ts:435-440`) and DingTalk
   JIT provisioning (`packages/core-backend/src/auth/dingtalk-oauth.ts:787-789`) both **deliberately
   write no `user_orgs` row**, each saying so in its own docblock and each pinned by
   `tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts`. Users **admitted through those
   paths after `zzzz20260114110000` ran** (the one-time blanket backfill; r3 scoping, review P3-A) hold
   **zero** active memberships and would be refused on **every** approval create under (a)/(b)/(f)/(g),
   and would be **denied at activation** under (d) (the reader's empty-array-denies rule). §2.8, outage
   class 1b. A legitimate owner answer is therefore **"none of these arms — fix provisioning first"**,
   and it is posed as such (D-8).
2. **`req.authenticatedTenantId` is not absent for multi-org callers** — r1 said it was, and that false
   fact was the stated basis for the arm comparison. A multi-org user who names one of their own orgs
   at login gets the claim, membership-validated (§2.2). This is what makes arm (g) possible and what
   re-ranks arm (b).
3. **W-1 and W-2 are separable.** `createApproval` already takes a per-entry-point `actor` carrying
   `tenantId?` (`ApprovalProductService.ts:203`), which is a usable **channel** for a server-derived
   value even though it is a refused **source**. Different arms per writer are implementable without
   splitting the shared INSERT.
4. **The recommended arm for W-1/W-2/W-4 is conditional on `user_orgs` facts that have never been
   read** — **three blocking probes**: the multi-org count (U1a) and the zero-membership count (U1b),
   which size the two refusal populations, plus the `directory_integrations` discriminator (U1c), which
   decides whether the second backfill has already manufactured the multi-org population and therefore
   how U1a's number should be read. Until all three come back, "arm (a) refuses nobody today" is an
   unbacked claim, not a finding. *(r3: aligned with §8, which marks all three BLOCKING; §0.1 and §5
   both said "two counts".)*
5. **(r3, new — this is the sharpest practical consequence in the document, and it lands on D-3.)**
   **On W-4, arm (a) would 422 a request the authorization layer just admitted, inside the same
   transaction.** A multi-org subject whose caller names one of the subject's valid orgs passes
   `requireActiveMembership` at `packages/core-backend/src/attendance/w4c0-authorization.ts:329-335`
   — the named org **is** an active membership — and then, one call deeper, arm (a) ignores the name,
   sees ≥2 memberships, and FAILs LOUD. **The boundary admits and the writer refuses, on the same
   request, on the same `trx`.** Arm (f) has no such split, because it consumes the value the boundary
   already validated. D-3 asks the owner to confirm (a) as the floor **for attendance too**; this is
   the fact that confirmation turns on, and r2 did not show it. §2.3, OD-L11-7, D-3.

**What r3 changed that is not a recommendation.** §2.3's fifth-precedent conclusion replaced by a
two-level path split (the validated leg is client-opt-in; the unvalidated leg is the posture every org
is in today); arm (f)'s validation principal specified and propagated to OD-L11-10 and G-L11-8;
OD-L11-9 given a fourth (fail-loud) arm and honest consequences; G-L11-4 re-specced to discriminate
against the pre-existing boundary refusal and to pin its `operationId` posture; G-L11-9 given a
who-can-read assertion and a corrected conflict-branch witness; §1's `:910` truncation repaired and the
false "all re-diffed and match" claim withdrawn at **both** sites that carried it; §7's sweep gains
absolute (xiv); **U8** added for the legacy-leg client population.

**What r2 changed that is not a recommendation** *(carried forward)*. §2.2 corrected; arm (g) added to
the vocabulary; outage classes 1b, 6 and 7 named; the OpenAPI/SDK surface added as an affected surface;
§4 re-based on two landed CI precedents; U3 half-resolved and half-narrowed; G-L11-5's "only gate that
can catch it" claim withdrawn; four new gates (G-L11-8…G-L11-11); two new ODs (OD-L11-9, OD-L11-10);
five new owner decisions (D-7 arm (a)-vs-(g), D-8 the zero-membership class, D-9 the liveness
predicate, D-10 the upsert's `DO UPDATE` semantics, D-11 the W-4 split-brain).

---

## 1. The RULED constraints this lock must honour (verbatim, with provenance)

| Ref | Verbatim (Lock-10) | Provenance |
|---|---|---|
| **OD-S1-9(a)** `:805` | "`org_id text NOT NULL`, **no DB DEFAULT**, non-blank CHECK, `zzzz`-ordered; `approval_attachments` is the precedent, the attendance `DEFAULT 'default'` family the anti-precedent" | **RATIFIED** |
| **OD-S1-9(e)** `:808` | "NULL `org_id` ⇒ **false for everyone including admins**; unreachable on the PLM path by construction under (c-iii)" | **RATIFIED** — and per §5.1.2 it "applies **from activation**, not from code landing" |
| **OD-S1-9(f)** `:809` | "The caller never supplies the org; both sides are derived server-side" | **RATIFIED** |
| **OD-S1-17(a)** `:817` | "Viewer **roles** derived from the DB (`users.role` for an active user ∪ `user_roles`⋈`roles`), never from token claims" | **RATIFIED** |
| **OD-S1-17(b)** `:818` | "Viewer **org** derived from `user_orgs`; the only authoritative request-scoped field is `req.authenticatedTenantId`; no `'default'` fallback. Rejected: (d) leave the derivations to the implementing slice" | **RATIFIED** |
| **OD-S1-17(c) = (c-i)** `:819`, ruled `:873` | "the org half of the predicate is a **union over the viewer's ACTIVE org memberships**" — and its migration consequence: "§2.2(b) class 3's identifying test ("resolves to exactly one **active** org membership") is now well-defined — a multi-org requester **fails** class 3 and falls through the ordered table under the unchanged FAIL-LOUD/terminal-ABORT discipline" | **RULED** — by the second by-reference reply (2026-08-21). Lock-10 `:819` reads "OWNER-CONFIRM (§5.1); … → **RULED (c-i) 2026-08-21 (§5.1.1)**" *(r3: r2 also cut the trailing "2026-08-21 (§5.1.1)" without an ellipsis — a third instance of the same defect class, found by r3's own re-diff rather than by the round-2 review; restored in full)*, and §5.1.1's provenance (`:858-862`) is explicit: "The list was authored by the executing session; the owner's authored contribution is those four characters." Graded **RULED, not RATIFIED**, per `feedback_authorization_source_must_be_owner_authored` |
| **Lock-10 §5.1.2** `:895-914` | "the org-pin conjunct of `canReadApprovalInstance` activates via its own flag as a SEPARATE authorized step after backfill verification (staging first, then prod); the ratified predicate SHAPE lands unchanged — only the conjunct's activation time moves. OD-S1-9(e)'s NULL⇒false-for-everyone applies from activation, not from code landing. Activation is NOT authorized by this ruling; it requires its own ledger row (environment, approver, time, evidence, rollback — ledger rule 5)" | **RULED** (third by-reference reply) |
| OD-S1-9(b) `:806`, OD-S1-9(c) `:807`, OD-S1-18 `:820` | (migration class table / PLM scope-out) | **SESSION DESIGN AUTHORITY (created by the independent review; never put to the owner)** — cited here with that label attached, per #5098 P2-2 |

**Transcription-repair note (r3 — round-2 review P2-B and NIT-1).** Two defects survived into r2's
"Verbatim (Lock-10)" column and are repaired above. (1) The `:910` cell stopped at "it requires its own
ledger row" and dropped "**(environment, approver, time, evidence, rollback — ledger rule 5)**" with no
ellipsis — the same P3-2 defect class r2 folded for `:818` while leaving it live here; the clause is now
restored in full. (2) The `:818` cell added `**` emphasis around "Rejected: (d) leave the derivations to
the implementing slice" that Lock-10 `:818` does not carry; the words were identical, the emphasis was
not. **r2's claim that all §1 fragments had been re-diffed and matched was therefore false**; it is
withdrawn at both sites that carried it (§9.3's P3-2 row and §9.6 item 6). The repaired set was
re-diffed mechanically at `604ae14e26` after this edit — see §9.8.

**Provenance-grading note (r2).** r1 graded OD-S1-17(c)=(c-i) **RATIFIED** while grading the third
by-reference reply **RULED**, though both arise from the identical mechanism (an executing-session
authored list + 「按建议执行」). r2 grades both **RULED**. This is a downgrade of r1's own claim, not a
new reading of Lock-10; Lock-10's `:819` already says RULED.

**Reading of OD-S1-9(f) this lock adopts, and flags as contestable.** "The caller never supplies the
org" is read as a rule about **provenance**, not about the *presence* of any org-shaped token on the
wire: a value the server derives from the caller's own `user_orgs` roster is server-derived even if the
caller named which of their own memberships to use. Whether that reading survives is **OD-L11-8**, an
owner question, because arms (f) and (g) below depend on it and (f) is otherwise the only non-refusing
answer for a multi-org caller who did not select at login.

**r2 sharpening of that reading (P1-2).** OD-S1-17(b) — **RATIFIED** — names `req.authenticatedTenantId`
"the only authoritative request-scoped field". §2.2 establishes that **that field's value is itself
produced by a caller-named, membership-validated selection** on the login path. So the ratified text
already blesses the validated-selector *provenance*; what OD-S1-9(f) plausibly constrains is the
**arrival channel** — via the token, minted under server validation, versus on the create request
itself. OD-L11-8 / D-1 is restated in those terms below. This is a reframing of the question, not an
answer to it.

---
## 2. Baseline facts (all re-read at `604ae14e26`)

### 2.1 The four writers, and what org fact each actually has

| # | Writer | Entry point | Org fact available at the INSERT |
|---|---|---|---|
| **W-1** | `packages/core-backend/src/services/ApprovalProductService.ts:7560` INSERT (24 columns, **`org_id` absent**) via `POST /api/approvals` (`packages/core-backend/src/routes/approvals.ts:1197`) | HTTP | `actor.tenantId` = `resolveApprovalTenantId(req)` (`:1228`) — **the forgeable trap, see 2.2**; and `req.authenticatedTenantId`, which is **not** forgeable and **not** always absent — also 2.2 |
| **W-2** | Same INSERT, via `AutomationApprovalBridgeService.startApproval` (`multitable/automation-approval-bridge-service.ts:218-224`, `createApproval` at `:271`), called from `multitable/automation-service.ts:2523-2530` | none (in-process automation step) | **NONE.** See 2.4 |
| **W-3** | `AfterSalesApprovalBridgeService.submitRefundApproval` (`services/AfterSalesApprovalBridgeService.ts:480`), INSERT at `:515` (`afs:` ids) | plugin `communication.call` seam | **NONE in the service.** See 2.5 |
| **W-4** | `upsertAttendanceApprovalInstance` (`plugins/plugin-attendance/index.cjs:24059`), **UPSERT** at `:24061-24086`, five call sites `:33356 :33597 :33871 :34155 :34494` | HTTP (attendance routes) | `payload.orgId`, already carried in `subjectSnapshot.orgId` (`:24032`) and `metadata.orgId` (`:24045`) — **refused shape, see 2.6** |

`git grep -n "INSERT INTO approval_instances" 604ae14e26` returns six production sites; zero Kysely
`insertInto('approval_instances')` hits repo-wide. The **set** of six matches the landed migration's own
docblock (`packages/core-backend/src/db/migrations/zzzz20260821100000_add_approval_instance_org_id.ts:33-36`)
and #5098's re-derived census; **the docblock's own line numbers are stale** — it says
`ApprovalProductService.ts:7508`, `ApprovalBridgeService.ts:1118`, `plugin-attendance/index.cjs:24051`,
where the current values are `:7560`, `:1121`, `:24061` (NIT-2). Anyone re-deriving the census from that
docblock will land a few lines short; re-derive from the grep.

**W-1 has no requester-override on the create path (verified, r2; corrected r3).** `createApproval`
calls `this.assembleCreationContext(request, actor)` with **no options object** (`:7485`). **There is
exactly ONE `requesterOverride` caller in the repo** — `previewTemplateRoute`'s
`assembleCreationContext` call at `:7366-7371`, where the token appears at `:7370` and is itself
conditional on `options.sampleRequester`. *(r3, NIT-2: r2 said "the two preview paths (`:7342`,
`:7366`)". `:7342` is `previewApprovalRoute`'s call and its options object is `whitelistFormDataToSchema`
+ `requesterChoicePresence` only — no `requesterOverride`. The correction runs in the **safe**
direction: the requester≡actor argument is strengthened, not weakened.)* Both preview paths write
nothing in any case. So the requester snapshot's id is `effectiveRequester.userId` = `actor.userId`
(`:7028-7039`, `:7253-7254`) —
**on W-1 the requester IS the acting principal, structurally**. Two consequences: OD-L11-1's
actor≠requester hazard does not arise on W-1 at all (**nor on W-2 — see OD-L11-1; it arises only on
W-4**), and arm (g) below is coherent for W-1 without a keying caveat.

**A downstream `org` consumer an implementer will trip over.** `resolveCalendarSlaOrgId`
(`ApprovalProductService.ts:4431-4435`) reads `requesterSnapshot.orgId` and falls back to the literal
`'default'`; it feeds the business-time node-SLA calendar port (`:7712`). W-1's snapshot builder
(`:7253-7288` — *r3, NIT-4: r2 said `:7253-7268`; the object literal runs to `:7288` and the claim
"no `orgId` key anywhere in it" holds across the full range*) sets **no** `orgId`, so that consumer is
on its `'default'` branch today; W-4's snapshot
**does** set `orgId` (`plugin-attendance/index.cjs:24032`). An implementer who "helpfully" adds `orgId`
to W-1's `requesterSnapshot` while wiring the column would silently change SLA calendar resolution for
every business-time node. **The column and the snapshot are different surfaces; the slice touches the
column only.** (Recorded here because it is a wrong-fix hazard of the same family as §2.2's, not
because any review finding named it.)

### 2.2 W-1's trap, stated precisely — and the r1 error this section corrects

**Corrected in r2 (review P1-1).** r1 asserted that `req.authenticatedTenantId` is "**absent by
construction** for a multi-org caller". **That is false**, and it was the stated basis for OD-L11-4's
arm comparison. The correct statement is below; §9/P1-1 records the correction.

**(i) The forgeable helper — unchanged and still the highest-probability wrong fix.**

- `packages/core-backend/src/routes/approvals.ts:184-189`:
  ```ts
  function resolveApprovalTenantId(req: Request): string | undefined {
    const candidate = req.user?.tenantId
    ...
  }
  ```
- `packages/core-backend/src/auth/jwt-middleware.ts:101-108`:
  ```ts
  const authenticatedTenantId = typeof user.tenantId === 'string' ? user.tenantId.trim() : ''
  if (authenticatedTenantId) { req.authenticatedTenantId = authenticatedTenantId }
  const headerTenantId = extractTenantFromHeaders(req.headers as ...)
  if (!user.tenantId && headerTenantId) { user.tenantId = headerTenantId }
  ```
  `req.authenticatedTenantId` is set **only** from the JWT claim; `req.user.tenantId` is then
  **back-filled from the `x-tenant-id` header**. So `resolveApprovalTenantId` — the nearest helper, and
  the one the route already passes into `createApproval` — is **header-forgeable** and is refused by
  OD-S1-17(b). **No implementing slice may add `actor.tenantId` to the INSERT.**
  The route is mounted behind `authenticate` (`routes/approvals.ts:1197`), which is
  `jwtAuthMiddleware` (`packages/core-backend/src/middleware/auth.ts:6,11`), so both fields exist on
  this request and the split above is the whole safety argument: **`req.authenticatedTenantId` is
  claim-only and the header backfill cannot reach it.**

**(ii) `req.authenticatedTenantId` is present for a multi-org caller who selected an org at login.**
`AuthService.resolveSessionTenantId` (`packages/core-backend/src/auth/AuthService.ts:384-423`) has
**two** branches, and r1 read only the second:

- **Requested branch** (`:390-403`): `SELECT uo.org_id FROM user_orgs uo JOIN users u ON u.id = uo.user_id
  WHERE uo.user_id = $1 AND uo.org_id = $2 AND uo.is_active = true AND u.is_active = true LIMIT 1`, then
  `return result.rows[0]?.org_id === requested ? requested : undefined`. **A membership-validated caller
  selection.**
- **No-requested-tenant branch** (`:405-418`): `… ORDER BY uo.org_id ASC LIMIT 2`, returns a value only
  if `rows.length === 1`. This is the branch r1 quoted, and r1's claim is true **only** of it.
- Wired to production login with **no `NODE_ENV` gate**: `packages/core-backend/src/routes/auth.ts:682`
  (`authRouter.post('/login', loginRateLimiter, …)`) → `:700-704`
  (`tenantId: resolveRequestTenantId(req)`) → `resolveRequestTenantId` at `:165-183`
  (`extractTenantFromHeaders(headers) || headers['x-workspace-id'] || body.tenantId || body.workspaceId
  || query.tenantId || query.workspaceId`) → `packages/core-backend/src/db/sharding/tenant-context.ts:164-167`
  (`extractTenantFromHeaders(headers, headerName = 'x-tenant-id')`). Same chain at `routes/auth.ts:627`
  (`issueAuthSessionToken`) and `:806` (register).
- `AuthService.ts:356-357` puts the resolved value into the token; `jwt-middleware.ts:101-104` puts it on
  the request.

**The same header name is forgeable post-auth and legitimate pre-auth.** Post-auth it back-fills only
`req.user.tenantId` (refused); pre-auth it is a *selector* that must survive a membership check before
it becomes a claim. That asymmetry is the whole of §2.2 and is what arm (g) rests on.

**(iii) Reachability from the shipped UI (r2, sharpening review P2-8).** There is **no org-switcher** in
either frontend — `git grep -nE "orgSwitch|switchOrg|OrgSwitcher|TenantSwitcher|currentOrg|activeOrg"`
over `apps/web` and `apps/web-react` returns nothing at `604ae14e26`. But the Vue app **does** send
`x-tenant-id`: `apps/web/src/utils/api.ts:156-170` (`authHeaders()`) sets it from localStorage
`tenantId`/`workspaceId`, from a `?tenantId=`/`?workspaceId=` query parameter, or from the decoded JWT
payload, and `apiFetch` applies `authHeaders()` on **every** call including `/api/auth/login`
(`apps/web/src/views/LoginView.vue:251`; `isAuthRoute` at `api.ts:172-177` only suppresses the
unauthorized-redirect, not the headers). The login body itself carries only identifier/password
(`LoginView.vue:253-256`).
→ **Login-time org selection is reachable in the shipped product via an undocumented URL parameter, and
there is no UI affordance for it.** It is a mechanism, not a feature. Anyone writing "the user can just
switch orgs" is overclaiming; anyone writing "there is no recovery at all" is also wrong.
→ **It does nothing for the zero-membership population (§2.8).** A user with no membership has nothing
to name: `resolveSessionTenantId`'s requested branch returns `undefined` for them too.

### 2.3 The mechanisms that already exist (search before building — `feedback_search_for_the_mechanism_before_building_it`)

**Four** in-repo precedents for membership-derived org, none of them yet reachable from an approval
writer:

1. **`AuthService.resolveSessionTenantId` no-requested-tenant branch (`auth/AuthService.ts:405-418`)** —
   *is already arm (a)*: exactly-one active `user_orgs` membership ⇒ that org; ≥2 ⇒ `undefined`. It is
   the **same rule** Lock-10 `:873` ruled well-defined for Migration-B class 3.
2. **`AuthService.resolveSessionTenantId` requested branch (`:390-403`)** — *is already arm (f)/(g)'s
   shape*, on the token-minting path, fed from request input at `routes/auth.ts:703`, `:627`, `:806`.
   **This is the second precedent r1's OD-L11-8 census missed, and it is the more central one**, because
   the field OD-S1-17(b) ratifies as "the only authoritative request-scoped field" is exactly its output.
3. **`packages/core-backend/src/services/approval-instance-readability.ts:152-157`
   (`viewerActiveOrgIds`)** — the reader half: `SELECT org_id FROM user_orgs WHERE user_id = $1 AND
   is_active = TRUE` (`:153`), conjoined as `AND i.org_id = ANY($4::text[])` (`:193`), "so an empty array
   denies (never 'no constraint')" (`:149-150`). **r1 called this function `loadViewerOrgIds`; no such
   symbol exists anywhere in the repo** (P2-1).
4. **`plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs:134` (`resolvePunchOrgIdV1`)** —
   the **validated-selector** pattern: if the request names an org it MUST be one of the caller's active
   `user_orgs` memberships or the request is refused `403 ATTENDANCE_PUNCH_ORG_NOT_PERMITTED` "before any
   DML"; when the request names none it does not participate at all (`:136-138`). Its membership read is
   `loadActiveMembershipOrgIdsV1` (`:108-116`). Its own header declares it "Values-free by construction".
   This is the in-repo precedent for arm (f).

**A fifth precedent — and it is not "narrower", it is on W-4's own writer. §2.3's r2 conclusion is
WITHDRAWN (r3, round-2 review P1-B).**

r2 wrote: "`requireActiveMembership` is already enforced in-transaction on the attendance
**result-operation** registry path (`w4c0-operation-registry.ts:596`). `request_create` does **not**
appear in that registry, and `w4c3b-request-operation-boundary.ts` does not call
`recheckAttendanceActorLivenessInTransactionV1` — **so the attendance approval-create path has no
membership validation of its `orgId` today.**"

**Both textual negatives are true; the conclusion drawn from them is false.** They are symbol-level
negatives, and the mechanism is reached one delegation hop deeper
(`feedback_verify_follow_the_delegation`, `feedback_verified_one_link_generalised_to_the_chain`). The
chain at `604ae14e26`, re-walked directly in this session rather than taken from the review:

1. `plugins/plugin-attendance/index.cjs:30062` — the route calls
   `w4RequestOperationBoundary.execute({ kind: 'request_create', routeVariant: 'outdoor', … })`. Its own
   comment at `:30048-30049` says so. If the boundary is unwired the route **503s**
   (`:30050-30056`, `W4_WRITE_BOUNDARY_UNAVAILABLE`) — it does **not** fall through to an unvalidated
   path.
2. `packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts:28` imports
   `attendanceResultOperationPreflightV1` and calls it at **`:479`**. `request_create` reaches that
   call: `resolveSourceRef` (`:319-326`) handles `kind === 'request_create'` explicitly at `:323-325`,
   and the preflight call site is downstream at `:477-482`. r2's negative is true only of the *symbol
   name* — w4c3b never types `recheckAttendanceActorLivenessInTransactionV1`.
3. `packages/core-backend/src/attendance/w4c0-operation-registry.ts:585`
   (`attendanceResultOperationPreflightV1`) calls the recheck at **`:596`** — the very line r2 cited as
   belonging to the *result-operation* path.
4. `packages/core-backend/src/attendance/w4c0-authorization.ts:310`
   (`recheckAttendanceActorLivenessInTransactionV1`) runs `requireActiveMembership` (`:329-335`):
   `SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true` with params
   `[userId, verified.orgId]`, throwing `ATTENDANCE_WRITE_NOT_AUTHORIZED` on miss — **in the same
   transaction, before the adapter's first approval DML.**

**And it covers every W-4 writer call site.** All five sit inside adapter functions reachable **only**
through the boundary — reachability checked, not merely registration: each `execute*RequestCreate`
appears exactly twice repo-wide (definition + the `requestCreateAdapter.execute` dispatch at
`:34276-34279`), and the adapters themselves are registered at `:35415-35420`. **There are no direct
call sites.**

| Writer call site | Enclosing adapter fn | Registered kind |
|---|---|---|
| `:33356` | `executeGenericRequestCreate` (`:33331`) | `request_create` |
| `:33597` | `executeOutdoorRequestCreate` (`:33557`) | `request_create` |
| `:33871` | `executeScheduleDispatchRequestCreate` (`:33796`) | `request_create` |
| `:34155` | `executeShiftSwapRequestCreate` (`:34080`) | `request_create` |
| `:34494` | `prepareRequestPendingEditIdentity` (`:34337`) | `request_pending_edit` |

**What the mechanism actually is — a TWO-LEVEL split, because the loose version overstates it in one
direction and the round-2 review's own version overstates it in another.**

**Level 1 — does validation run at all? The validated leg is CLIENT-OPT-IN.** `w4c3b`'s `execute` has
two legs that reach `adapter.execute` **without** ever calling the preflight:

- **`operationId === null` + non-canonical org key** (`:427-437`): straight to `adapter.execute` with
  `acceptedWritePosture: 'legacy_projection_only'`.
- **`operationId === null` + posture `legacy_projection_only`** (`:449-466`): resolve the rollout
  posture under a shared lock, then `adapter.execute`, returning before `:477-482`.

That second leg is not a narrow legacy edge. `resolveSegmentCalculationPosture`
(`packages/core-backend/src/attendance/w4c0-identity.ts`) returns `legacy_projection_only` for **every
org** unless a persisted non-`legacy` rollout row exists with `scope = 'synthetic_staging'` **and** the
`SEGMENT_CALCULATION_IMPLEMENTATION_CAPABILITY` flag is on **and** the org is exactly allowlisted; the
module states it itself at `:377` ("`legacy_projection_only` for every org … reaching `authoritative`
takes a deliberate …"). Meanwhile **`operationId` is `.optional()` on every request-create schema**
(`plugins/plugin-attendance/index.cjs:32978`, `:32986`, `:31598`, `:31694`, `:31707`; the route reads it
as `typeof parsed.data.operationId === 'string' ? … : null` at `:30061`).
→ **A client that omits `operationId` reaches `upsertAttendanceApprovalInstance` with no membership
validation whatsoever.** Whether that is most of the live traffic or none of it is not repo-knowable —
it is the **U8** probe. *(The round-2 review flagged this leg as "plausibly exists" and scoped sizing it
as a probe-shaped question. The posture half is resolved here from the repo; only the client population
remains a probe.)*

**Level 2 — when validation runs, what does it mean?** It is **arm (f) on the named path and
`'default'`-admission on the unnamed path, with no fall-to-(a) leg.** `verified.orgId` traces back to
`envelope.orgId` ← the route's `orgId` ← `getOrgId(req)`, whose `'default'` fallback (`:6318-6326`) the
boundary does not touch. So:

- caller **names** an org ⇒ it must be an active `user_orgs` membership, or `ATTENDANCE_WRITE_NOT_AUTHORIZED`.
  That is arm (f), keyed as OD-L11-1 requires.
- caller **names nothing** ⇒ `getOrgId` yields `'default'` and the boundary validates membership in
  `'default'` — which backfill 1 (`zzzz20260114110000:34-41`) made true for essentially every
  pre-migration active user. **The check passes ~universally.** This is §2.7's own "launders `'default'`
  into essentially the whole platform population" hazard **already live on the write-authorization
  path**. It is an argument *for* the slice, not against it.

**Whose memberships validate — the answer r2 left open (this is P2-A's in-repo answer, and it is a
CONJUNCTION, not a single principal).** `recheckAttendanceActorLivenessInTransactionV1` runs
`requireActiveMembership` against `verified.orgId` for:

| Principal | Checked? | Anchor |
|---|---|---|
| every **subject** in `subjectScope` (`kind: 'self'` ⇒ one id; `kind: 'explicit_users'` ⇒ each id) | **always** | `w4c0-authorization.ts:315-320`, loop `:348-352` |
| the **actor** | **yes, except** when `actorPosture === 'platform_admin'` | `:344-346` |
| either, for the registered internal scheduler identity (`posture='scheduler'` ∧ `actorId` = the constant) | **waived wholesale** for the actor; subject predicates never waived | `:339-347` |
| any principal, when `subjectScope.kind === 'org_scheduler'` | **no subject is checked at all** — `subjectUserIds` is `[]` | `:315-320` |

So on a cross-user create (`operator` / `attendance_admin`) **both** the operator and the subject must
hold an active membership in the named org. The **subject** is the half that is always present, and it
is the half arm (f) must specify (§3); the actor conjunct is an additional shipped constraint, not part
of the ruling.

**Five consequences, folded where each belongs:**

1. **OD-L11-7's arm (a) row was false** ("no membership check at all today") — corrected there.
2. **OD-L11-7's arm (f) was mis-sized in the *favourable* direction** — on the validated leg the
   validation is already in production; the slice adds only the **stamping**. Corrected there, and it
   strengthens (f) rather than qualifying it.
3. **Arm (a) on W-4 would 422 a request the boundary just authorized, on the same `trx`** — folded into
   **D-3**'s attendance half and §0.1 item 5, because D-3 asks the owner to confirm (a) as the floor.
4. **`G-L11-4`'s negative (i) is non-discriminating as specced** on the validated leg (it would pass
   pre-slice, refused by the boundary) — re-specced in §4.2 to assert the refusal **code** and to pin
   its `operationId` posture, so it cannot silently test the legacy leg instead.
5. **The boundary is the closest arm-(f) precedent** — added to OD-L11-8's census as the fifth.

**Membership-liveness census (r2, new — the input to OD-L11-2).** The three membership readers do **not**
agree on what "active membership" means:

| Reader | Predicate | `users.is_active` checked? |
|---|---|---|
| `approval-instance-readability.ts:153` (`viewerActiveOrgIds`) — **the reader the writer must agree with** | `user_orgs.user_id = $1 AND user_orgs.is_active = TRUE` | **NO** |
| `attendance-punch-org-resolution.cjs:109-112` (`loadActiveMembershipOrgIdsV1`) | `user_orgs.user_id = $1 AND user_orgs.is_active = true` | **NO** |
| `AuthService.ts:391-402` / `:405-418` (`resolveSessionTenantId`, both branches) | joins `users`, `uo.is_active = true AND u.is_active = true` | **YES** |

The house rule is stated in the second backfill's own docblock
(`packages/core-backend/src/db/migrations/zzzz20260721150000_backfill_user_orgs_from_directory_links.ts:27-31`):
membership **existence** is written unconditionally, and "the RD-3 dual-`is_active` read filter
(`user_orgs.is_active=true AND users.is_active=true`) is what excludes a deactivated user from every
count and gate, not a write-time filter here." A derivation that *reads* membership is a read. This is
the evidence OD-L11-2 uses in place of r1's unsatisfiable "byte-identical" mandate.

### 2.4 W-2: no org fact exists anywhere on the automation path — arm (e) is REFUTED, not deferred

- `ExecutionContext` (`multitable/automation-executor.ts:811-819`) carries
  `executionId, ruleId, sheetId, recordId, recordData, ruleCreatedBy, actorId?, triggerEvent` —
  **no org/tenant/base field**.
- `loadAuthorizedActor` (`multitable/automation-approval-bridge-service.ts:447-502`) **declares** the
  return type `{ userId, userName?, email?, department?, departmentIds?, roles?, permissions? }`
  (`:451-459`) and **actually returns** `{ userId, userName, email, roles, permissions }` (`:495-501`).
  **Neither carries `tenantId`**, even though the downstream `CreateApprovalActor`
  (`ApprovalProductService.ts:199-208`) defines one at `:203`. **That absence is a fact about the loader,
  not about the parameter** — see §2.9.
- **Arm (e) checked at the schema, not assumed**: the multitable base/table entities are `meta_bases`
  and `meta_sheets`. `meta_bases`
  (`packages/core-backend/src/db/migrations/zzzz20260318110000_add_multitable_bases_and_permissions.ts:8-19`)
  has `owner_id text` and `workspace_id text`, **both nullable, no default, and no `org_id`/`tenant_id`
  in any migration**; that file is the only migration that ever touches `meta_bases`. `meta_sheets`
  gained `base_id text` (`:22-24`) with a one-time blanket backfill to the sentinel `'base_legacy'`
  (`:56-60`). `automation_rules` (`zzzz20260413120000_create_automation_rules.ts:27`) has
  `sheet_id text NOT NULL` and no org/base column. `multitable_automation_approval_bridges`
  (`zzzz20260610150000_create_automation_approval_bridges.ts:65-86`) has `sheet_id`/`record_id` and no
  org column. The chain `automation_rules.sheet_id → meta_sheets.base_id → meta_bases.*` **terminates
  without reaching an org**.

  **Three strengtheners the independent review added, absorbed here** (all re-verified at `604ae14e26`;
  each closes a "did you look there?" a reader will otherwise ask):
  - There is a **second migrations directory**, `packages/core-backend/migrations/*.sql`, wired into the
    runner at `packages/core-backend/src/db/migration-provider.ts:148-164`. It is also clean of
    `meta_bases` / `meta_sheets` / `automation_rules`. A reader who finds it must not think the census
    skipped it.
  - **No `workspaces` / `orgs` / `organizations` / `tenants` table exists anywhere**, which is what makes
    `meta_bases.workspace_id` *inert* rather than merely nullable. The repo states this itself:
    `packages/core-backend/src/db/migrations/zzzz20260818120000_create_approval_usable_member_groups.ts:20`
    — "`org_id` is a free-text scope id (NOT a foreign key — no `orgs` table exists in this codebase…)".
  - Both hops are **unenforced**: `automation_rules.sheet_id` has no FK, and `meta_sheets.base_id` is
    nullable with `ON DELETE SET NULL`. The chain is not merely org-terminating, it is not guaranteed
    traversable.

  → Arm (e) is refuted **as a fact at this baseline**, not deferred. Reviving it means first adding an
  org column to `meta_bases` and backfilling it — a separate, larger slice, which would itself hit the
  `'base_legacy'` blanket-bucket problem.

### 2.5 W-3: the docblock's claim holds for the service; the plugin has a *different*, refused tenant

- The landed migration says it verbatim
  (`zzzz20260821100000_add_approval_instance_org_id.ts:46-49`): class 4's source, "the deploy's org for
  the after-sales channel", "has no plumbing anywhere in the repo (`AfterSalesApprovalBridgeService.ts`
  never reads org/tenant); an unset value must **ABORT** the migration when this class is later
  implemented, never default." Re-verified: `AfterSalesApprovalBridgeService.ts` contains no
  org/tenant read.
- **But the plugin side is not org-free, and the lock must not imply it is.**
  `plugins/plugin-after-sales/lib/workflow-adapter.cjs:183-208` (`resolveRuntimeInstallContext`)
  resolves a `tenantId` from the event **payload**, from a project-id string, or from plugin-install
  context; the install table `plugin_after_sales_template_installs` is keyed `(tenant_id, app_id)`
  (`zzzz20260407140000_create_plugin_after_sales_template_installs.ts:57-58`). That value is (i)
  **payload-derived — exactly the OD-S1-9(f)/OD-S1-17(b) refused shape**, and (ii) of **unverified
  namespace** relative to `user_orgs.org_id` (see §8-U5). It is a plugin-install tenant, not a
  membership fact. Naming it here so nobody "discovers" it later and wires it in.
- **The requester on this channel is not guaranteed to be a platform user.**
  `AfterSalesRefundApprovalCommand.requester.id` (`services/AfterSalesApprovalBridgeService.ts:140-161`)
  is only `requiredString(input?.requester?.id, 'requester.id')` (`:360`) — a non-empty string,
  **never checked against `users`** (contrast `loadAuthorizedActor`, which does
  `SELECT id, … FROM users WHERE id = $1` and 404s an inactive user). The submit chain is
  `plugins/plugin-after-sales/lib/workflow-adapter.cjs:394-401` (`requesterId: ticket.requestedBy`) →
  `plugins/plugin-after-sales/lib/refund-approval.cjs:42,80-105` →
  `communication.call('after-sales-approval-bridge', 'submitRefundApproval', command)` →
  `plugins/plugin-after-sales/index.ts:1743-1744`. And
  `plugins/plugin-after-sales/lib/event-entry.cjs:92` falls back
  `optionalString(ticket.requestedBy) || requiredString(meta.requesterId, 'requesterId')`, while the
  emit helpers default `requesterId` to the literal `'system'`
  (`plugins/plugin-after-sales/index.cjs:4292, :4302, :4312, :4322, :4349, :4428`).
  → **`'system'` is a reachable `requester.id`**, and this scan did not surface any `users` row with
  that id (no seed or migration inserts one).
  → **r2 reframing (P1-3):** this is not a W-3 peculiarity. It is one member of the **structural
  zero-membership class** (§2.8): a principal for whom no `user_orgs` row exists, so *every*
  membership-keyed arm refuses. W-3's version is the sharpest because the principal may not be a
  `users` row at all, but the class is platform-wide.
- Class 4 rows are **not** dark-by-design: they carry real `'role'`-typed seats
  (`AfterSalesApprovalBridgeService.ts:568-572`), so Lock-10 §2.2(b) class 4 (`:376`) grades them
  "S1-**admissible** by arm 2: they need an org source, not an arm."

### 2.6 W-4: only refused shapes, an UPSERT, and a same-transaction twin

- `plugins/plugin-attendance/index.cjs:49` — `const DEFAULT_ORG_ID = 'default'`.
- `:6318-6326`:
  ```js
  function getOrgId(req) {
    const raw = req.body?.orgId ?? req.query?.orgId ?? user?.orgId ?? user?.workspaceId ?? header
    ... return DEFAULT_ORG_ID
  }
  ```
  Body/query/`x-org-id` header **plus a `'default'` fallback** — refused twice over by OD-S1-9(f) and by
  OD-S1-17(b)'s "no `'default'` fallback". **This is an unvalidated-input surface**: `getOrgId` will
  return any org-shaped string the caller supplies, with no membership check on any route but punch.
- `:6328-6334` — `getAuthenticatedOrgId(req)` reads `user?.orgId ?? user?.workspaceId ??
  req.authenticatedTenantId`, i.e. it consults the **forgeable** session fields **before** the only
  authoritative one. Compliant-looking, refused.
- The org reaches the approval payload through the route input schema
  (`:32993-33000`, `orgId: z.string().min(1).nullable()`) from call sites such as `:30067-30071`, whose
  `orgId` is `getOrgId(req)` (`:30245`, `:30335`, and, on the punch route only,
  `resolvePunchOrgIdV1(db, req, getOrgId(req))` at `:29752`).
- **The writer is an UPSERT, not an INSERT (r2, review P2-9).** `:24061-24086` is
  `INSERT INTO approval_instances (…19 columns…) VALUES (…) ON CONFLICT (id) DO UPDATE SET …` with
  **fourteen** `EXCLUDED`-driven columns (`status`, `source_system`, `workflow_key`, `business_key`,
  `title`, `requester_snapshot`, `subject_snapshot`, `policy_snapshot`, `metadata`, `current_step`,
  `total_steps`, `request_no`, `form_snapshot`, `current_node_key`) plus `sync_status = 'ok'` and
  `updated_at = now()`. r1 called it "the INSERT at `:24061`" throughout and never mentioned the
  conflict path. **W-4 is the only one of the four writers that can rewrite an existing row**, so the
  update-path semantics are a separate ruling — OD-L11-9.
- **A same-transaction twin exists (r2, review P2-7).** `:33356` `await
  upsertAttendanceApprovalInstance(trx, approvalPayload)` is immediately followed by `:33358-33362`
  `INSERT INTO attendance_requests (id, user_id, org_id, work_date, …)` on the **same `trx`**, with
  `route.orgId` as the `org_id` parameter (`:33366`) — the same value that reached the approval payload.
  `attendance_requests.org_id` was added by
  `zzzz20260114100000_add_attendance_org_id.ts:51-56` as `text NOT NULL DEFAULT 'default'`.
  Under any arm that *derives* the approval's org, the two writes stop agreeing. See outage class 6 and
  gate G-L11-8.
- Anti-precedent named by OD-S1-9(a) itself:
  `zzzz20260114100000_add_attendance_org_id.ts:5,10-13` adds `org_id text NOT NULL DEFAULT 'default'`
  across the attendance tables.

### 2.7 The empirical ground: `'default'` is nearly everything — and there are TWO backfills

- **Backfill 1** — `zzzz20260114110000_create_user_orgs_table.ts:34-41` blanket-backfills **every active
  user** into `'default'`:
  ```sql
  INSERT INTO user_orgs (user_id, org_id, is_active)
  SELECT id, 'default', true FROM users WHERE is_active = true
  ON CONFLICT (user_id, org_id) DO NOTHING
  ```
  PK is `(user_id, org_id)` (`:25`), so a user can hold many rows.
- **Backfill 2 (r2, review P2-8 — r1 modelled only backfill 1)** —
  `zzzz20260721150000_backfill_user_orgs_from_directory_links.ts:49-59`:
  ```sql
  INSERT INTO user_orgs (user_id, org_id, is_active)
  SELECT DISTINCT l.local_user_id, i.org_id, true
  FROM directory_account_links l
  JOIN directory_accounts a ON a.id = l.directory_account_id
  JOIN directory_integrations i ON i.id = a.integration_id
  WHERE l.link_status = 'linked' AND l.local_user_id IS NOT NULL AND a.is_active = true
  ON CONFLICT (user_id, org_id) DO NOTHING
  ```
  With PK `(user_id, org_id)`, a **non-`'default'`** integration org yields a **second active row** for
  an already-backfilled user. **This migration manufactures exactly the multi-org population arm (a)
  refuses, with no admin action.** Whether it did so in any given deployment turns on one count —
  see §8-U1's `directory_integrations` discriminator. Note that
  `directory_integrations.org_id` is itself `text NOT NULL DEFAULT 'default'`
  (`zzzz20260324150000_create_directory_sync_tables.ts:16`), so a deployment that never named an org
  keeps every integration on `'default'` and backfill 2 is a no-op there.
- **Three live production writers also add memberships**:
  `packages/core-backend/src/routes/admin-users.ts:3826-3830`,
  `packages/core-backend/src/directory/directory-sync.ts:5648`,
  `packages/core-backend/src/auth/user-activate.ts:210`.
- **No org-switcher UI exists**; the only in-product selection channel is the login-time `x-tenant-id`
  the Vue client sends when a `?tenantId=` parameter or a stored hint is present (§2.2(iii)).
- Prod census (from the S1 evidence pack, `p20`/`p21`): **271/271 `approval_instances` rows have
  `org_id IS NULL`, all platform ids**. Nothing is stamped today.
- The implementer finding already recorded in the reader module
  (B-1/B-2 are the bullets at `approval-instance-readability.ts:57-62`; `:64-71` is the "Consequence:"
  paragraph that *cites* them at `:68` — *r3, NIT-3: r2 cited only the second range; the content is
  present at both*) applies verbatim to the **write** side: class 3's
  derivation "launders `'default'` into essentially the whole platform population, … precisely the
  `DEFAULT_ORG_ID` hole OD-S1-9(a) refuses, arriving through the backfill instead of through a column
  default."

> **Refute-first, stated once and load-bearing for every recommendation below:** stamping via
> `user_orgs` does **not** make the org pin protective. In a deployment that never created an org
> beyond `'default'`, it stamps `'default'` on ~everything and the pin admits ~everyone. What it does
> buy is that the pin becomes **safe to activate** — rows are non-NULL, so OD-S1-9(e) does not take
> them dark. Those are different claims. Any PR body, comment or gate name that merges them is the
> overclaim class that cost #5098 two fix rounds.

### 2.8 The zero-membership population is structural, not hypothetical (r2, review P1-3)

Two production provisioning paths **deliberately** create users with no `user_orgs` row, each says so in
its own docblock, and each is pinned by the same test:

- `packages/core-backend/src/auth/AuthService.ts:435-440` (`register`, self-service): "Deliberately: this
  method does NOT write user_orgs. A user created here has no org membership until an org-aware
  admission path … later adds one … Verified by
  `tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts` (zero `user_orgs` rows for a user
  created via this path)."
- `packages/core-backend/src/auth/dingtalk-oauth.ts:787-789` (`createProvisionedUser`, DingTalk JIT):
  "Deliberately: this function does NOT write user_orgs. Verified by
  `tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts` (zero `user_orgs` rows for a user
  created via this path)."

Both are W4-PRE-1 policy: an org-unknowable path records its policy and does not guess. **That is the
right policy** — and it means **every self-registered user and every DingTalk-provisioned user admitted
after `zzzz20260114110000` ran holds zero active memberships until an admin or a directory sync admits
them.** DingTalk provisioning is a shipped product line in this repo.

**Scope caveat (r3, round-2 review P3-A).** r2 stated that claim unconditionally. Backfill 1
(`packages/core-backend/src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts:34-41`) is a
**one-time** `INSERT … SELECT id, 'default', true FROM users WHERE is_active = true`, so every user who
existed and was active when it ran — **including everyone self-registered before it** — holds a
`'default'` membership. The population is therefore *post-migration admissions*, not "all
self-registered users". This does **not** change D-8's answer: the population is still structurally
non-empty for any deployment with post-migration registrations or DingTalk logins, and **U1b measures
it directly** rather than relying on the claim. The scope is carried because a document this careful
about population honesty should carry it.

**What this does to the arm menu** (walked deliberately, because it is the argument r1 never made):

| Arm | Zero-membership principal |
|---|---|
| (a) exactly-one membership | **refused** — zero is not one |
| (b) require `req.authenticatedTenantId` | **refused** — both `resolveSessionTenantId` branches return `undefined` for them, so their token carries no claim |
| (f) validated selector, falling back to (a) | **refused** — nothing to validate a selection against, and the fallback is (a) |
| (g) token claim re-validated, falling back to (a) | **refused** — same, for the same reason |
| (d) leave NULL, scope the channel out | **denied at activation** — `viewerActiveOrgIds` returns `[]`, the reader substitutes a sentinel, and `= ANY(...)` denies (`approval-instance-readability.ts:190-193`, and the function's own docblock `:149-150`) |
| (c) channel constant | the **only** arm on the menu that serves them — and it is the refused shape (OD-L11-6) |

So the honest statement is: **no arm on this menu serves a zero-membership principal without violating a
RATIFIED OD.** The three answers that exist are (1) accept the refusal knowingly, (2) fix provisioning
first so the population is empty before any arm lands, or (3) rule (c) for a channel. This lock poses
(2) as **D-8** rather than leaving the owner to discover it.

The size of the population is **unknown and is the second blocking probe in §8-U1**. It is *certain to be
non-empty* in any deployment that has ever used self-service registration or DingTalk login — which is
a different epistemic status from the multi-org population, which is conditional on prod data.

### 2.9 W-1 and W-2 are separable (r2 — r1's "structural constraint" is WITHDRAWN, review P1-4)

r1 asserted: "**W-1 and W-2 CANNOT be ruled independently** … Any derivation placed at that INSERT
governs both writers simultaneously … a ruling that gives them different arms is not implementable
without splitting the INSERT." **The premise is real; the inference is false.**

- The shared INSERT is real: `ApprovalProductService.ts:7560`, 24 columns, `org_id` absent, and
  `createApproval` has exactly two non-test callers (`routes/approvals.ts:1222`,
  `multitable/automation-approval-bridge-service.ts:271`).
- **But `createApproval(request, actor)` (`:7473`) already takes a per-entry-point `actor`**, and
  `CreateApprovalActor` (`:199-208`) already declares **`tenantId?: string`** at `:203`. The two callers
  already pass different objects.
- A per-caller derivation, resolved in each caller and passed through that existing parameter, leaves the
  shared INSERT consuming exactly one value. **Different arms per writer are implementable without
  splitting the INSERT.**

r1's own §2.4 cites that very field and then asserts the coupling anyway. The error is a conflation of
**channel** with **provenance**: refusing `actor.tenantId` as a forgeable *source* (§2.2(i), correct)
does not make the actor parameter unusable as a *channel* for a server-derived value.

**What replaces it.** Landing W-1 and W-2 in one slice remains a **recommendation**, for a good reason:
whatever is placed at the shared INSERT changes the second writer's behaviour, so the second writer's
fixtures must be in the same slice or that change is untested. That is a testing-discipline preference,
not physics, and §5's ordering item 3 now says so. **The practical consequence of the withdrawal is that
arm (g) — which needs an HTTP request and is therefore W-1-only — becomes implementable at all.**
---

## 3. Open design decisions — arms, and ONE recommendation each

Arm vocabulary, used uniformly below:

- **(a)** derive from the **keying user's** active `user_orgs` memberships; exactly-one ⇒ stamp;
  ≥2 or 0 ⇒ FAIL LOUD (values-free).
- **(b)** require `req.authenticatedTenantId` and refuse otherwise.
- **(c)** a channel-scoped constant (config/env).
- **(d)** leave NULL and scope the channel out of the pin, as `plm:` is under OD-S1-18.
- **(e)** derive from an owning domain entity's org. **Refuted at this baseline for W-1 and W-2**
  (`approval_templates` carries no org column in any migration — landed-migration docblock
  `zzzz20260821100000…:39-41`, re-verified by sweeping all five migrations that touch the table;
  `meta_bases` §2.4). **For W-3 and W-4 an owning-entity org DOES exist** and (e) is a real arm there —
  see OD-L11-6 and OD-L11-7. r1's blanket "no owning entity carries an org for W-1/W-3/W-4 either" is
  **withdrawn**; it cited W-1 evidence for a four-writer claim.
- **(f)** **validated selector** (the `resolvePunchOrgIdV1` shape): the caller may name an org **on the
  create request**; it must be an active membership **of the principal named below** or the request is
  refused; if none is named, fall to (a).

  **(f)'s validation principal — specified at r3 (round-2 review P2-A), because W-4's cross-user
  posture is the only place it matters and W-4 is the writer (f) is recommended for.** The named org
  must be an active membership of **the SUBJECT (= the requester OD-L11-1 keys on)**, not of the acting
  caller. Rationale: (f) exists to let a caller *disambiguate among facts the server already holds about
  the row's requester*; validating against the operator would stamp a row with an org the requester may
  not belong to, which is exactly the "requester cannot read their own instance" failure OD-L11-1 rules
  against. **This is a specification, and it is narrower than what the repo already does.** The shipped
  W4C-3b boundary additionally **conjoins the actor** (`w4c0-authorization.ts:344-346`,
  `requireActiveMembership(verified.actorId)`, skipped only at `actorPosture === 'platform_admin'` and
  waived wholesale for the registered internal scheduler identity), and checks **neither** principal
  when `subjectScope.kind === 'org_scheduler'` (`:315-320` yields no subject ids). An implementing slice
  inherits that conjunct on the validated leg; the ruling here is only that **the subject's memberships
  are the ones the stamp must be justified by**. §2.3.

  *r2 left this open. The cited punch precedent does not settle it either — `resolvePunchOrgIdV1`
  validates against `extractPunchCallerUserIdV1(req)`, the **caller**
  (`plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs:139-140`), and punch is
  self-service, so caller ≡ subject there; its own docblock scopes it to `POST /api/attendance/punch`
  (`:119`). The settled in-repo answer is the boundary's, not punch's.*
- **(g)** *(new in r2 — review P2-2)* **token-claim, re-validated**: if `req.authenticatedTenantId` is
  present **and** is still one of the keying user's active memberships **at create time**, stamp it;
  otherwise fall to (a). Differs from (b) in refusing nothing that (a) refuses, and from (f) in the
  **arrival channel** — the selection was made at login and validated by the server then
  (`AuthService.ts:390-403`), not named on this request.

**Why (g) must carry the re-validation, stated before it is used.** The bare form — "trust the claim" —
is arm (b) with a fallback, and it inherits (b)'s defect: the claim is minted at login, so a membership
deactivated afterwards still yields it, and stamping a stale org produces a row the reader's *fresh*
union denies. That is outage class 4's "stamped but still dark" shape arriving through staleness instead
of namespace. **Re-validated (g) has no staleness window**; unre-validated (g) is not posed.

### OD-L11-1 — the keying user is the **REQUESTER**, not the acting principal

| Arms | Recommendation |
|---|---|
| (i) key the derivation on the **requester** recorded in `requester_snapshot->>'id'`; (ii) key it on the acting principal (`actor.userId` / `route.actorId`); (iii) require them to be equal and refuse otherwise | **(i) — requester.** |

**Why.** Predicate arm 1 (OD-S1-3, RATIFIED) is `i.requester_snapshot->>'id' = viewerId`
(`approval-instance-readability.ts:199`). If a writer stamps from the *actor's* memberships where
actor ≠ requester, the **requester cannot read their own instance** once the pin activates — the exact
shape the evidence pack's `p52` probe was written to count.

**Where actor ≠ requester actually arises — W-4 ONLY (r2, narrowed twice).**

- **Not on W-1**: `createApproval` calls `assembleCreationContext(request, actor)` with no
  `requesterOverride` (`:7485`; the sole override caller repo-wide is the preview path `:7366-7371` —
  *r3, NIT-2: `:7342` passes none*), so
  the requester snapshot id is `actor.userId` structurally (§2.1). The independent review's own consumer
  sweep agrees from the other end: the Vue app has exactly one create flow
  (`apps/web/src/views/approval/ApprovalNewView.vue:1458` → `apps/web/src/approvals/store.ts:149-153` →
  `apps/web/src/approvals/api.ts:1067,1077` → `POST /api/approvals`) with **no create-on-behalf-of**
  path — paths corrected here; the review's `views/approvals/…` spelling does not resolve at
  `604ae14e26`.
- **Not on W-2 either — and this corrects the review as well as r1.** `loadAuthorizedActor`
  (`multitable/automation-approval-bridge-service.ts:447-502`) resolves **one** identity — the
  `config.requester?.mode === 'rule_creator' ? ruleCreatedBy : (context.actorId || ruleCreatedBy)`
  selection at `:460-462` — and `startApproval` passes exactly that object as the `actor` argument to
  `createApproval` at `:271-274`. Since W-2 goes through the same `assembleCreationContext` collapse,
  **requester ≡ actor on W-2 too.** The `:460-462` selection is an **upstream nomination** of which user
  becomes the single identity; it is not a divergence the writer can observe. r1 (and this section in
  its first r2 form) listed W-2 as a divergence site; that is **withdrawn**.
- **W-4** — attendance cross-user creates with postures `operator` / `attendance_admin`
  (`plugins/plugin-attendance/index.cjs:33178-33183`,
  `crossUser = String(subjectUserId) !== String(route.actorId)`). **This is the only writer on which an
  actor≠requester fixture is constructible**, which is what G-L11-6 must be written against
  (`feedback_fixture_shape_must_match_named_scenario`).

**The W-2 question this reframing opens, and that OD-L11-1 must therefore ask.** Because W-2 collapses,
the interesting question is not "requester or actor" but **"is the bridge's nominated user the right
keying user?"** Under `mode === 'rule_creator'` the org is the rule author's; otherwise it is the
triggering actor's. Those are different tenants for the same rule, chosen by a per-action config field.
OD-L11-5's honest residue already names the rule-creator half; the config-dependent half is named here.
It is **not** a new arm — both nominations feed the same derivation — but it means W-2's stamped org is
a function of an automation **config setting**, which an owner ruling D-3 should know.

**Honest consequence, corrected.** r1 said "an admin creating on behalf of a member of a *different* org
stamps the requester's org and is then denied their own creation". That is real, but **not on the
platform HTTP route**, and — corrected a second time — **not on W-2 either**. It is reachable on **W-4's
cross-user postures** and through any SDK/API consumer that acquires a create-on-behalf capability later.
Where it is reachable,
the creator reads their own creation only through the admin bypass (OD-S1-8, kept per OD-S1-8(d)). That
is the correct trade, but it must be stated, not discovered.

**Interaction with §2.8.** Keying on the requester means a *zero-membership requester* refuses the create
even when the **actor** has a perfectly good single membership. On W-4 that is an operator being unable
to file a request for a newly-provisioned employee — the single most likely first production symptom.

*Status: DRAFT — OWNER-CONFIRM.*

### OD-L11-2 — ONE derivation primitive, server-side, homed once

| Arms | Recommendation |
|---|---|
| (i) one exported helper `deriveApprovalInstanceOrgId(db, keyingUserId, opts?)` reused by all landing writers; (ii) per-writer inline SQL; (iii) reuse `AuthService.resolveSessionTenantId` directly | **(i)** — with an explicit **agreement mandate**, below. |

**The agreement mandate (r2 — replaces r1's "byte-identical", review P2-1).** r1 required the helper's
SQL to be "**byte-identical** to `resolveSessionTenantId`'s no-requested-tenant branch **and** to the
reader's `loadViewerOrgIds` predicate (`is_active = TRUE` on `user_orgs` **and** on `users`)". Three
things were wrong with that and all three are withdrawn: the symbol `loadViewerOrgIds` **does not exist**
(the reader is `viewerActiveOrgIds`, `approval-instance-readability.ts:152-157`); the parenthetical is
**false of the reader**, whose SQL is `SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active =
TRUE` with **no `users` join** (`:153`); and byte-identity is **category-wrong** — the writer's rule is
scalar-or-refuse, the reader's is a set union consumed as `AND i.org_id = ANY($4::text[])` (`:193`), so
they can never be byte-identical.

What the helper must instead be mandated to agree on, and be gated on:

1. **Namespace** — it reads `user_orgs.org_id` and nothing else. No attendance org table, no
   `directory_integrations.org_id` read, no install-context tenant.
2. **Membership-liveness semantics** — *which* `is_active`, on *which* tables. §2.3's census shows the
   repo does not agree with itself: the reader and the punch resolver check `user_orgs.is_active` only;
   `resolveSessionTenantId` checks `user_orgs.is_active AND users.is_active`. **This is an owner-visible
   fork, posed as D-9**, because the two choices differ on exactly one population — *an active membership
   held by a deactivated user* — and they fail in opposite directions:
   - **dual-`is_active` (the `resolveSessionTenantId` / RD-3 house rule,
     `zzzz20260721150000…:27-31`)**: the writer refuses where the reader would admit. **Fail-closed at
     the writer**, and consistent with the stated house rule that the dual filter "is what excludes a
     deactivated user from every count and gate".
   - **single-`is_active` (the reader's own predicate)**: writer and reader agree exactly, which is the
     property the org pin actually needs. But it stamps for a user `users.is_active = false` — and such a
     user cannot log in, so on W-1/W-4 the case is unreachable through the acting principal; it *is*
     reachable through the **requester** keying on W-2/W-4 cross-user creates.
   **Recommended: single-`is_active`, i.e. byte-agreement with `viewerActiveOrgIds`'s predicate**, because
   the invariant this slice exists to protect is "a stamped row is readable by its own requester", and
   only the reader's own predicate guarantees it. The dual-filter divergence is fail-closed but produces
   a 422 that no reader-side rule explains. **This is a recommendation, not a ruling: D-9.**
3. **Failure shape** — a refusal, never `undefined`-then-NULL (see OD-L11-3 and "why not (iii)").

**Why not (iii):** `resolveSessionTenantId` swallows DB errors and returns `undefined` (`catch` at
`AuthService.ts:419`, `return undefined` at `:421`) — correct for a login path, **fatal** for a writer,
where "no org" must be a refusal, not a silent NULL that goes dark at activation. Reusing it directly
imports a fail-*open* posture into a fail-closed site. **Why not (ii):** two writers drifting apart on
`is_active` is the `feedback_failclosed_doors_cover_for_each_other` shape — and §2.3's census shows the
drift already exists between three sibling readers, so this is an observed hazard, not a hypothetical.

**Gate consequence:** G-L11-5 gains a case whose fixture is *an active membership held by an inactive
user*, because that is the only fixture on which the two liveness predicates disagree. r1's single-
membership fixture cannot distinguish them.

*Status: DRAFT — OWNER-CONFIRM.*

### OD-L11-3 — the failure shape is a values-free refusal, never a default

| Arms | Recommendation |
|---|---|
| (i) `422 APPROVAL_ORG_UNRESOLVED`, values-free (no org id, no membership count, no user id echoed); (ii) `403`; (iii) stamp NULL and let the pin decide later | **(i).** |

`(iii)` is not a milder option — it is the outage, deferred: OD-S1-9(e) makes such a row false for
everyone including admins from activation. `(ii)` mislabels a *derivation* failure as an authorization
failure on a request the caller was authorized to make. Values-free discipline follows the in-repo
precedent that already declares it (`attendance-punch-org-resolution.cjs` header: "Values-free by
construction … never a fabricated or echoed-back value beyond what the caller supplied") and
`feedback_client_values_free_by_construction`.

Non-HTTP writers (W-2, W-3) raise the equivalent typed service error rather than an HTTP status;
W-2's existing family is `ServiceError(..., 4xx, 'START_APPROVAL_*')`.

**Published-contract consequence (r2 — review P2-3, entirely absent from r1).** `422` is **not in the
published contract for this operation**. The source spec `packages/openapi/src/paths/approvals.yml:76`
(`operationId: createApproval`) documents responses `201 / 400 / 401 / 403 / 503` and no 422; the
generated artifacts carry the same set at `packages/openapi/dist/openapi.yaml:5931` (responses
`:5952-5976`), `packages/openapi/dist/openapi.json:8131`, and
`packages/openapi/dist-sdk/index.d.ts:412` / `:17076`. **SDK consumers call over the wire, so no
`createApproval(` source census can see them.** Adding the 422 therefore has a mandatory surface list:

1. edit the **source** `packages/openapi/src/paths/approvals.yml` (not `dist/`);
2. `pnpm --filter @metasheet/openapi generate:sdk`;
3. `git diff --quiet` on `dist/` and `dist-sdk/` must then pass (the regeneration is the diff);
4. `pnpm --filter @metasheet/openapi guard:codegen`
   (`packages/openapi/tools/guard-codegen.mjs:1-11` states this exact three-step contract and warns that
   mtime is not load-bearing proof).

This is a **public contract change** and lands under §5 ordering trap 1 — which now covers arm (a), not
only (b)/(f). Outage class 7.

*Status: DRAFT — OWNER-CONFIRM.*

### OD-L11-4 — **W-1**, `POST /api/approvals` platform create

**r2 re-derivation of the refusal populations (review P1-1).** r1's table told the owner that arm (b)
"refuses the same population" as (a). It does not. With §2.2 corrected, and writing `Z` for the
zero-membership set (§2.8) and `M` for the set of users with ≥2 active memberships:

| Arm | Refuses |
|---|---|
| (a) | `Z ∪ M` |
| (b) | `Z ∪ {m ∈ M : did not select an org at login}` ∪ `{every session whose token predates the claim}` |
| (f) | `Z ∪ {m ∈ M : named no org on the request}` |
| (g) | `Z ∪ {m ∈ M : holds no currently-valid claim}` — i.e. did not select at login, **or** selected and the membership has since been revoked (re-validation then drops them to (a)) |

So **(b) ⊊ (a) on the membership axis** (its extra refusals are session-age, not membership), and
**(g) ⊊ (a) strictly**, with none of (b)'s session-age cost and none of its staleness. r1's table pointed
the owner the other way, and D-3 asked them to confirm that comparison.

| Arm | Consequence if chosen |
|---|---|
| **(a)** requester's `user_orgs`, exactly-one ⇒ stamp | Refuses `Z ∪ M`. Zero-impact **iff** `Z` and `M` are both empty in prod (§8-U1 — **two** counts, and `Z` is structurally non-empty wherever self-registration or DingTalk login has been used, §2.8). Fresh at create time, so a membership change since login is honoured. Write-side twin of Migration-B class 3 as ruled at Lock-10 `:873`. Deterministic from DB state alone — the same user always gets the same answer. |
| (b) require `req.authenticatedTenantId` | **Corrected**: refuses a strict subset of (a) on the membership axis. Still rejected, on three surviving grounds: it stamps a **stale** org for a user whose memberships changed after mint (no re-validation); it refuses **any live session whose token predates the claim**, i.e. a re-login wave (§8-U2); and it is inapplicable to W-2/W-3/W-4, so the platform would derive its org by a rule no other writer can use. **Arm (g) dominates it on every one of these axes**, so (b) should not be chosen over (g) under any reading. |
| (c) constant | Un-derived value that reads as legitimate membership — the OD-S1-9(a) hole through the front door. Rejected. |
| (d) leave NULL, scope platform out of the pin | Scopes out the **entire** platform population, i.e. deletes the pin. Rejected. |
| (e) template's org | `approval_templates` has **no org column** in any of the five migrations that touch it; the landed migration's docblock says so at `:39-41`. Refuted **for W-1** (this is the evidence r1 over-generalised to all four writers). |
| (f) validated selector on the request, falling back to (a) | Lets a genuine multi-org user create by naming one of their own orgs. Blocked on OD-L11-8/D-1. |
| **(g)** token claim re-validated at create time, falling back to (a) | **New in r2.** Refuses `Z ∪ {m ∈ M holding no currently-valid claim}` (no login selection, or a selection since revoked) — strictly fewer than (a), strictly fewer than (b), and with no staleness window. Source is the RATIFIED "only authoritative request-scoped field", set claim-only (`jwt-middleware.ts:101-104`) with the header backfill reaching only `req.user.tenantId` (`:107-108`). Coherent on W-1 specifically because requester ≡ actor there (§2.1). W-1-only: W-2/W-3 have no request, and on W-4 the token's tenant belongs to the operator, not the subject the derivation keys on. |

**Recommended: (a) as the derivation floor** — with **(g) posed as a live alternative the owner must
choose between (D-7)**, and **(f)** as the named follow-up **if and only if** OD-L11-8 rules that a
membership-validated selector is not "the caller supplying the org".

**Why (a) is still the floor, and why "dominant" is withdrawn.** (a) (1) uses a rule already ruled
well-defined for the same fact (Lock-10 `:873`), (2) reuses a shape already implemented in-repo
(`AuthService.ts:405-418`), (3) reads the fact *fresh* at create time, and (4) **generalises to the
writers that have no HTTP request** — which is why it must be built regardless: (g) and (f) both fall
back to it. What r1 got wrong is that (a) *dominated*; it does not. Against (g) it has exactly one real
advantage, and one real disadvantage:

- **For (a):** determinism. Under (g), two users with identical memberships get different stamps
  depending on *how they logged in* — a selection they cannot see, cannot change in-product, and which
  today is reachable only through an undocumented `?tenantId=` URL parameter (§2.2(iii)). An invisible
  input to a tenancy decision is a support-load and audit hazard of its own.
- **For (g):** it serves a real multi-org user instead of 422-ing them, and it does so through the
  RATIFIED field.

That trade is a product judgement about a shipped-behaviour narrowing, not a code fact — so it is
escalated (**D-7**) rather than ruled here.

**Does (g) require resolving D-1?** *Probably not, and this lock declines to assert it.* The argument
that it does not: (g)'s value arrives on the token, and OD-S1-17(b) — RATIFIED — already names that
field authoritative, so a reading of OD-S1-9(f) strict enough to reject (g) would also reject the
ratified field's own production chain, which is self-defeating. The residual strict reading that keeps
it inside D-1: **the caller did supply the org, one request earlier**, via `x-tenant-id` at
`routes/auth.ts:703`. Both readings are recorded under D-1; the independent review's "may be rulable
without resolving D-1" is a *may*, and turning it into a *does* would be exactly the overclaim class this
lock exists to prevent.

*Status: DRAFT — OWNER-CONFIRM.*

### OD-L11-5 — **W-2**, multitable automation bridge

| Arm | Consequence |
|---|---|
| **(a)** keyed on the resolved requester (`loadAuthorizedActor`'s `userId`, already validated live against `users` **and** required to hold `approvals:write` or be an admin — `multitable/automation-approval-bridge-service.ts:468-493`; that single identity is passed straight through as `createApproval`'s `actor` at `:271-274`, so requester ≡ actor here, §OD-L11-1) | An automation whose requester is multi-org **or zero-membership** fails the step with a typed error instead of creating a dark instance. The requester is **already** a real, active platform user here — the strongest precondition of the four writers, though `users`-liveness is not `user_orgs`-membership (§2.8). |
| (b) require an authenticated tenant | **Inapplicable — there is no HTTP request on this path** (§2.4). |
| (c) constant | Same rejection as W-1, plus it would tenant every automation-created approval into one org regardless of which base triggered it. |
| (d) leave NULL, scope automation out of the pin | Every automation-created approval goes dark for its own requester and approvers at activation. For a channel that creates *ordinary platform approvals with ordinary seats*, this is an outage, not a carve-out. |
| **(e)** base/sheet org | **Refuted at this baseline (§2.4)** — `meta_bases` has no org column in any migration; the `sheet_id → base_id → meta_bases` chain terminates without an org, and neither hop is FK-enforced. Would be the *more correct* arm if such a fact existed (the instance belongs to the base's tenant, not the rule-creator's), so it is recorded as the named exit, not as an option today. |
| (f) / (g) | **Inapplicable** — no request, no token. |

**Recommended: (a).** **Why:** it is the only arm with a source on this path, and the source
(`loadAuthorizedActor`'s already-liveness-checked `userId`) is better than W-1's, not worse.

**~~Structural constraint~~ → WITHDRAWN; restated as a landing preference (r2, review P1-4).** r1 claimed
W-1 and W-2 "CANNOT be ruled independently" because they share the INSERT. §2.9 refutes that:
`createApproval(request, actor)` already takes a per-entry-point actor carrying `tenantId?`
(`ApprovalProductService.ts:203`), which is a usable **channel** for a server-derived value even though
it is a refused **source**. Different arms per writer are implementable without splitting the INSERT.

**What survives as a recommendation.** Land W-1 and W-2 in **one slice**, because whatever is placed at
the shared INSERT changes the second writer's behaviour, so both writers' fixtures — including the
multi-org and zero-membership negatives for *both* keying users — must be in that slice or the second
writer's behaviour changes untested. That is a testing-discipline preference (§5 item 3), not physics,
and an owner may overrule it.

**Honest residue:** an automation belongs to a *base*, and (a) tenants its approvals by whoever created
the rule. If the rule creator later changes org, new instances follow them. That divergence is real and
only arm (e) fixes it; the fix is a multitable-schema slice this lock does not authorize.

*Status: DRAFT — OWNER-CONFIRM.*

### OD-L11-6 — **W-3**, after-sales refund bridge (`afs:` ids)

| Arm | Consequence |
|---|---|
| (a) requester's `user_orgs` | **Unsafe as-is**: `command.requester.id` is a bare required string never validated against `users` (`AfterSalesApprovalBridgeService.ts:360`), and `'system'` is a reachable value (§2.5). Under (a) that requester has zero memberships ⇒ every such submission fails loud ⇒ the refund channel breaks for those call paths. This is the **zero-membership class** (§2.8) in its sharpest form: the principal may not be a `users` row at all. Viable **only if** paired with a `users`-validation of `requester.id` (making W-3 look like W-2) — which is a change to the after-sales channel's contract, not this derivation. |
| (b) / (g) | Inapplicable — the service is reached through a plugin `communication.call` seam (`plugins/plugin-after-sales/index.ts:1743-1744`), not an HTTP request; there is no token on this path. |
| **(c)** a channel-scoped org constant (config/env, boot-asserted) | **This is the refused shape, and the lock does not reframe it into compliance.** The docblock's sentence is about the *absence of a source* — the after-sales org "has no plumbing anywhere in the repo … an unset value must ABORT … never default" (`zzzz20260821100000…:46-49`) — and a config constant does not create a source, it asserts one. OD-S1-9(f) (RATIFIED) requires the org to be "derived server-side"; a constant is derived from neither side, so it is the OD-S1-9(a)/(f) shape whatever the boot assert does. A boot assert only bounds the *misconfiguration* case; it cannot make an asserted tenant into a derived one, and §7 outage class 5 records that **no gate in §4 can detect a wrong constant**. It stays on the fork for exactly one reason: arm (d)'s cost — live role-typed seats going dark — may be worse than an asserted tenant. That is a legitimate owner fork; it is not a finding that (c) is compliant. **It is also the only arm on the menu that serves a zero-membership principal (§2.8), which is an argument for it that r1 never made and which the owner should weigh.** |
| (d) leave NULL, scope `afs:` out of the pin like `plm:` | Cheapest, and **not** symmetric with PLM: Lock-10 §2.2(b) class 4 (`:376`) records that `afs:` rows carry real `'role'`-typed seats (`AfterSalesApprovalBridgeService.ts:568-572`) and are "S1-**admissible** by arm 2: they need an org source, not an arm." Scoping them out takes **live approvers** dark at activation, and it widens the OD-S1-18 carve-out — which Lock-10 §5.2(iii) already flags as a residual that "no copy anywhere may describe … as participant-scoped without this qualifier". |
| (e) owning-entity org — the install-context tenant | **Posed and rejected, with W-3 evidence (r2).** An owning entity *does* exist on this channel: `plugin_after_sales_template_installs` is keyed `(tenant_id, app_id)` (`zzzz20260407140000…:57-58`), and the refund command carries `subject.projectId` / `subject.ticketId` (`AfterSalesApprovalBridgeService.ts:150-157`). Rejected because the install tenant is resolved from the event **payload** (`plugins/plugin-after-sales/lib/workflow-adapter.cjs:183-208`) — the OD-S1-9(f) refused shape — **and** its namespace relative to `user_orgs.org_id` is unverified (§8-U5). r1 asserted "no owning entity carries an org" for this writer; that sentence is **withdrawn** and replaced by this rejection-on-the-merits. |

**Recommended: escalate the (c)-vs-(d) fork to the owner; if forced to one, (d) NOW + (a)-with-validation
as the named follow-up.**
**Why (d) now:** it is the only arm that stamps nothing it cannot justify, and it is reversible — a later
slice that validates `requester.id` against `users` converts W-3 into W-2 and lets (a) apply. **Why not
(c) now:** the channel constant is an un-derived tenant on rows with real seats, so a mis-set value
silently grants cross-tenant read to a role holder in the wrong org — a *widening*, which by Lock-10
§5.1's own reasoning is outside an executing session's authority.
**The cost of (d), stated plainly:** every `afs:` instance is unreadable to its approvers on the S1
consumers from pin activation, unless `afs:` is added to the pin's id-shape bypass alongside `plm:`.
That bypass edit is itself a scope change to OD-S1-18 and would need owner sign-off. **This is a real
outage class, not a bookkeeping choice, and it is why this writer is escalated rather than recommended.**

*Status: DRAFT — OWNER-CONFIRM (this is the sharpest of the four).*

### OD-L11-7 — **W-4**, attendance plugin

| Arm | Consequence |
|---|---|
| (a) requester's (= subject user's) `user_orgs`, exactly-one | **Row corrected at r3 (round-2 review P1-B). r2 said these paths have "no membership check at all today"; that is FALSE** — on the validated leg (non-null `operationId`) the W4C-3b boundary already runs `requireActiveMembership` in-transaction before any approval DML (§2.3). Two consequences r2 did not show the owner: **(1) arm (a) would 422 a request the boundary just authorized, on the same `trx`** — a multi-org subject whose caller names one of the subject's valid orgs passes `requireActiveMembership` (the named org *is* an active membership), then arm (a) ignores the name, sees ≥2 memberships, and FAILs LOUD. The authorization layer admits and the writer refuses, on one request. **(2)** On the **legacy leg** (`operationId` omitted) there is no check, so arm (a) there is a genuinely new refusal. Still refuses a multi-org subject, **and refuses every newly-provisioned subject (§2.8) — the most likely first production symptom on this writer**. |
| (b) authenticated tenant | The attendance routes never read `req.authenticatedTenantId` except behind two forgeable fields (`getAuthenticatedOrgId`, `plugins/plugin-attendance/index.cjs:6328-6334`); adopting (b) would mean rewriting the attendance request-create boundary's org contract — the change #5098's E-4 explicitly declines to make in-slice. |
| (g) token claim re-validated | **Inapplicable in the general case**: OD-L11-1 keys on the **subject/requester**, while the token's tenant belongs to the **operator**. On the cross-user postures (`:33178-33183`) those are different principals, so (g) would key the wrong user. Not posed. |
| (c) constant | It already effectively **is** `'default'` via `DEFAULT_ORG_ID` (`:49`) — the named anti-precedent. Rejected. |
| (d) leave NULL | Every attendance request approval dark at activation, including the approver seats. Attendance is the highest-volume approval channel in the product; this is the largest outage of the four. |
| (e) owning-entity org — `attendance_requests.org_id` | **Posed and rejected, with W-4 evidence (r2).** An owning-entity org *does* exist here and is written in the **same transaction**: `:33356` upserts the approval instance, `:33358-33362` inserts `attendance_requests` with `org_id = route.orgId` (`:33366`); the column is `text NOT NULL DEFAULT 'default'` (`zzzz20260114100000…:51-56`). Stamping the instance with the same value would guarantee the two agree, which is a real referential-consistency argument. **Rejected because that value IS `getOrgId(req)`** — an unvalidated caller-supplied string with a `'default'` fallback (`:6318-6326`), i.e. arm (e) here is arm (c)/refused-shape wearing a referential wrapper, and it is tainted by the `DEFAULT 'default'` family OD-S1-9(a) names as the anti-precedent. r1's blanket "no owning entity carries an org for W-4" is **withdrawn**; the arm exists and is rejected on the merits. **Its consequence does not go away: see outage class 6 and gate G-L11-8.** |
| **(f)** validated selector on the request | The **natural** arm here — and **r3 re-sizes it in the favourable direction (round-2 review P1-B)**. r2 said "extending it from the punch route to the request-create routes is a small, precedented change". It is smaller than that: **on the validated leg the validation is ALREADY IN PRODUCTION on this exact writer** — subject-and-actor-keyed, in-transaction, before the first approval DML, on all five call sites (§2.3). What the slice adds there is the **stamping of an already-validated org onto `approval_instances`**, not the validation. The precedent is no longer an analogy from another route; it is this writer's own boundary. Blocked on OD-L11-8/D-1. |

**Recommended: (f) if OD-L11-8 permits it; otherwise (a). Arm unchanged at r3; its basis is
materially stronger and its scope is corrected.**
**Why:** unlike the other three writers, W-4's caller *does* supply an org and the product *does* depend
on that selection (an operator acting for a specific org). (f) keeps that capability while making the
value membership-validated rather than trusted; (a) preserves correctness but silently ignores a
selection the UI already sends — which will read as a bug to attendance operators. **r3 adds a
decisive argument r2 could not make:** on the validated leg, (f) is the arm that *agrees with the
authorization decision already taken one call earlier*, while (a) contradicts it inside the same
transaction (arm-(a) row above, §0.1 item 5). An owner ruling D-1 against (f) should understand that
they are choosing to have the writer refuse what the boundary admitted.

**Named residue — the legacy leg (r3, new; NOT a new decision, per the menu-stability constraint).**
The strengthened basis holds **only where validation runs**. On the `operationId === null` legs
(`w4c3b-request-operation-boundary.ts:427-437` and `:449-466`) the adapter — and therefore
`upsertAttendanceApprovalInstance` — executes with no membership check, and
`legacy_projection_only` is the effective posture for **every** org today (`w4c0-identity.ts:377`).
The implementing slice must choose, explicitly, one of:

- **(α) inherit the bypass** — stamp `getOrgId(req)`'s value unvalidated on that leg. This re-imports
  the refused shape (`'default'` fallback, caller-supplied string) into the column OD-S1-9(a) exists to
  protect, on a leg that is not narrow.
- **(β) extend the derivation there too** — the legacy leg then starts refusing creates it accepts
  today. That is a **shipped-behaviour narrowing for the legacy-client population**, and it therefore
  falls under §5 ordering trap 1 alongside the other refusing arms.
- **(γ) refuse the legacy leg for approval-creating operations** — the sharpest, and the largest
  behaviour change.

**Nothing here can be sized from the repo**: how much live traffic omits `operationId` is **U8**, and
U8 blocks the *sizing claim* "the validation is already there" in the same way U1a/b/c block arm (a)'s
"zero-impact today". It does not block the arm choice.

**Risk re-grade (r2 — r1's "the most dangerous of the four" / "worst of the four" is WITHDRAWN, review
P2-5/P2-6).** r1 graded W-4 worst on the theory that the attendance `orgId` namespace and
`user_orgs.org_id` might be **different value domains**. §8-U3 is now split: the namespace-divergence
half is **resolved against the repo** — the two coincide by construction for every admitted org, because
`routes/admin-users.ts:3826-3830` writes the *attendance* org id straight into `user_orgs` after
validating it against `directory_integrations.org_id` (`:3631-3636`, 404 `ATTENDANCE_ORG_NOT_FOUND`,
"ships fail-closed"), and `zzzz20260721150000…:49-59` populates `user_orgs.org_id` from the same
`directory_integrations.org_id`. **The real residual is not a mapping problem, it is an
unvalidated-input problem**: `getOrgId` returns any caller string or `'default'`. **That is precisely
what arm (f) closes**, which strengthens the recommendation rather than qualifying it. The narrowed
field question that remains is §8-U3': do prod attendance rows carry org ids absent from `user_orgs` —
and its residual is bounded by the same `'default'`-dominance that bounds everything else here
(`directory_integrations.org_id` itself defaults to `'default'`,
`zzzz20260324150000…:16`).

**Detection responsibility, corrected.** r1 said "G-L11-4 exists precisely to red on that", and the gate
table said G-L11-5 "is the only gate that can catch 'stamped but still dark'". **Both claims are
withdrawn** — see §4's note on G-L11-5 and §9/P2-6. Field divergence is detected by the §8-U3' probe as
an **activation precondition**, not by any gate in this table.

*Status: DRAFT — OWNER-CONFIRM.*

### OD-L11-8 — does OD-S1-9(f) forbid a caller-named, membership-validated org?

| Arms | |
|---|---|
| (i) YES — any caller-named org is refused; multi-org callers get a 422 and the product grows an out-of-band org-switch | |
| (ii) NO — a value the server validates against the caller's **own** active memberships is server-derived; the caller only disambiguates among facts the server already holds | |

**Not recommended here.** This is a reading of a RATIFIED OD (`:809`), and per Lock-10 §5.3's own
delegation test, ratified text whose operative word is a prohibition delegates nothing.

**THREE in-repo precedents assume (ii), not one (r2 review P1-2 found the second; r3 / round-2 review
P1-B adds the third, which is the closest).** r1's census named only
`attendance-punch-org-resolution.cjs` (shipped, one plugin route). The second is more central:
**`AuthService.resolveSessionTenantId`'s requested branch** (`AuthService.ts:390-403`), fed from request
input at `routes/auth.ts:703`, `:627`, `:806` — caller names an org, server admits it only if it is one
of the caller's own active memberships — **implemented on the token-minting path**.

**The third precedent sits on this very writer, and it is Channel B.** The W4C-3b request-create
boundary already takes an org **named on the create request** (`getOrgId(req)` → `envelope.orgId`) and
admits it only if it is an active `user_orgs` membership of the subject (and, except at
`platform_admin` posture, of the actor) — `packages/core-backend/src/attendance/w4c0-authorization.ts:310`,
`:329-335`, reached from `plugins/plugin-attendance/index.cjs:30062` via
`w4c3b-request-operation-boundary.ts:479` and `w4c0-operation-registry.ts:596`, **in-transaction, before
the first approval DML** (§2.3). This matters to D-1 in a way r2's two-precedent census did not capture:

> **Channel B is not a new capability this lock would introduce — it is a shipped, in-production
> mechanism on the write-authorization path.** An answer of "forbid both channels" would therefore rule
> a *landed* mechanism non-compliant with a RATIFIED OD, not merely decline to add one. That is a
> materially different decision from the one r2 posed, and the owner should be told which one they are
> making. This lock does **not** infer from "it is shipped" that it is compliant
> (`feedback_implementation_is_not_the_ratified_contract`); it records that the stakes of answer (i)
> include an existing surface.

**And the ratified field is itself its output.** OD-S1-17(b) (`:818`, RATIFIED) names
`req.authenticatedTenantId` "the only authoritative request-scoped field". On the chain above, **that
field's value is a caller-named, membership-validated org**. So the ratified text already blesses the
validated-selector **provenance**. What is genuinely open is the **channel**:

- **Channel A (token)** — the selection happens at login, is validated then, and reaches the writer as
  the ratified field. Arm (g). The residual objection: the caller did supply it, one request earlier.
- **Channel B (create request)** — the selection is named on the create call and validated there.
  Arm (f). This is the channel `resolvePunchOrgIdV1` uses, the channel the **W4C-3b boundary already
  uses in production** (r3), and the one r1's D-1 was about.

**D-1 is therefore restated as a channel question, and it now has three possible answers** — forbid
both, permit A only, permit both — where r1 posed a binary. Permitting A only is coherent: it is the
reading under which OD-S1-9(f) governs *this* request and OD-S1-17(b) governs what the token may carry.

**This decision gates arm (f) on W-1 and W-4. It may or may not gate arm (g) on W-1** — see OD-L11-4's
"Does (g) require resolving D-1?".

*Status: DRAFT — OWNER-CONFIRM. Blocking OD-L11-4's (f) follow-up and OD-L11-7's recommendation;
possibly not blocking D-7.*

### OD-L11-9 — **W-4's `DO UPDATE` branch**: does a re-submit re-derive the org? *(new in r2 — review P2-9)*

`upsertAttendanceApprovalInstance` (`plugins/plugin-attendance/index.cjs:24059-24086`) is an UPSERT.
Adding `org_id` to the column list is not one decision but two, and r1 posed neither.

**The false premise r2 built this OD on, corrected first (r3, round-2 review P1-A).** r2's arm (i) cell
read: "…the subject can no longer read their own instance via the org conjunct *(they still read it via
predicate arm 1 as requester — `approval-instance-readability.ts:199` — but their approvers in the new
org do not)*". **The parenthetical is false, and the sentence is incoherent under both readings of
"membership changed."** The org pin is **not** a per-arm condition. Re-read at `604ae14e26`,
`approval-instance-readability.ts:188-194` builds `orgClause` only when the pin is enabled, and
`:196-219` emits:

```sql
SELECT 1 FROM approval_instances i
 WHERE i.id = $1
   AND (
     i.requester_snapshot->>'id' = $2          -- arm 1        (:199)
     OR EXISTS ( … approval_assignments … )    -- arm 2
     OR EXISTS ( … approval_records … )        -- arm 3
     OR EXISTS ( … cc … )                      -- arm 4
     OR EXISTS ( … u.is_admin = TRUE … )       -- admin        (:216-218)
   )${orgClause}                               -- :219 — OUTSIDE the disjunction
 LIMIT 1
```

Line `:219` is literally `)${orgClause}`: the `)` closes the disjunction and the org conjunct is
appended **after** it. So with the pin ON and a stale row, `'O1' = ANY(viewerActiveOrgIds(subject))`
is FALSE and **the whole predicate is FALSE — the subject cannot read their own instance, arm 1 does
not rescue them, and neither does the admin arm.** This is outage class 3, the class this document
treats as the worst outcome, and it is exactly what §7 class 3 and the RATIFIED OD-S1-9(e) already
say ("false for everyone including admins"). r2 contradicted its own two statements of the same fact.

*(Both readings fail, which forecloses the obvious rebuttal. **Moved** `O1 → O2` — the reading
`G-L11-9`'s own fixture pins: the parenthetical fails, the subject is dark. **Added** `O2` alongside
`O1`: the first clause fails — the subject's orgs are `[O1, O2]`, the conjunct is TRUE, and the subject
reads the row perfectly well. There is no reading on which r2's sentence is true.)*

| Arm | Consequence, under the CORRECTED semantics |
|---|---|
| **(i)** add `org_id` to the INSERT column list **only** — `DO UPDATE` leaves it alone | A re-submit keeps the org the instance was created with. **Stable and auditable**: an instance never changes tenant after creation. **True cost: if the subject's membership moved since creation, the row goes DARK FOR EVERYONE — the subject included, and admins included — from pin activation until Migration B or an admin re-stamps it.** Not "their approvers in the new org lose read"; *all* read is lost. This also **breaks the invariant D-9's recommendation is built on** — "a stamped row is readable by its own requester" — which is why D-9 and D-10 must be read together. |
| (ii) add `org_id` to **both** the column list and `DO UPDATE SET` | A re-submit **moves a live instance between orgs at runtime**. Same hazard Lock-10 `:375` names for Migration-B class 3 ("can move a historical instance out of the tenant that ran it"), on the **write** path and at **runtime**. Approvers in the old org lose read; approvers in the new org gain it — a **widening**, which by Lock-10 §5.1's own reasoning an executing session cannot authorize. **But (corrected): it is the ONLY arm that preserves the subject's read of their own instance**, because the stamp tracks the subject's current memberships at every re-upsert. |
| (iii) add `org_id` to `DO UPDATE SET` **only when the existing value is NULL** (`org_id = COALESCE(approval_instances.org_id, EXCLUDED.org_id)`) | Heals rows created before the slice without ever moving a stamped row. **Inherits (i)'s true cost verbatim for every already-stamped row.** Costs one more branch and one more gate case. |
| **(iv)** *(new at r3 — round-2 review P3-C)* **re-derive, and if the result differs from the stored value, REFUSE the re-submit** (values-free, OD-L11-3's shape) | The only arm with **no silent outcome**: it neither darkens a row invisibly (i/iii) nor moves one invisibly (ii). It is the shape OD-L11-3 mandates on the create path ("a refusal, never `undefined`-then-NULL") and that arm (a) itself uses ("≥2 or 0 ⇒ FAIL LOUD"), so omitting it was an inconsistency in r2's own discipline. **Its cost is real and may be disqualifying**: the five call sites re-upsert on *every* state change, so a refusal wedges an in-flight attendance request at each subsequent transition, recoverable only by restoring the membership or by an admin re-stamp. |

**Recommendation: WITHDRAWN. D-10 is escalated (r3).** r2 recommended **(i)**; that recommendation
rested on the false consequence corrected above and **does not survive**. The honest framing of the
trade is not "stable and auditable (i) versus a widening (ii)" but:

> **whose read do you sacrifice — the subject's own (i and iii), or the old org's approvers' (ii) —
> or do you refuse the re-submit and wedge the request (iv)?**

No arm is recommendable by an executing session on that framing. (i)/(iii) break the very invariant
D-9's recommendation turns on; (ii) is a widening, which Lock-10 §5.1's reasoning puts outside an
executing session's authority; (iv) trades a silent failure for a loud one at a cost — mid-flow
wedging — this document elsewhere treats as an outage. **D-10 therefore joins D-2 as a fork the owner
must resolve, and it is posed without a lean.**

**The discriminator that may moot D-10 entirely.** All four arms differ only when a subject's
membership **moves between two orgs** between the create and a later re-upsert. **If §8-U1a returns
`count(DISTINCT org_id) = 1`, there is nowhere to move to and D-10 is moot.** U1a is already blocking,
so this costs no new probe. *(Same shape as D-7, which U2 may moot.)*

**Whichever is ruled, G-L11-9 must exist**, because the conflict path is reachable in production (the
five call sites re-upsert on every state change) and today no gate exercises it at all. **r3 adds a
requirement to it**: G-L11-9 as r2 specced it asserts only the stamped `org_id`, which is green under
both the true and the false consequence — it must also assert **who can still read the row** after the
move. See §4.2.

*Status: DRAFT — OWNER-CONFIRM. No recommendation; escalated fork.*

### OD-L11-10 — the same-transaction split-brain on W-4, and which arms create it *(new in r2 — review P2-7; SCOPE corrected at r3 — review P2-A)*

*(r3: r2's heading read "the split-brain **the recommended arm** creates on W-4". W-4's recommended arm
is **(f)**, and with (f)'s validation principal now specified, **(f)-with-a-name does not create the
divergence at all** — see the scope paragraph below. The heading is corrected so it does not contradict
its own body, and the same correction is propagated to §7 class 6 and D-11.)*

**Scope, corrected at r3 (round-2 review P2-A).** r2 opened "Under (a), (f) or (e)-rejected-but-
instructive…", which overstates. With arm (f)'s validation principal now specified (§3) and its
outcome being *stamp the named org*, **(f) with an org actually named produces the same value
`attendance_requests` gets** — the stamp **is** `route.orgId` by construction, so the two agree and no
split-brain arises. The divergence is therefore **arm-(a)-specific, plus (f) falling back to (a) when
the request names nothing**. That narrower scope is what the gate must be aimed at.

Within that scope: `approval_instances.org_id` is **derived** while `attendance_requests.org_id` —
written on the **same `trx`**, two statements later (`:33356` then `:33358-33362`) — keeps
`route.orgId`, the unvalidated caller value. **They can differ, and nothing notices.** The cleanest
constructible divergence is the fall-back case: the request names **nothing**, so `getOrgId(req)`
returns `'default'` and `attendance_requests.org_id = 'default'`, while the subject's single active
membership is `O1` and the instance is stamped `O1`.

| Arm | |
|---|---|
| (i) accept the divergence; assert nothing | The domain row and its approval disagree about tenancy. Any future join or report that assumes they agree is silently wrong. |
| **(ii)** assert agreement in a gate, accept the divergence in prod for existing rows | Cheap; catches the *implementation* creating a new divergence; does nothing about stock. **Recommended.** |
| (iii) derive **both** — change `attendance_requests.org_id` to the derived value too | Correct, and out of scope: it changes the attendance domain contract and touches the `DEFAULT 'default'` family. A named follow-up, not this slice. |

**Recommended: (ii)** — gate G-L11-8 asserts, values-free, that the two rows written in the same
transaction carry the **same** `org_id`, without echoing either value. **(iii)** is recorded as the exit.
Choosing (i) is a legitimate owner answer if the divergence is judged harmless, but it must be chosen,
not defaulted into.

*Status: DRAFT — OWNER-CONFIRM.*
---

## 4. Acceptance gates for the implementing slice

**Shape mandated for all of them** (this is the shape that survived two independent gate rounds on
#5098, and the deviations that were caught there are named as requirements, not as advice):

- **Real DB, through the PUBLIC production entry point** — never a hand-built fixture handed to the
  private writer. W-1: the Express route `POST /api/approvals`. W-2: `startApproval`. W-3:
  `submitRefundApproval`. W-4: the attendance request-create route.
- **Behavioural pre-condition first** — assert the create actually succeeded (id returned / `synced === 1`
  / rows affected) *before* asserting anything about `org_id`, so a silently-broken create cannot make
  the org assertion vacuously true.
- **Sentinel gated on `EXPECT_DB=1` at TOP LEVEL**, *not* nested inside `describeIfDatabase` — a nested
  sentinel skips in exactly the situation it exists to catch. (This is the defect #5098's second commit
  had to fix in its own new file; the landed correct pattern is in
  `packages/core-backend/tests/integration/approval-org-writer-plm-mirror-s1.db.test.ts`.)
- **Every gate carries all three cells** — positive control, discriminating negative, mutation. r1's own
  table violated this in two places and both are repaired below (review P3-3).
- **Mutation discipline**: assert the mutation anchor hits **exactly once**, prove the file actually
  changed (`git diff --numstat` non-zero + sha256 moved) *before* running, restore via `cp`, and re-verify
  the sha256 — an ineffective mutation reads as a useless test
  (`feedback_ineffective_mutation_looks_like_a_useless_test`).

### 4.1 CI wiring — re-based on TWO landed precedents (r2; r1's absolute prohibition is withdrawn)

r1 said: "**Do not touch `.github/workflows/plugin-tests.yml`** (s6a sha256-pinned provenance input)",
plus a **two-point** wiring. As an absolute that is contradicted by a landed commit. The corrected
guidance, from the two precedents that landed on either side of r1's baseline:

- **Default = two-point wiring, and it is the more recent precedent on this exact line.** `45490f57ec`
  (#5098) added `tests/integration/approval-org-writer-plm-mirror-s1.db.test.ts` to
  `packages/core-backend/vitest.config.ts`'s `exclude` (so the required `test (18.x/20.x)` job cannot
  collect-and-skip-green it) **and** created the standalone lane
  `.github/workflows/approval-realdb-org-writer-plm-mirror-s1.yml` (ephemeral Postgres, `EXPECT_DB=1`),
  leaving `plugin-tests.yml` **byte-identical**. That is the same slice family as this lock's gates and
  is the default an implementer should follow.
- **A third point exists, with a documented procedure, when a suite becomes an activation dependency.**
  `2171b07fb3` (#5095) promoted `approval-instance-readability-s1.db.test.ts`,
  `approval-comments.db.test.ts` and `approval-lock9-process-attachments-realdb.db.test.ts` into the
  run-list of the existing "Run approval real-DB integration" step in `plugin-tests.yml`
  (currently `:1300-1302`), so they execute inside the **required `test (20.x)`** context. Its commit
  message states the procedure verbatim: "Recompute the sealed-export `pluginTestsWorkflow` digest via
  `computePackageProvenancePinSet(repoRoot)` (**the one legitimate-touch case for this pin**) and verify
  it is the only key that moved." The pin implementation is
  `plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs`.
- **Promotion does not retire the standalone lane.** `approval-instance-readability-s1.db.test.ts` is
  now collected by **both** `.github/workflows/approval-realdb-instance-readability-s1.yml` and the
  required plugin-tests step.
- **Which to use here.** These gates should ship **two-point** (default). **G-L11-5 and G-L11-8 are
  different**: they are the gates the pin-activation decision leans on, so if the owner rules that
  activation depends on them, they take the third point under the #5095 procedure. That is a
  consequence of the activation ruling, not a choice for the implementer.
- `tests/unit/approval-ci-coverage-enumeration.test.ts` (inside a required lane) is the always-on proof
  the lane exists; the slice must show it **green with the lane present and red with it deleted** — the
  red half alone cannot distinguish "guard still matches" from "guard reds because the file vanished".
- **W-4's slice edits `plugins/plugin-attendance/index.cjs`**, so the four attendance census pins apply
  regardless of which wiring is chosen: s6a hash, W7-R10 classification, CI corpus, DML
  table-classification (`feedback_attendance_new_file_census_trio`).
- **The OpenAPI/SDK surface has its own wiring** — see G-L11-11.

### 4.2 The gate table

| Gate | Writer | Positive control | Discriminating negative | Mutation |
|---|---|---|---|---|
| **G-L11-1** | W-1 | Fixture user with **exactly one** active `user_orgs` row in a non-`'default'` org `O1`; create through `POST /api/approvals`; assert the row's `org_id = 'O1'` | Second fixture user with **two** active memberships (`'default'` + `O2`) — *must be constructed explicitly; the blanket backfill means a "multi-org" user is not multi-org unless you add the second row* — create ⇒ **422 `APPROVAL_ORG_UNRESOLVED`**, response body contains **no org id**, and **no `approval_instances` row was written** (count before/after). **Second negative (r2):** a **zero-membership** fixture user (created with no `user_orgs` row at all — the `AuthService.register` shape, §2.8) ⇒ same 422, same no-row assertion. Under (a) these are two distinct refusal causes reaching one response, and a gate that only tests the multi-org one cannot tell them apart | Remove the `rows.length === 1` guard from the derivation helper so it takes the first of two ⇒ the **multi-org** negative goes green ⇒ gate must red. **Second mutation (r2):** make the helper return `'default'` instead of refusing on the empty result ⇒ the **zero-membership** negative goes green ⇒ gate must red |
| **G-L11-2** | W-1 | **(r2 — r1 left this cell "—", violating its own mandate; review P3-3.)** Same single-org user, **no** `x-tenant-id` header at all ⇒ stamped `org_id = 'O1'`. Without this the forgery negative cannot distinguish "the header was ignored" from "the whole derivation is broken and always yields `O1`" | **Forgery negative (the load-bearing one):** same single-org user, but send `x-tenant-id: O-EVIL` where `O-EVIL` is an org the user holds no membership in ⇒ the stamped `org_id` is still `O1`, never `O-EVIL` | Repoint the writer at `resolveApprovalTenantId(req)` / `actor.tenantId` ⇒ gate must red. **This mutation is the whole point of the gate**: it is the exact wrong fix §2.2(i) predicts |
| **G-L11-3** | W-2 | Automation rule whose resolved requester holds exactly one membership; drive `startApproval` ⇒ stamped | Rule whose resolved requester holds two ⇒ typed `ServiceError` (values-free), the `multitable_automation_approval_bridges` row lands `status='failed'`, and **no** `approval_instances` row exists | **(r2 — r1 discharged this gate's mutation to a different gate, leaving its own negative unmutated; review P3-3.)** Own mutation: remove the multi-org guard from the derivation as reached **through `startApproval`** ⇒ this gate's negative goes green ⇒ **G-L11-3** must red. The keying-user mutation stays where it belongs, on G-L11-6 |
| **G-L11-4** | W-4 | Attendance request create through the route with the subject user holding exactly one membership in `O1` ⇒ `approval_instances.org_id = 'O1'`. **(r3) The fixture MUST pin its `operationId` posture explicitly** — supply a non-null `operationId` for the validated leg, or omit it for the legacy leg — because the two legs run different code (§2.3) and an unpinned fixture tests whichever one the harness happens to produce | **(r3 — negative (i) RE-SPECCED; as r2 wrote it, it is non-discriminating.** On the validated leg, "request naming `O-EVIL` (no membership) ⇒ refused, no row" **already passes today, pre-slice**, because the W4C-3b boundary refuses it with `ATTENDANCE_WRITE_NOT_AUTHORIZED` before any DML. A negative green before and after the change has no power over the change — `feedback_count_guard_and_fake_switch_test`.) **(i-validated)** `O-EVIL` on the validated leg ⇒ refused, no row, **and assert the refusal CODE equals the pre-existing `ATTENDANCE_WRITE_NOT_AUTHORIZED`**, not the derivation's `APPROVAL_ORG_UNRESOLVED` — i.e. the gate records *which* door refused, so the two refusals can never be confused; **(i-legacy)** `O-EVIL` with `operationId` **omitted** ⇒ under the ruled legacy-leg residue (OD-L11-7 (α)/(β)/(γ)) assert exactly that outcome — this is the leg where the new derivation is the only refusing mechanism, so this is where negative (i) actually discriminates; **(ii)** request naming nothing and subject multi-org ⇒ refused with `APPROVAL_ORG_UNRESOLVED`, no row *(this one is discriminating on both legs: the boundary admits `'default'`, the derivation refuses)*; **(iii)** subject with **zero** memberships ⇒ refused, no row | Restore `getOrgId(req)`'s `DEFAULT_ORG_ID` fallback into the derivation ⇒ negative (ii) goes green ⇒ gate must red. **(r3) Pre-slice control, mandatory:** run negatives (i-validated) and (ii) against the **unmodified** tree first and record which already red and with which code. Any negative that is red pre-slice contributes nothing and must be re-aimed, not counted |
| **G-L11-5** | W-4 | **Reader∘writer round-trip** — after the positive create, call `canReadApprovalInstance(db, subjectUserId, instanceId)` with `APPROVAL_S1_ORG_PIN_ENABLED=true` forced **in-process** ⇒ `true` | (α) Same call for a user whose only membership is in a *different* org ⇒ `false`. **(β) Liveness-predicate case (r2, review P2-1):** a subject holding an **active `user_orgs` row while `users.is_active = false`** — the *only* fixture on which the reader's single-`is_active` predicate and `resolveSessionTenantId`'s dual predicate disagree (§2.3). Assert the behaviour the D-9 ruling names, and assert that the writer and `viewerActiveOrgIds` agree on it | Change the stamped value to an org-shaped string not present in `user_orgs` (e.g. prefix it) ⇒ the positive must red |
| **G-L11-6** | **W-4 only** | For a create where actor ≠ requester, the stamped org matches the **requester's/subject's** membership. **(r2, corrected twice)**: an actor≠requester fixture is constructible **only** on W-4's cross-user postures (`plugins/plugin-attendance/index.cjs:33178-33183`) — W-1 and W-2 both collapse requester onto actor inside `assembleCreationContext` (§2.1, OD-L11-1), so a fixture written against `POST /api/approvals` or `startApproval` **cannot construct the scenario this gate names** and would be vacuously green. The r1 "all landing writers" scope is withdrawn | The actor's org is a *different*, valid org, and the assertion still names the requester's ⇒ a gate that passes under both keyings has no power and must be rewritten | Flip the helper's argument from requester to actor ⇒ must red |
| **G-L11-7** | W-3 (if it lands at all) | Under the ruled arm for W-3: (c) ⇒ boot with the config **unset** and assert the channel **refuses to serve** (not that it defaults); (d) ⇒ assert `org_id IS NULL` on a fresh `afs:` row created through `submitRefundApproval`. **The gate must NOT assert that the pin's id-shape bypass covers `afs:` — no such bypass exists** (the only id-shape carve-out is `plm:`, OD-S1-18 / `isPlmApprovalId` in the readability module, `approval-instance-readability.ts:175`), and minting one is the OD-S1-18 scope change OD-L11-6 says this lock cannot authorize. It is tracked as an **activation precondition under D-2**, not as a gate assertion | Non-vacuity: a second, non-`afs:` row in the same DB carrying a non-NULL org, so "NULL everywhere" cannot pass trivially | (c): set the config and assert the stamped value changes with it. (d): add `org_id` to the INSERT ⇒ must red |
| **G-L11-8** *(new, r2 — OD-L11-10)* | W-4 | Drive one attendance request create; read **both** rows written by that transaction (`approval_instances` by id, `attendance_requests` by `approval_instance_id`) and assert `approval_instances.org_id = attendance_requests.org_id`. **Values-free**: assert equality of the two reads, never echo, log or hard-code either value | **(r3 — RE-AIMED; r2's negative is incoherent under the now-specified arm (f).** r2 named "a multi-org subject naming their non-primary org **under (f)**" as the divergence case. Under (f) as specified in §3, a *named and validated* org **is** what gets stamped, so that case makes the two values **equal** and the gate would be vacuously green — the exact failure its own mutation cell warns about.) The divergence case is **arm-(a)-specific, or (f) falling back to (a)**: the request names **nothing**, so `getOrgId(req)` yields `'default'` into `attendance_requests.org_id`, while the subject's single active membership is `O1` and the instance is stamped `O1` ⇒ the equality assertion must be the thing that reds, not a crash | In the writer, stamp `approval_instances.org_id` from the derivation while leaving `attendance_requests.org_id = route.orgId` **and** drive the name-nothing/`'default'`-vs-`O1` fixture above ⇒ the equality must red. If it does not, the fixture never constructed a divergence and the gate is vacuous |
| **G-L11-9** *(new, r2 — OD-L11-9; witness and assertions corrected at r3)* | W-4 | Create, then **re-submit the same request id** so the `ON CONFLICT (id) DO UPDATE` branch at `:24070-24086` executes — assert it did **before** asserting org. **(r3) The witness cannot be `version`**: `version` and `created_at` appear in the INSERT column list but in **neither** `DO UPDATE SET` clause (re-read at `604ae14e26`), so they are unchanged on conflict by construction and prove nothing. Use `updated_at` moved — **and note it is `now()`, which is transaction-fixed**, so the two submits must be in **separate transactions** or the witness is vacuous. A same-transaction re-upsert fixture cannot witness the conflict branch at all | Between the two submits, change the subject's `user_orgs` membership from `O1` to `O2` (a **move**, not an addition — under an *addition* the subject's orgs become `[O1, O2]` and every arm looks alike). Then assert exactly the ruled arm: **(i)** `org_id` still `O1`; **(ii)** `org_id` now `O2`; **(iii)** `org_id` still `O1` and a NULL-org pre-existing row is healed to `O2`; **(iv)** the re-submit is **refused**, values-free, and the stored row is untouched. **(r3, round-2 review P1-A — mandatory second assertion:) assert WHO CAN STILL READ the row after the move**, by calling `canReadApprovalInstance` with the pin forced on, for (α) the subject, (β) an approver in `O1`, (γ) an approver in `O2`, (δ) an admin. As r2 specced it the gate asserted the stamped value only, which is green under **both** the true and the false consequence of arm (i) — precisely the defect that let the false consequence survive into the OD | For the ruled arm, apply the *other* arm's SQL (add/remove `org_id` from `DO UPDATE SET`; for (iv), delete the divergence check) ⇒ must red. A gate that passes under both arms has no power |
| **G-L11-10** *(new, r2 — §2.8)* | W-1 + W-4 | The zero-membership fixture is really zero-membership **at assertion time** — `SELECT count(*) FROM user_orgs WHERE user_id = $1 AND is_active` returns 0 immediately before the create | Create through the public route ⇒ 422 / typed error, **no row**, and the response carries no org id, no membership count, no user id | Delete the empty-result branch from the helper so it falls through to the exactly-one branch's `undefined` and NULL is stamped ⇒ must red. **This is the positive-control-not-fail-closed check for the whole zero-membership class**: without it, a fixture that accidentally acquired a `'default'` membership from the backfill turns the negative vacuously green |
| **G-L11-11** *(new, r2 — OD-L11-3 / review P2-3)* | contract | The regenerated `packages/openapi/dist/openapi.yaml` `createApproval` operation lists `422`, and `dist-sdk/index.d.ts` exposes it | Run `pnpm --filter @metasheet/openapi generate:sdk` then `git diff --quiet` on `dist/` + `dist-sdk/` ⇒ must be clean, i.e. the committed artifacts really are the regenerated ones; then `guard:codegen` passes | Edit only `packages/openapi/src/paths/approvals.yml` without regenerating ⇒ the `git diff --quiet` step must red. Editing `dist/` by hand and *not* the source must also red |

**Gate on the gate (G-L11-0).** Before any of the above is trusted, run the *positive control on the
fixture itself*: assert that the "multi-org" fixture user really has ≥2 rows in `user_orgs` at assertion
time, and that the "zero-membership" fixture user really has 0. Given the blanket backfill, a fixture
that forgot the second row produces a **vacuously green negative**; given that fixtures are often created
through helpers that admit an org, a "zero-membership" fixture can silently acquire one.
`feedback_positive_control_not_failclosed` applied to exactly the trap Lock-10 `:873` warns about on the
read side.

**What G-L11-5 does NOT prove (r2 — r1's "only gate that can catch it" claim is WITHDRAWN; review
P2-6).** G-L11-5 seeds a `user_orgs` row in `O1` **and** drives a create naming `O1`. Both sides are
handed the same fixture literal, so **namespace coincidence is true by construction inside the fixture**.
The gate proves reader∘writer consistency for a value the test itself chose. It has **no power** over a
*field* divergence between the attendance org domain and `user_orgs.org_id`; its mutation proves only
that the assertion is load-bearing against a *stamping* bug. Detection of field divergence belongs to
the §8-U3' probe as an **activation precondition**. The gate is still worth having — reader∘writer
consistency is exactly the invariant OD-L11-2's agreement mandate turns on — but its claim is now scoped
to what it can actually discriminate.

---

## 5. Sequencing — what depends on which ruling

| Step | Depends on the four writer rulings? | Why |
|---|---|---|
| **Migration B** (backfill of EXISTING rows, classes 1/3/4/6) | **NO** | It rewrites history, not new rows. It has its own blockers, independent of this lock: class 1 has no source (`approval_templates` carries no org column — docblock `:39-41`); class 3 is now well-defined per `:873` but launders `'default'`; class 4 is the same after-sales hole as OD-L11-6; class 6 ABORTs. Migration B can be designed and landed in parallel with, before, or after any writer ruling. |
| **Pin activation** (`APPROVAL_S1_ORG_PIN_ENABLED=true`) | **YES — on ALL FOUR** | The module states the precondition itself (`approval-instance-readability.ts:76-80`): "Flip precondition: the writers-stamp-org PR lands **AND** Migration B's backfill has actually run against production data for classes 1/3/4/6 (not merely landed as migration code)". Combined with OD-S1-9(e) applying "from activation" (Lock-10 §5.1.2): **every writer left unstamped keeps minting rows that go dark the moment the flag flips.** A partial landing does not permit activation — it only stops one of four leaks. Activation additionally needs its own ledger row (environment, approver, time, evidence, rollback), **and — r2 — the §8-U3' probe as a precondition**, since no gate detects field divergence (§4.2). |
| **Phase 3** (`CHECK (org_id IS NOT NULL OR id LIKE 'plm:%')`) | **YES, plus more** | Every non-`plm:` writer must stamp or the CHECK 500s every create. Beyond these four that means writers 5/6 (`seed-approvals.ts:6`, `test-approvals-contract.mjs:138`) must stamp or be retired (#5098 P3-1), and — if W-3 lands as arm (d) — the CHECK's escape clause must be widened to `afs:` too, which is a scope change to OD-S1-18. House deploy rule (migration-before-image) requires the writers to be in the **same deploy unit** as the CHECK. |

**Ordering traps.**

1. **ANY refusing arm — (a), (b), (f) or (g) — is a public contract change and must land BEFORE
   activation, not with it.** *(r2: r1's header scoped this to "an arm-(b)- or (f)-shaped ruling" while
   its body described the multi-org 422, which is arm (a) — the arm recommended for three of four
   writers. An implementer picking (a) could read the trap as not applying. Review P2-3.)* Refusing a
   create that succeeds today changes shipped behaviour for a real population — the multi-org population
   (§8-U1) **and** the structurally-guaranteed zero-membership population (§2.8). Bundling it into the
   activation window means one flag flip causes both a read narrowing and a write narrowing, with no way
   to attribute a regression. **The published contract must move with it** (OD-L11-3's four-step OpenAPI
   procedure; G-L11-11). Ratify-first (`feedback_tests_freeze_change_not_approve_it`).
   **(r3) A fourth population belongs in this trap: W-4's legacy-leg clients.** If OD-L11-7's legacy
   residue is ruled (β) or (γ), creates that succeed today with `operationId` omitted start being
   refused — a shipped-behaviour narrowing for a population whose size is **U8**, distinct from the
   multi-org and zero-membership populations and not measured by U1a/b/c.
2. **Do not activate on the strength of a green `p20`.** `p20` counts NULL-org platform rows; it can
   reach zero while `p52` (backfilled rows whose own requester holds no active membership in the
   stamped org) is large. `p52`, not `p20`, is the activation number.
3. **W-1 and W-2 SHOULD land in one slice — as a preference, not a constraint** *(r2: r1 stated this as
   physics; §2.9 refutes that)*. They share the INSERT at `ApprovalProductService.ts:7560`, so a slice
   that stamps for the HTTP route necessarily changes the automation bridge's behaviour too. Therefore
   the automation fixtures and the multi-org **and zero-membership** negatives for *both* keying users
   must be in that same slice, or the second writer's behaviour changes untested. An owner who wants
   them split may have them split: the per-caller `actor.tenantId` channel (`:203`) makes divergent arms
   implementable.
4. **A "stamp the org" slice must not touch `requesterSnapshot`** (§2.1): `resolveCalendarSlaOrgId`
   (`ApprovalProductService.ts:4431-4435`) reads `requesterSnapshot.orgId` and defaults to `'default'`,
   so adding an `orgId` key there silently re-tenants every business-time node SLA.

**Suggested order** (not authorized here; *r3, NIT-6: every step now names its **D**-number, since §6 is
the menu an owner rules from — r2 mixed D-numbers and OD-numbers and never named D-3 or D-4 at all*):

**§8-U1a/b/c probes first (all three counts)** → **D-8** (is the zero-membership population acceptable,
or does provisioning get fixed first?) → **D-1** (OD-L11-8, the channel question) and **D-7** (W-1's
(a)-vs-(g)) → **D-4** (OD-L11-1, requester-keying, incl. its W-2 config half) and **D-9** (OD-L11-2's
liveness predicate) and **D-3** (OD-L11-3/4/5/7 — arm (a) as the floor **and** the 422 failure shape;
note D-3's attendance half now carries the authorized-then-422 hazard, §0.1 item 5) → W-1 + W-2 (one
slice, preferred) → **U8** → W-4, with **D-10** (OD-L11-9, escalated) and **D-11** (OD-L11-10) ruled and
OD-L11-7's legacy residue chosen → **D-2** (the W-3 fork) → Migration B → remaining §8 probes incl. U3'
→ staging activation → prod activation → Phase 3 (with writers 5/6). **D-5** (the Lock-10 `:412`
erratum) and **D-6** (whether W-3/W-4 defer entirely) sit outside this chain; D-6 is answerable at any
point and blocks activation if answered "defer".

**U1 is blocking, not a to-do — and it is THREE probes, of which two are counts of the affected
populations.** *(r3: r2's header said "TWO counts" while §8 marks **U1a, U1b and U1c** all BLOCKING and
says "all three must be read before any arm-(a)/(f)/(g) slice merges" — a self-inconsistency in the
sequencing section an implementer reads for merge gates. §8 is the authoritative form and §5 is aligned
to it here. The reconciliation: **U1a and U1b are the two counts that size the refusal populations**
(multi-org, zero-membership) and therefore gate the "zero-impact today" claim; **U1c is the
discriminator that explains U1a's answer** rather than sizing a population of its own. All three are
blocking — U1c because a non-`'default'` `directory_integrations` org means the second backfill has
already manufactured the multi-org population, which changes how U1a's number should be read.)*
No arm-(a)/(f)/(g) slice may merge before all three come back, because "zero-impact today" is the
entire basis on which (a) is recommended over (d) for three of the four writers. If U1 shows a live multi-org population, or a
non-trivial zero-membership population, OD-L11-4/5/7's recommendations must be re-argued as a knowing
refusal outage, not as a no-op. **The zero-membership count is not conditional on prod data in the way
the multi-org count is** — §2.8 establishes the population exists by construction wherever
self-registration or DingTalk login has ever been used; U1 measures how large it is, not whether it
exists.

---

## 6. Open owner decisions (consolidated)

| # | Decision | Blocks |
|---|---|---|
| **D-1** | OD-L11-8 — does OD-S1-9(f) forbid a caller-named, membership-validated org, and **on which channel**? Three answers: forbid both channels / permit the **token** channel only (arm g) / permit both (arms g and f). *(r2: restated from a binary "provenance" question to a channel question, and given a third answer — review P1-2.)* **⚠️ r3 — the STAKES changed, not the question.** Channel B (create request) is not a capability this lock would introduce: the W4C-3b boundary already takes a request-named org and validates it against `user_orgs` in-transaction, in production (§2.3, OD-L11-8's third precedent). Answering "forbid both" therefore rules a **landed** mechanism non-compliant with a RATIFIED OD, rather than declining to add one. This lock does **not** infer compliance from shipped-ness | arm (f) on W-1 and W-4; OD-L11-7's recommendation; **possibly** D-7 |
| **D-2** | OD-L11-6 — W-3: authorize a channel org constant (c, the refused shape, accepted knowingly), **or** accept `afs:` going dark (d), **or** authorize validating `requester.id` against `users` so (a) applies. **If (d): widening the pin's id-shape bypass from `plm:`-only to `plm:`/`afs:` is a separate OD-S1-18 scope change and is a PRECONDITION OF ACTIVATION, not part of the writer slice** | W-3 entirely; pin activation; Phase 3's CHECK predicate |
| **D-3** | OD-L11-4/5/7 — confirm arm (a) as the derivation floor for platform/automation/attendance, and confirm that an unresolvable-org create becomes a 422 (a shipped-behaviour narrowing **plus** a published-contract change, OD-L11-3). *(r2: the arm-comparison table this asks the owner to confirm was misstated in r1 and is re-derived in OD-L11-4.)* **⚠️ r3 — the attendance half of D-3 carries a fact r2 did not show:** confirming (a) as the floor **for W-4** means the writer will **422 a request the W4C-3b authorization boundary just admitted, inside the same transaction** (a multi-org subject whose caller names one of the subject's valid orgs passes `requireActiveMembership`, then arm (a) ignores the name, sees ≥2, and FAILs LOUD — §2.3, OD-L11-7 arm (a), §0.1 item 5). Arm (f) has no such split because it consumes the value the boundary already validated. Confirming (a) for W-4 is therefore a choice to have the writer contradict the authorization layer, not merely a choice of derivation rule | all four writers |
| **D-4** | OD-L11-1 — confirm requester-keying, and accept that where actor ≠ requester (**W-4 cross-user postures only**, at this baseline) the creator reads their own creation only via the admin bypass. *(r2: narrowed twice — **not** reachable on `POST /api/approvals`, and **not** on the automation bridge either; both collapse requester onto actor.)* **Second half of D-4, new in r2:** on W-2 the keying user is whichever identity `loadAuthorizedActor` nominates, and that choice is an automation **config** field (`config.requester?.mode`, `:460-462`) — so confirm that an automation's stamped tenant may follow the rule author or the trigger actor depending on per-action configuration | the derivation's argument; W-2's stamped tenant |
| **D-5** | Lock-10 `:412` erratum (PLM `SET NOT NULL` vs NULL-permanent) — **recorded, not adjudicated** (#5098 P3-3) | Phase 3's migration text |
| **D-6** | Whether W-3/W-4 defer entirely (E-3/E-4 as posed by #5098) — deferral is a valid answer, but it **blocks pin activation indefinitely** per §5 | activation |
| **D-7** *(new, r2)* | **W-1: arm (a) or arm (g)?** (a) = deterministic from DB state, refuses every multi-org caller. (g) = serves a multi-org caller who selected an org at login, via the RATIFIED `req.authenticatedTenantId`, re-validated at create time; refuses strictly fewer; but makes the stamp depend on an input the user cannot see and can set today only through an undocumented `?tenantId=` URL parameter (§2.2(iii)) | W-1's arm; the size of the day-one refusal population |
| **D-8** *(new, r2)* | **The zero-membership class (§2.8): accept, or fix provisioning first?** Every self-registered and every DingTalk-provisioned user holds zero active memberships **by deliberate design**, and no arm on the menu serves them without violating a RATIFIED OD. Answers: (α) accept the refusal knowingly and size it via §8-U1; (β) land an org-aware admission step for those two paths **before** any writer slice, so the population is empty when the arms land; (γ) rule (c) for the affected channels | every arm-(a)/(f)/(g) writer; the honesty of "zero-impact today" |
| **D-9** *(new, r2)* | **Which membership-liveness predicate does the writer use?** single-`is_active` (byte-agreement with the reader `viewerActiveOrgIds`, `approval-instance-readability.ts:153` — recommended) or dual-`is_active` (`resolveSessionTenantId` / the RD-3 house rule stated at `zzzz20260721150000…:27-31`). They differ on exactly one population: an active membership held by a deactivated user. **r3: read with D-10** — this recommendation's stated rationale is the invariant "a stamped row is readable by its own requester", and OD-L11-9 arms (i)/(iii) **break** exactly that invariant for a moved membership | OD-L11-2's helper; G-L11-5(β) |
| **D-10** *(new, r2; **recommendation WITHDRAWN and escalated at r3**)* | **OD-L11-9** — W-4's `ON CONFLICT … DO UPDATE` branch. **Four** arms: (i) never re-derive, (ii) always re-derive (a runtime tenant move — a widening), (iii) heal NULL only, **(iv) re-derive and REFUSE on divergence** *(new at r3)*. **r2 recommended (i) on a false consequence** — it claimed the subject still reads a stale row via predicate arm 1; the org pin conjoins **outside** the arm disjunction (`approval-instance-readability.ts:219`), so a stale row is dark for **everyone including the subject and admins**. The real trade is **"whose read do you sacrifice — the subject's own (i/iii), or the old org's approvers' (ii) — or do you wedge the request (iv)?"** No arm is recommendable by an executing session on that framing. **May be MOOT: if U1a returns `count(DISTINCT org_id) = 1` there is nowhere for a membership to move to** | W-4's slice; G-L11-9. Read together with **D-9**, whose recommendation rests on the invariant (i)/(iii) break |
| **D-11** *(new, r2; SCOPE corrected at r3)* | **OD-L11-10** — the same-transaction split-brain between `approval_instances.org_id` and `attendance_requests.org_id`: accept it, gate it (**recommended — unchanged at r3**), or derive both. **r3: WHEN it can occur is now narrower than r2 said.** It arises under **arm (a)**, and under arm (f) only when (f) falls back to (a) because the request named no org. Under (f) with an org **named and validated**, the stamp *is* `route.orgId`, the two agree by construction, and no divergence exists. So if D-1 permits (f) on W-4 and callers name an org, D-11's exposure is the fallback traffic only — which is also the only case G-L11-8's re-aimed negative can construct | W-4's slice; G-L11-8. Exposure depends on **D-1** (whether (f) is available at all) |
---

## 7. Honesty discharge and effects

- **No verification claim is made.** §4 specifies gates; none has been run. No probe in §8 has been run.
  §9 records document-level dispositions of a review, which is not verification either.
- **The recommendations do not make the pin protective.** Restated from §2.7 because it is the claim most
  likely to be over-stated downstream: in a single-`'default'`-org deployment, arm (a) stamps
  `'default'` everywhere and the pin admits ~everyone. Arm (a) makes activation **safe**, not the
  tenancy **enforced**. A PR landing this must not say "stops the NULL-org drift" unless it lands all
  four writers, and must not say "enforces tenant isolation" at all.
- **Outage classes created or accepted, named:**
  1. *Refusal outage — multi-org* — multi-org callers lose the ability to create (arms a/b/f/g, with
     (g) refusing fewest). Size unknown (§8-U1). **Manufacturable without admin action** by the second
     backfill (§2.7) wherever `directory_integrations` holds a non-`'default'` org. Recovery in-product
     is limited to re-login with an undocumented `?tenantId=` parameter (§2.2(iii)); there is no
     org-switcher.
  1b. **(new, r2; scoped at r3)** *Refusal outage — zero membership* — self-registered and
     DingTalk-provisioned users **admitted after `zzzz20260114110000` ran** hold **zero** active
     memberships **by deliberate design** (`AuthService.ts:435-440`, `dingtalk-oauth.ts:787-789`) and
     are refused by every arm on the menu except (c); under (d) they are denied at activation instead.
     **Certain rather than conditional** for any deployment with post-migration admissions, and
     plausibly larger than class 1. *(r3, round-2 review P3-A: the pre-migration cohort was swept into
     `'default'` by backfill 1, so this class is post-migration admissions, not "all self-registered
     users". U1b measures it directly; the scope does not change D-8's answer.)* Not recoverable by
     re-login — they have no membership to name. Posed as D-8.
  2. *Re-login outage* — arm (b) only: sessions whose tokens predate the tenant claim (§8-U2). **r2
     note**: this class is *narrower* than r1 implied, because the claim is obtainable at login by any
     multi-org user who names one of their own orgs; but it is also *real*, because nothing in the
     product prompts them to.
  3. *Dark-instance outage* — arm (d), and any writer left unruled at activation: instances unreadable
     to their own requester and approvers, admins included (OD-S1-9(e)).
  4. *Looks-fixed outage* — W-4 if the attendance org namespace ≠ `user_orgs.org_id` (§8-U3'). **r2
     re-grade**: r1 called this "worst of the four"; that grading is **withdrawn** (§2.7 / OD-L11-7 —
     the namespaces coincide by construction for admitted orgs). The residual is narrow and is a *field*
     question. **No gate detects it** — G-L11-5 cannot (§4.2) — so the U3' probe is an activation
     precondition.
  5. *Silent widening* — arm (c) on W-3 with a mis-set constant: role-typed seats in the wrong org gain
     read. Not detectable by any gate here; only a boot assert plus operational review bounds it.
  6. **(new, r2; SCOPED at r3)** *Same-transaction split-brain (W-4)* — `approval_instances.org_id`
     (derived) and `attendance_requests.org_id` (`route.orgId`, unvalidated) are written two statements
     apart on the same `trx` (`plugins/plugin-attendance/index.cjs:33356`, `:33358-33362`) and can
     disagree. ~~**This is created by the recommended arm**, not inherited.~~ **r3 correction: it is
     created by arm (a), and by arm (f) only when it falls back to (a) because the request named no
     org.** W-4's recommended arm is **(f)**, and with (f)'s validation principal specified (§3) a
     *named and validated* org is stamped as-is, so the stamp **is** `route.orgId` and the two agree by
     construction. Attributing this class to "the recommended arm" overstates the cost of the arm this
     document actually recommends for W-4 — the same defect shape as the round-2 review's P1-A, so it is
     corrected the same way rather than left as a heading slip. **Not inherited** is still true: no arm
     that stamps a derived value is free of it, and (a) is the floor every other arm falls back to.
     Gated by G-L11-8 (whose negative is re-aimed onto the fallback case); ruled by OD-L11-10.
  7. **(new, r2)** *Published-contract drift* — the 422 is absent from `createApproval`'s published
     contract (`packages/openapi/src/paths/approvals.yml:76`, `dist/openapi.yaml:5931`,
     `dist-sdk/index.d.ts:412`). SDK consumers would meet an undocumented status. Gated by G-L11-11;
     procedure in OD-L11-3.
- **Provenance is labelled per citation** (#5098 P2-2): **RATIFIED** for OD-S1-9(a)/(e)/(f),
  OD-S1-17(a)/(b); **RULED** (executing-session-authored list + 「按建议执行」) for OD-S1-17(c)=(c-i) and
  Lock-10 §5.1.2 — *r2 downgraded (c-i) from r1's "RATIFIED"*; *SESSION DESIGN AUTHORITY (created by the
  independent review; never put to the owner)* for OD-S1-9(b)/(c) and OD-S1-18. **This lock's own ODs are
  DRAFT and were authored by an executing session.** Per
  `feedback_authorization_source_must_be_owner_authored`, a later 「按建议执行」 reaches only an explicitly
  enumerated list, and this document is not itself such a list.
- **Second-artifact check** (`feedback_second_narrower_artifact_is_contract_narrowing`): this lock is
  **narrower** than the `writers-stamp-org` slice name — it rules derivation, not implementation, and it
  recommends **deferring or escalating W-3**. Landing it must not be recorded as closing that slice.
- **Absolute-claim sweep** (`feedback_absolute_claim_sweep_must_be_mechanical`). The absolutes asserted
  in r2, each a **scan result at `604ae14e26`** and restated as such at its anchor:
  (i) "zero Kysely `insertInto('approval_instances')` hits repo-wide";
  (ii) "`meta_bases` has no org column in any migration" — and the second migrations directory
       `packages/core-backend/migrations/*.sql` was included in the sweep (§2.4);
  (iii) "`AfterSalesApprovalBridgeService.ts` never reads org/tenant";
  (iv) "`approval_templates` carries no org column" — swept across the five migrations that touch it;
  (v) "`loadViewerOrgIds` does not exist anywhere in the repo" (the symbol r1 cited);
  (vi) "no org-switcher exists in either frontend" — the grep terms are listed at §2.2(iii) so the scan
       is reproducible and its blind spots visible; note it is **contradicted in spirit** by the
       `x-tenant-id` hint mechanism, which §2.2(iii) records rather than hides;
  (vii) "no `orgs`/`workspaces`/`organizations`/`tenants` table exists" — corroborated by the repo's own
       statement at `zzzz20260818120000…:20`.
  **Absolutes introduced by r2 itself** (listed separately because they are not inherited, and because
  `feedback_absolute_claim_sweep_must_be_mechanical` makes the *table*, not the individual sentence, the
  artifact a gate round attacks):
  (viii) §2.1 / OD-L11-1 — "on W-1 **and W-2** the requester IS the acting principal, **structurally**".
       Basis: `createApproval` calls `assembleCreationContext(request, actor)` with no options (`:7485`),
       there is **exactly one** `requesterOverride` caller repo-wide — `previewTemplateRoute`'s call at
       `:7366-7371` (token at `:7370`), which writes nothing — *(r3, NIT-2: r2 said "the two preview
       paths (`:7342`, `:7366`)"; `:7342` passes `whitelistFormDataToSchema` + `requesterChoicePresence`
       only. The correction strengthens the absolute)*, and
       `startApproval` passes `loadAuthorizedActor`'s single identity as `actor`
       (`automation-approval-bridge-service.ts:271-274`). Scope: **this baseline only** — a future caller
       passing `requesterOverride`, or an SDK create-on-behalf capability, breaks it, which is why U6's
       census must be re-run at the implementing head.
  (ix) §2.8 — "no arm on this menu serves a zero-membership principal without violating a RATIFIED OD".
       Basis: the six-row arm walk in §2.8, each row anchored. Scope: **the arms enumerated in §3**; it
       is not a claim that no such arm could be invented (D-8(β) is exactly the invention).
  (x) §2.9 — "different arms per writer are implementable without splitting the INSERT". Basis:
       `ApprovalProductService.ts:7473` + `:203`. This is a claim about *implementability*, not a claim
       that anyone has implemented it.
  (xi) §4.2 — "G-L11-5 has **no power** over a *field* divergence". Basis: both sides of its fixture take
       the same literal, so the property is true by construction inside the test. Scope: the gate **as
       specified here**; a differently-shaped gate could have that power, and none is specified.
  (xii) OD-L11-9 — "no gate in §4 could distinguish (ii) from correct behaviour without being written for
       it". Basis: G-L11-9 is the gate written for it; the claim is about the *other* gates in §4.2.
  (xiii) OD-L11-1 / G-L11-6 — "an actor≠requester fixture is constructible **only** on W-4". Same basis
       as (viii), same scope caveat.
  **Absolutes introduced or repaired by r3** (same rule: the *table* is the artifact a gate round
  attacks, so a load-bearing absolute missing from it is a defect even when the absolute is true):
  (xiv) **§2.2(i) — "`req.authenticatedTenantId` is claim-only and the header backfill cannot reach
       it."** *(r3, round-2 review P3-B: this is the absolute arm (g)'s entire safety argument rests on
       and D-7 asks the owner to weigh, and r2 omitted it from this table.)* **Basis — a repo-wide
       assignment census at `604ae14e26`, re-run in this session, not a reading of the quoted lines**:
       `git grep -nE "authenticatedTenantId[[:space:]]*=[^=]" 604ae14e26` returns exactly three lines —
       `packages/core-backend/src/auth/jwt-middleware.ts:101` (the local, from the verified JWT
       payload's `user.tenantId`), `:103` (`req.authenticatedTenantId = authenticatedTenantId`, **the
       only production write**), and one **unit-test** assignment
       (`tests/unit/attendance-w6-group-effective-policy-authorization.test.ts:421`). The header
       backfill at `:106-108` (`if (!user.tenantId && headerTenantId) { user.tenantId = headerTenantId }`)
       runs **after** `:103` and writes only `user.tenantId`, never the request field. Every other
       repo-wide hit is a read (`routes/attendance-admin.ts:163`,
       `plugins/plugin-attendance/index.cjs:6330`), a type declaration (`types/express.d.ts:34`), a test
       fixture literal, or a comment. **Scope: this baseline only** — a second writer, or a re-ordering
       of `:103` after the backfill, breaks it, which is why U6's census must be re-run at the
       implementing head.
  (xv) **§2.3 — "the validated leg of W-4's create path is client-opt-in; on the
       `operationId === null` legs no membership check runs."** Basis: `w4c3b-request-operation-boundary.ts:427-437`
       and `:449-466` both reach `adapter.execute` without the `:479` preflight;
       `resolveSegmentCalculationPosture` returns `legacy_projection_only` for every org absent a
       persisted non-`legacy` row with `scope='synthetic_staging'` **and** the capability flag **and**
       an exact allowlist match (`w4c0-identity.ts:377` states the "every org" default itself); and
       `operationId` is `.optional()` at `plugins/plugin-attendance/index.cjs:32978`, `:32986`, `:31598`,
       `:31694`, `:31707`. **Scope: this baseline, and the code path only** — how much live traffic
       omits `operationId` is **not** claimed here; it is U8.
  **Withdrawn absolutes from r1**: "`req.authenticatedTenantId` is absent by construction for a multi-org
  caller" (§2.2), "no owning entity carries an org for W-1/W-3/W-4 either" (§3 arm (e)), "W-1 and W-2
  CANNOT be ruled independently" (§2.9), "G-L11-5 is the only gate that can catch 'stamped but still
  dark'" (§4.2), "do not touch `plugin-tests.yml`" (§4.1). Each withdrawal is propagated to every place
  r1 restated it; §9.1–§9.7 lists the sites.
  **Withdrawn absolutes from r2** *(r3)*: "the attendance approval-create path has **no** membership
  validation of its `orgId` today" (§2.3, and its restatements in OD-L11-7's arm (a) row and G-L11-4's
  rationale); "under arm (i) the subject **still reads** a stale row via predicate arm 1" (OD-L11-9,
  and D-10's cost basis); "all ten quoted fragments in §1 were re-diffed programmatically … and now
  match" (§9.6 item 6, restated in §9.3's P3-2 row — **false at `:910`**); "the only `requesterOverride`
  callers are the **two** preview paths" (§2.1, §7 (viii), §9.6 item 2). Each is propagated to every
  site that restated it; §9.8 lists the sites and records the mechanical sweep that verified no live
  restatement survives.
- **Retraction-first note for any PR body built on this document**: r1 has been superseded. Any text
  copied from r1 that asserts a withdrawn absolute above must be corrected, not merely omitted.

---

## 8. Facts this lock could NOT verify (and the probe each one needs)

All probes are **values-free**: closed counts and booleans only. No probe may emit an `org_id`, a user
id, an instance id, a membership list, or an error string. Provenance (SHA, environment, timestamp) is
allowed.

| # | Unverified fact | Why it matters | Probe the implementing slice must run |
|---|---|---|---|
| **U1a** | **Prod multi-org cardinality.** How many active users hold ≥2 active memberships, and whether any `org_id` other than `'default'` exists at all. **The S1 evidence pack does not probe this** — its probes (`p20`–`p53`) all read `approval_instances`; `p50` counts distinct orgs on *instances*, not on `user_orgs`. | Sizes outage class 1, and is half of the "which arms are zero-impact today" claim. | `SELECT count(DISTINCT org_id) FROM user_orgs WHERE is_active` and `SELECT count(*) FROM (SELECT user_id FROM user_orgs WHERE is_active GROUP BY user_id HAVING count(*) > 1) t`. |
| **U1b** *(new, r2)* | **Prod zero-membership cardinality.** How many active users hold **no** active membership. §2.8 establishes the population exists by construction; this measures it. | Sizes outage class 1b — the class no arm serves. Feeds D-8. **This is the count r1 never asked for, and it is the one most likely to be non-zero.** | `SELECT count(*) FROM users u WHERE u.is_active AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active)` |
| **U1c** *(new, r2)* | **The second backfill's discriminator.** How many distinct orgs exist on `directory_integrations`. | Decides whether `zzzz20260721150000…:49-59` has already manufactured the multi-org population (§2.7). One non-`'default'` integration org ⇒ every linked user of that integration holds a second row. Cheap, and it explains U1a's answer rather than merely reporting it. | `SELECT count(DISTINCT org_id) FROM directory_integrations` and `SELECT count(*) FROM directory_integrations WHERE org_id <> 'default'` |
| **U1a/b/c are BLOCKING.** | | | **All three must be read before any arm-(a)/(f)/(g) slice merges** (§5). |
| **U2** | Whether live prod JWTs carry `tenantId` (token TTL / mint date vs. when `resolveSessionTenantId` began populating it), and how many sessions would fall back to (a) under arm (g). | Sizes arm (b)'s re-login outage, and — new in r2 — sizes how much arm (g) actually buys over (a). If almost no live token carries a claim, (g) ≈ (a) and D-7 is near-moot. | Inspect the token TTL config and the mint-date of the `resolveSessionTenantId` wiring; or count `authenticatedTenantId`-absent authenticated requests over a window (count only). |
| **U3'** *(narrowed, r2)* | **Field question only:** do prod attendance rows carry `org_id` values absent from `user_orgs`? **The namespace-divergence half of r1's U3 is RESOLVED against the repo** and is no longer listed as unknown, per the lock's own "knowable from the repo ⇒ resolve it" discipline: `routes/admin-users.ts:3826-3830` writes the attendance org id directly into `user_orgs` after validating it against `directory_integrations.org_id` (`:3631-3636`, fail-closed 404), and `zzzz20260721150000…:49-59` populates `user_orgs.org_id` from the same anchor. Both sides anchor on `directory_integrations.org_id`. | If prod holds attendance rows whose org was never admitted through those paths, W-4's "fix" produces stamped-and-still-dark rows — outage class 4, which **no gate detects** (§4.2). | `SELECT count(*) FROM (SELECT DISTINCT org_id FROM attendance_records) a WHERE NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.org_id = a.org_id)` and the same for `attendance_requests`, on staging **and** prod. Non-zero ⇒ W-4 cannot use arm (a)/(f) without a namespace mapping. **Activation precondition**, not merely a to-do. |
| **U4** | Whether the literal `'system'` (and any other non-`users` `requester.id`) actually occurs in prod `afs:` rows. This scan found no `users` row seeded with that id, and found the literal reachable at six emit sites, but did **not** establish it reaches a real production submission. | Decides whether W-3 arm (a) is merely awkward or actively breaking. Also a lower bound on class 1b for that channel. | `SELECT count(*) FROM approval_instances i WHERE i.id LIKE 'afs:%' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.requester_snapshot->>'id')` — values-free count only. |
| **U5** | Whether the after-sales plugin's `resolveRuntimeInstallContext` tenant is in the `user_orgs.org_id` namespace. Recorded as *unverified*, deliberately, so it is not quietly adopted as W-3's source. | An implementer who finds it may assume it is the org. It is payload-derived (refused shape) **and** of unknown namespace. It is also arm (e)-for-W-3's would-be source (OD-L11-6). | Count-only, same shape as U3': how many distinct install-context tenant values have no matching `user_orgs.org_id`. |
| **U6** | Whether `POST /api/approvals` is the **only** HTTP entry to `createApproval`. `git grep -n "createApproval("` at `604ae14e26` surfaced exactly two non-test callers (`routes/approvals.ts:1222`, `multitable/automation-approval-bridge-service.ts:271`). Reported as a scan result, not as an absence proof. | A third caller would be a fifth unstamped writer path. | Re-run the census at the implementing head, both syntaxes (`git grep` on the call **and** on `INSERT INTO approval_instances` / `insertInto('approval_instances')`) — `feedback_writer_audit_both_query_syntaxes`. |
| **U7** *(new, r2)* | Whether any **non-browser** consumer already calls `createApproval` over the wire (the published SDK, `packages/openapi/dist-sdk`), and how it behaves on an undocumented 422. | The in-repo `createApproval(` census cannot see wire consumers (OD-L11-3). This is the population that meets outage class 7 first. | Not resolvable from this repo; ask the owner / check deployment inventory. Recorded so it is not mistaken for a resolved question. |
| **U8** *(new, r3)* | **The legacy-leg client population on W-4.** What share of live attendance request-create traffic **omits `operationId`**, and therefore reaches `upsertAttendanceApprovalInstance` through `w4c3b-request-operation-boundary.ts:427-437` / `:449-466` **without** the in-transaction membership check (§2.3). Like U7 this is an ops/deployment question, **not repo-resolvable**: the repo settles the code path (absolute (xv)) and the posture (`legacy_projection_only` for every org), but not who calls it how. | Decides **the size of arm (f)'s strengthened basis**. If most live traffic omits `operationId`, "the validation is already there" inverts and OD-L11-7's legacy residue (α)/(β)/(γ) becomes the main event rather than a residue. It also decides whether §5 trap 1 acquires a fourth narrowed population. | Count-only, over a window, at the route or the boundary: number of `request_create` boundary invocations with `operationId === null` vs non-null; and, if the client is identifiable at all, the count of **distinct** callers in the null bucket. **No org id, user id, request id, or client string may be emitted.** **Blocking for the SIZING CLAIM, not for the arm choice**: OD-L11-7 may be ruled without U8, but no PR body or gate name may assert "the validation is already there" until it comes back — the same discipline U1a/b/c impose on "zero-impact today". |

---
## 9. Review disposition — itemized

**§9.1–§9.7 disposition the ROUND-1 review (r1 → r2). §9.8 disposes the ROUND-2 review (r2 → r3).**
Nothing in §9.1–§9.7 was re-opened by round 2 — its verdict records the r1 fold as clean — so those
sections stand as written, except where §9.8 names a correction to one of them (§9.3's P3-2 row and
§9.6 items 2 and 6).

### 9.0 Round 1 — source

**Source**: `/tmp/lock11-review-20260822.md`, independent refute-first review, verdict
**REQUEST-CHANGES**, bound to r1 sha256 `1e31c85f21fe655e91ff1a83cf2031051ecc3e84e6e1d03ef67256ba2ef398e1`
at repo `85b2dd30a5c4632f3c5b38a36b3f876f831bb05e`. Every finding it raised has a row below —
**FOLDED** (the document changed), **FOLDED+EXTENDED** (changed, and the fold went further than asked),
**REBUTTED** (declined, with evidence), or **RECORDED** (accepted as a fact, no document change needed
beyond citing it). **Nothing is dropped.** Every anchor cited in a disposition was re-read at
`604ae14e26`, not at the review's baseline.

### 9.1 P1 findings

| # | Finding | Disposition | Where |
|---|---|---|---|
| **P1-1** | §2.2's "`req.authenticatedTenantId` is absent by construction for a multi-org caller" is FALSE — `resolveSessionTenantId` has a requested branch wired to the un-gated production login route | **FOLDED+EXTENDED.** §2.2 rewritten into three parts and the false sentence removed; the requested branch (`AuthService.ts:390-403`) and its full login chain (`routes/auth.ts:682, 700-704, 165-183`; `tenant-context.ts:164-167`; `AuthService.ts:356-357`; `jwt-middleware.ts:101-104`) re-verified at `604ae14e26`. Arm (b)'s population re-derived in a set table (`Z ∪ …` rows) in OD-L11-4, replacing "same population refused today". **Extension**: the correction is what makes arm (g) possible (P2-2), so OD-L11-4 was re-argued rather than merely corrected, and the recommendation's grade was downgraded from *dominant* to *floor, with D-7 open*. §7's absolute-claim sweep lists the withdrawn absolute | §2.2, §2.3 item 2, OD-L11-4, §7 sweep |
| **P1-2** | OD-L11-8's precedent census undercounts; RATIFIED OD-S1-17(b)'s field is itself caller-named + membership-validated; D-1 should be reframed as channel-not-provenance | **FOLDED+EXTENDED.** OD-L11-8 now names **two** precedents (the `resolvePunchOrgIdV1` route and `AuthService.resolveSessionTenantId`'s requested branch), states that the ratified field's own value is validated-selector-derived, and restates the question as **channel** (token vs create-request). **Extension**: D-1 grows a **third answer** — permit the token channel only — which r1's binary could not express, and which is the answer arm (g) would need. §1's "reading this lock adopts" paragraph carries the sharpening | OD-L11-8, D-1, §1, §2.3 item 2 |
| **P1-3** | The zero-membership refusal population is structurally guaranteed, unnamed as an outage class, and unprobed by U1 | **FOLDED+EXTENDED.** New **§2.8** names it with both docblocks (`AuthService.ts:435-440`, `dingtalk-oauth.ts:787-789`) and their shared pinning test, re-verified. New outage class **1b** (§7). New probe **U1b**, blocking. Arm-by-arm walk added showing (a)/(b)/(f)/(g) refuse them and (d) denies them at activation — the review's requested "arm (d) does not rescue them either" argument, made explicitly. **Extensions**: (1) a new owner decision **D-8** offering "fix provisioning first" as an answer, since none of the existing arms serves this population; (2) new gate **G-L11-10** plus zero-membership negatives on G-L11-1 and G-L11-4; (3) §2.5 reframed so W-3's `'system'` requester is presented as a member of this class rather than a channel peculiarity | §2.8, §2.5, §7 class 1b, §8-U1b, D-8, G-L11-1/4/10 |
| **P1-4** | The W-1/W-2 "structural constraint" is false — `createApproval` already takes a per-entry-point `actor` with `tenantId?` | **FOLDED+EXTENDED.** New **§2.9** withdraws it explicitly and cites `ApprovalProductService.ts:7473` + `:199-208` (`tenantId?` at `:203`), re-verified. OD-L11-5's bolded constraint paragraph is struck through and restated as a landing *preference* with its testing-discipline rationale; §5 ordering item 3 likewise. **Extension**: the withdrawal is connected to P2-2 — because W-1 and W-2 are separable, a W-1-only arm (g) is implementable at all, which is why the two findings are folded as one architecture change rather than two corrections | §2.9, OD-L11-5, §5 item 3, §0.1 |

### 9.2 P2 findings

| # | Finding | Disposition | Where |
|---|---|---|---|
| **P2-1** | OD-L11-2 names `loadViewerOrgIds` (does not exist), misdescribes the reader's predicate, and mandates unsatisfiable byte-identity | **FOLDED+EXTENDED.** Symbol corrected to `viewerActiveOrgIds` (`approval-instance-readability.ts:152-157`, SQL `:153`) and the non-existence of `loadViewerOrgIds` re-verified and recorded in §7's sweep. "Byte-identical" replaced by a three-part **agreement mandate** (namespace / liveness semantics / failure shape). **Extension**: a **three-reader liveness census** (§2.3) shows the repo does not agree with itself — the reader and the punch resolver check `user_orgs.is_active` only, `resolveSessionTenantId` checks both — so the choice is escalated as **D-9** with the house rule (`zzzz20260721150000…:27-31`) quoted as the discriminator, and G-L11-5 gains case (β), the inactive-user fixture, which is the only fixture the two predicates disagree on | OD-L11-2, §2.3, D-9, G-L11-5(β), §7 sweep |
| **P2-2** | Arm (g) is missing | **FOLDED+EXTENDED.** (g) added to the §3 vocabulary and to OD-L11-4's arm table with its refusal set. **Extension 1**: posed only in its **re-validated** form, with the reason stated before use — the bare form inherits (b)'s staleness and produces the "stamped but still dark" shape. **Extension 2**: (g) is explicitly **not** posed for W-2/W-3 (no request/token) or W-4 (the token's tenant is the operator's, not the requester the derivation keys on), so its scope is stated rather than left to inference. **Extension 3**: it becomes **D-7**, an owner fork against (a), rather than being silently promoted. **Partial rebuttal**: the review's "may be rulable without resolving D-1" is recorded as a *may*; OD-L11-4 gives the argument both ways and declines to assert D-1-independence | §3 vocabulary, OD-L11-4, OD-L11-7, D-1, D-7 |
| **P2-3** | The published OpenAPI contract for `createApproval` documents no 422; trap 1's header wrongly scopes the warning to (b)/(f) | **FOLDED+EXTENDED.** OD-L11-3 gains the affected-surface list — source `packages/openapi/src/paths/approvals.yml:76`, generated `dist/openapi.yaml:5931` (responses `:5952-5976`), `dist/openapi.json:8131`, `dist-sdk/index.d.ts:412`/`:17076` — all re-verified. Trap 1's header rewritten to "**ANY refusing arm — (a), (b), (f) or (g)**". **Extensions**: the four-step regeneration procedure is written out from `packages/openapi/tools/guard-codegen.mjs:1-11` and `packages/openapi/package.json`'s scripts (the review named the gap, not the procedure); new gate **G-L11-11**; new outage class **7**; new **U7** for the wire-consumer population the source census structurally cannot see | OD-L11-3, §5 trap 1, G-L11-11, §7 class 7, §8-U7 |
| **P2-4** | §4's CI guidance is stale against `2171b07fb3` | **FOLDED+EXTENDED, and re-based further.** main has moved to `604ae14e26`, **seven** commits past r1's baseline, and the review could not see the most important one: **`45490f57ec` merged #5098**. §4.1 now presents **two** landed precedents rather than one — #5098's two-point wiring with `plugin-tests.yml` byte-identical (the *more recent* precedent, same slice family, and therefore the default), and #5095's required-lane promotion with the `computePackageProvenancePinSet` recompute procedure (the named exception). It also records that promotion does **not** retire the standalone lane. **Partial rebuttal of the review's framing**: the review implied an implementer following §4 would wrongly build a standalone lane; #5098 shows a standalone lane is the correct default for a new gate file, and promotion is the exception tied to activation dependency | §4.1, baseline block |
| **P2-5** | U3 is substantially resolvable; "most dangerous of the four" is inflated and misdiagnosed | **FOLDED+EXTENDED.** The namespace half is **resolved from the repo** and removed from §8's unknown list: `routes/admin-users.ts:3826-3830` + `:3631-3636` and `zzzz20260721150000…:49-59`, both anchoring on `directory_integrations.org_id`, re-verified. "Most dangerous of the four" and "worst of the four" **withdrawn** in both places r1 said them. The mitigation is re-aimed at the **unvalidated-input** gap (`getOrgId`, `:6318-6326`), which strengthens arm (f). U3 narrowed to **U3'**, the field question only. **Extension**: `directory_integrations.org_id` is itself `NOT NULL DEFAULT 'default'` (`zzzz20260324150000…:16`), so the shared anchor is itself defaulted — a bound on the residual the review did not have, and the same fact that makes U1c a meaningful discriminator | OD-L11-7, §8-U3', §7 class 4, §8-U1c |
| **P2-6** | G-L11-5 cannot catch the divergence it is claimed to be the only detector of; outage class 4 has no gate | **FOLDED.** The "only gate that can catch 'stamped but still dark'" claim is **withdrawn** (§4.2 carries an explicit "What G-L11-5 does NOT prove" note), as is OD-L11-7's "G-L11-4 exists precisely to red on that". Detection responsibility moves to the **U3' probe as an activation precondition**, and §5's activation row now names it. G-L11-5 is retained with its claim scoped to reader∘writer consistency, which it genuinely does prove, and which OD-L11-2's agreement mandate depends on | §4.2, OD-L11-7, §5, §8-U3' |
| **P2-7** | Arm (e) is asserted absent for W-4/W-3 on W-1 evidence; an owning-entity arm exists for W-4 with an ungated split-brain | **FOLDED+EXTENDED.** The blanket sentence is **withdrawn** from the §3 vocabulary, which now scopes (e)'s refutation to W-1 and W-2. (e) is **posed and rejected with W-4 evidence** in OD-L11-7 (`attendance_requests.org_id`, `zzzz20260114100000…:51-56`; same-`trx` adjacency `:33356`/`:33358-33362`, all re-verified) — rejected because the value *is* `getOrgId(req)`, i.e. the refused shape wearing a referential wrapper. (e) is likewise **posed and rejected with W-3 evidence** in OD-L11-6 (`plugin_after_sales_template_installs` keyed `(tenant_id, app_id)`, `zzzz20260407140000…:57-58`). **Extension**: the split-brain the review flagged as unnamed becomes a **named outage class 6**, a **new OD (OD-L11-10)** with three arms, a **new owner decision D-11**, and a **new gate G-L11-8** with a values-free equality assertion and a non-vacuity mutation | §3 (e), OD-L11-6 (e), OD-L11-7 (e), OD-L11-10, D-11, G-L11-8, §7 class 6 |
| **P2-8** | §2.7 models one backfill; a second manufactures the refused population; three live writers add memberships; no org-switcher exists | **FOLDED+EXTENDED, with one correction to the review.** §2.7 now carries **both** backfills with the second quoted in full (`zzzz20260721150000…:49-59`) and the three live writers cited (`admin-users.ts:3826-3830`, `directory-sync.ts:5648`, `user-activate.ts:210`), all re-verified. New discriminator probe **U1c** (`count(DISTINCT org_id) FROM directory_integrations`), as requested. **Correction to the review**: its "`apps/web/src/utils/api.ts` sends no `x-org-id`" is true but incomplete — `authHeaders()` (`api.ts:156-170`) **does** send `x-tenant-id` from localStorage, from a `?tenantId=`/`?workspaceId=` query parameter, or from the decoded JWT, and `apiFetch` applies it on `/api/auth/login` too (`LoginView.vue:251`; `isAuthRoute` `:172-177` suppresses only the redirect). So login-time org selection **is** reachable in the shipped product, through an undocumented URL parameter and with no UI affordance. §2.2(iii) records both halves, and explicitly records that **this does nothing for the zero-membership class** — a user with no membership has nothing to name | §2.7, §2.2(iii), §8-U1c, §7 class 1 |
| **P2-9** | W-4's writer is an UPSERT; the `DO UPDATE` branch is unspecified and ungated | **FOLDED+EXTENDED.** §2.1 and §2.6 now call it an UPSERT and quote its shape (`:24061-24086`, `ON CONFLICT (id) DO UPDATE SET` over fourteen `EXCLUDED`-driven columns plus `sync_status`/`updated_at`), re-verified. **Extension**: rather than only naming the fork, the update-path semantics get a **new OD-L11-9** with **three** arms — the review posed two; the third, `COALESCE`-heal-NULL-only, is added because it is the arm that lets re-submit traffic heal pre-slice rows without ever moving a stamped one — a recommendation ((i), with (iii) named), a **new owner decision D-10**, and a **new gate G-L11-9** whose mutation is "apply the other arm's SQL", so a gate that passes under both arms is caught | §2.1, §2.6, OD-L11-9, D-10, G-L11-9 |

### 9.3 P3 / NIT

| # | Finding | Disposition | Where |
|---|---|---|---|
| **P3-1** | Provenance upgrade: r1 graded OD-S1-17(c)=(c-i) "RATIFIED" while grading the third by-reference reply "RULED", though both arise from the same mechanism; also §7 cited an "OD-S1-17(a)" the §1 table never introduced | **FOLDED, both halves.** (c-i) **downgraded to RULED** in §1 and §7, with Lock-10's own `:819` text ("→ **RULED (c-i)**") and §5.1.1's provenance (`:858-862`, "the owner's authored contribution is those four characters") quoted as the basis; a standing note explains the downgrade so a reader does not think r2 lost a ratification. And rather than dropping the §7 citation, **OD-S1-17(a) is added to §1** as a real RATIFIED row — it exists at Lock-10 `:817` and is directly relevant here (roles never from token claims is the read-side twin of §2.2's refusal of `actor.tenantId`) | §1 (new row + note), §7 |
| **P3-2** | Silent truncation inside a "Verbatim" column: Lock-10 `:818` ends "Rejected: (d) leave the derivations to the implementing slice"; r1 stopped at "no `'default'` fallback" with no ellipsis | **FOLDED.** The dropped clause is **restored verbatim** in §1's OD-S1-17(b) row. It is topical exactly as the review says: §4 hands derivation detail to an implementing slice, and the ratified text explicitly rejected doing so. ~~The review's confirmation that all other §1 quotes diff byte-for-byte (`:805`, `:808`, `:809`, `:873`, `:910`, and §2.5's `:376`) is RECORDED; those quotes are unchanged in r2~~ — **STRUCK at r3 (round-2 review P2-B).** That recording was false in two ways and it is the second site the false claim lived at (the first is §9.6 item 6): `:910` was itself silently truncated inside the same "Verbatim" column, so this very row disposed a transcription defect while carrying another; and the `:818` cell added emphasis the source does not have (NIT-1). Both are repaired in §1 and the repair is recorded in §1's transcription-repair note and §9.8 | §1 |
| **P3-3** | Gate-shape deviations from the draft's own mandate: G-L11-2 has no positive control; G-L11-3's mutation discharges to a different gate | **FOLDED.** G-L11-2 gains a positive control (same single-org user, **no** `x-tenant-id` at all ⇒ `O1`), with the reason stated — without it the forgery negative cannot distinguish "header ignored" from "derivation always returns `O1`". G-L11-3 gains its **own** mutation (remove the multi-org guard as reached through `startApproval`), leaving the keying mutation on G-L11-6 where it belongs. §4's mandate list now states "every gate carries all three cells" explicitly so the deviation cannot recur silently | §4 mandate, G-L11-2, G-L11-3 |
| **NIT-1** | Path convention: some citations are src-relative, others bare filenames | **FOLDED.** A path-convention rule is stated in the baseline block (repo-root-relative on first mention; the `packages/core-backend/src/` prefix is the implied home for short forms), and first mentions throughout §2/§3 are expanded. **Also corrected beyond the review**: the review's own `apps/web/src/views/approvals/store.ts` and `approvals/api.ts` do not resolve; the real paths are `apps/web/src/approvals/store.ts` and `apps/web/src/approvals/api.ts`, and the view is `apps/web/src/views/approval/ApprovalNewView.vue` | baseline block, §2, §3, OD-L11-1 |
| **NIT-2** | The landed migration's docblock line numbers are stale (7508/1118/24051 vs 7560/1121/24061); the *set* matches | **FOLDED.** §2.1 now says the **set** matches and the **numbers are stale**, gives both, and tells the reader to re-derive from the grep rather than the docblock. Re-verified at `604ae14e26`: docblock `:34-35` still says the old numbers; the real sites are `:7560`, `:1121`, `:24061` | §2.1 |
| **NIT-3** | `AuthService.ts:418-421` cited for the error swallow; `catch` is at `:419`, `return undefined` at `:421` | **FOLDED.** OD-L11-2's "why not (iii)" now cites `catch` at `:419` and `return undefined` at `:421` | OD-L11-2 |
| **NIT-4** | `resolveSessionTenantId` spans `:384-423`, not `:384-422` | **FOLDED.** Corrected everywhere it appears (§2.2, §2.3), and the two branches are now cited separately — `:390-403` (requested) and `:405-418` (no-requested-tenant) — since conflating them is what produced P1-1 | §2.2, §2.3 |

### 9.4 Strengtheners the review offered, and its verified-survivor list

| Item | Disposition | Where |
|---|---|---|
| **Strengthener (i)** — the second migrations directory `packages/core-backend/migrations/*.sql`, wired at `db/migration-provider.ts:148-164` (the two dedupe arrays, `:148-152` and `:159-164`), is also clean of `meta_bases`/`meta_sheets`/`automation_rules`; a reader will find it and wonder | **FOLDED**, re-verified (`migration-provider.ts:148-164`) and folded into §2.4's arm-(e) refutation, and into §7's absolute-claim sweep so absolute (ii) states the sweep included it | §2.4, §7 |
| **Strengthener (ii)** — no `workspaces`/`orgs`/`organizations`/`tenants` table exists anywhere, which is what makes `workspace_id` **inert** rather than merely nullable; the repo says so itself at `zzzz20260818120000_create_approval_usable_member_groups.ts:20` | **FOLDED**, quote re-verified verbatim | §2.4, §7 sweep (vii) |
| **Strengthener (iii)** — both hops are unenforced: `automation_rules.sheet_id` has no FK, `meta_sheets.base_id` is nullable `ON DELETE SET NULL`; the chain is not merely org-terminating, it is not guaranteed traversable | **FOLDED** | §2.4 |
| **Survivor list** — W-2 arm (e) refutation UPHELD and stronger than r1 claimed; the six-site census; `jwt-middleware.ts:101-108`; `routes/approvals.ts:184-188`/`:1197`/`:1222`; the attendance anchors incl. all five call sites; `attendance-punch-org-resolution.cjs:134`/`:108-116`; the six after-sales `'system'` emit sites; `zzzz20260114110000` blanket backfill; the Lock-10 `:412` vs `:377`/`:820` contradiction being **real** | **RECORDED — not re-litigated.** All are retained unchanged in r2 except where a fold added to them; the six-site census and its line numbers were **re-verified at `604ae14e26`** and are unchanged, which is stated in the baseline block because it is the anchor set everything rests on | throughout |
| **Sound rulings the review named** — OD-L11-1's requester-keying and its honest-consequence paragraph; OD-L11-3's rejection of (iii) as "the outage, deferred"; OD-L11-6's refusal to reframe arm (c) into compliance ("should not be softened"); §2.7's refute-first paragraph and §7's restatement; G-L11-0; §5's dependency table and trap 2 | **RECORDED and preserved verbatim in substance.** OD-L11-6's (c) paragraph is unchanged; §2.7's refute-first block is unchanged and is additionally promoted into §0.1 as the sentence that must survive quotation. OD-L11-1's honest-consequence paragraph is **narrowed** (not softened): the admin-cross-org case is not reachable on `POST /api/approvals`, and the reachable sites are named instead | OD-L11-6, §2.7, §0.1, OD-L11-1 |

### 9.5 The review's nine numbered answers

| Q | Review's answer | Disposition |
|---|---|---|
| 1 — anchors | All load-bearing anchors hold except §2.2's inference and OD-L11-2's `loadViewerOrgIds`; off-by-a-line items are NIT-3/4 | **FOLDED** via P1-1, P2-1, NIT-3, NIT-4 — plus a full re-verification at the new tip `604ae14e26` |
| 2 — W-2 arm (e) | **UPHELD**, stronger than stated | **RECORDED**; the three strengtheners absorbed (§9.4). Not re-litigated |
| 3 — W-1/W-2 coupling | **FALSE as stated** | **FOLDED** via P1-4 / §2.9 |
| 4 — arm completeness | Two omissions: arm (g); arm (e)-for-W-4 | **FOLDED** via P2-2 and P2-7 |
| 5 — outage-class honesty | Understated: zero-membership structural; multi-org manufacturable; SDK has no 422. The Vue app has exactly one create flow with no create-on-behalf-of | **FOLDED** via P1-3, P2-8, P2-3. The one-create-flow fact is folded into **OD-L11-1**, where it **narrows** the honest-consequence paragraph: the admin-cross-org denial is not reachable on the platform route, only on W-4's cross-user postures and any future SDK consumer. **The review's own W-2 premise is corrected here too** — see §9.6 item 5. Paths corrected (NIT-1) |
| 6 — requester-not-actor | Ruling correct; no gap; see P1-3 for the interaction with zero-membership requesters on W-2's `ruleCreatedBy` | **RECORDED with one correction to the review** (§9.6 item 5): the ruling is correct, and the named zero-membership interaction is folded (OD-L11-1 closes with it; OD-L11-5's arm-(a) row states that `users`-liveness is not `user_orgs`-membership) — but the review, following r1, treated W-2's `:460-462` selection as an actor≠requester site. It is an upstream **nomination**; W-2 collapses requester onto actor exactly as W-1 does. G-L11-6's fixture scope was narrowed to W-4 as a result |
| 7 — gate specs | G-L11-5 vacuous for the U3 divergence; G-L11-2/G-L11-3 deviate from the mandated shape | **FOLDED** via P2-6 and P3-3 |
| 8 — U1–U6 | U1 missing two probes; U3 knowable; U2 more relevant given P1-1; U4/U5/U6 fine | **FOLDED**: U1 split into U1a/U1b/U1c (all blocking); U3 → U3' (narrowed, activation precondition); U2 restated to also size arm (g)'s benefit over (a); U4/U5/U6 retained, with U5 additionally cross-linked as arm (e)-for-W-3's would-be source; **U7 added** |
| 9 — ruled-text conformance | Quotes verbatim except one truncation; one provenance upgrade; **the draft nowhere claims owner authority** | **FOLDED** via P3-1 and P3-2. The zero-owner-authority property is **preserved and re-checked in r2**: the status block, every per-OD `DRAFT — OWNER-CONFIRM` row (now ten ODs), §7's provenance discharge, and the explicit "this document is not itself such a list" are all intact, and the five new decisions D-7…D-11 are all owner decisions, not rulings |

### 9.6 Nothing was folded that the review did not ask for, except these — declared

**Six** changes in r2 originate with the executing session rather than with the review. They are
declared here so a reader can attack them separately. *(r3: r2's own sentence said "Four" and then
listed six — a self-declared count that did not match its own list, in the section whose whole purpose
is declaring what was added unasked. Caught by r3's count check, not by either review. Corrected. r3's
own executing-session additions are declared separately in §9.8.1's three-item list and §9.8.6, not
here.)*

1. **§2.1's `resolveCalendarSlaOrgId` note** and **§5 ordering trap 4** — a wrong-fix hazard
   (`ApprovalProductService.ts:4431-4435` reads `requesterSnapshot.orgId` and defaults to `'default'`)
   of the same family as §2.2's, found while re-verifying the writer. No review finding names it.
2. **§2.1's requester≡actor finding on W-1** (`:7485` calls `assembleCreationContext` with no
   `requesterOverride`; **there is exactly ONE override caller, `previewTemplateRoute` at `:7366-7371`,
   token at `:7370`** — *r3, NIT-2: r2 wrote "the preview paths `:7342`/`:7366`"; `:7342` passes no
   `requesterOverride`. The correction strengthens the finding*) — this narrows OD-L11-1's honest
   consequence and underwrites arm (g)'s coherence on W-1. The review reached a compatible conclusion
   from the UI side; this is the service-side proof.
3. **OD-L11-9's third arm** (`COALESCE`-heal-NULL-only) — the review posed two.
4. **D-1's third answer** (permit the token channel only) — the review posed a binary.
5. **The W-2 requester≡actor collapse** (`automation-approval-bridge-service.ts:447-502`, `:271-274`).
   This one **corrects the review as well as r1**: the review's answer 6 accepted r1's premise that the
   `:460-462` selection is an actor≠requester site. It is not — it nominates the single identity that
   becomes the actor. The consequences are folded into OD-L11-1 (reachability narrowed to W-4 only, plus
   the new "is the nominated user the right keying user?" question) and G-L11-6 (Writer column narrowed
   from "all landing writers" to **W-4 only**, because the named fixture is not constructible elsewhere —
   `feedback_fixture_shape_must_match_named_scenario`).
6. **A second P3-2-class transcription defect, found by r2's own mechanical re-diff of §1.** The review
   reported that every §1 quote except `:818` "diffed byte-for-byte and are exact". Re-running that diff
   mechanically against `604ae14e26` found one more: r1 rendered Lock-10 `:873`'s inner quotation as
   `'resolves to exactly one **active** org membership'` where the source has `"…"`. Corrected — and the
   round-2 review independently confirmed that specific fix is real.

   **~~All ten quoted fragments in §1 … were re-diffed programmatically against the file at
   `604ae14e26` and now match.~~ — WITHDRAWN at r3 (round-2 review P2-B). The claim was false, and it
   was miscounted and mis-scoped as well.** Three corrections:
   - **`:910` did NOT match.** Its cell ended at "it requires its own ledger row" while Lock-10 `:910`
     continues "(environment, approver, time, evidence, rollback — ledger rule 5)", cut with **no
     ellipsis** — the exact P3-2 defect class this item's own first paragraph is disposing, inside the
     same "Verbatim" column, surviving **two** review rounds (r1's review also listed `:910` among the
     byte-for-byte fragments). The clause is now **restored in full** in §1.
   - **A second live defect the sweep also missed**: §1's `:818` cell carried `**` emphasis around
     "Rejected: (d) leave the derivations to the implementing slice" that the source does not have —
     identical words, added emphasis, inside a "Verbatim" column (round-2 NIT-1). Removed.
   - **The count and scope were wrong**: the sentence said "**ten** … **in §1**" and then listed
     **eleven** items, **two of which — §2.5's `:376` and OD-L11-9's `:375` — are not in §1 at all.**
     The accurate statement is **nine fragments in §1** (`:805`, `:808`, `:809`, `:817`, `:818`, `:819`,
     `:873` ×2, `:910`) **plus two quoted elsewhere** (`:376` in §2.5, `:375` in OD-L11-9).

   **What is claimed now, and its scope.** After the two repairs above, all eleven fragments were
   re-diffed mechanically against `604ae14e26` — see §9.8's sweep row, which states the command and its
   result. This is a **transcription** check only: it establishes that the quoted bytes match the
   source, and it establishes nothing about whether the quoted ODs mean what this document uses them
   for (`feedback_digest_pin_is_not_a_behavioural_gate`). r2 let a self-declared mechanical-verification
   result stand over an unverified sweep; that is the failure this rewrite is disposing, so the
   replacement claim is deliberately narrower than the one it replaces.

### 9.7 Not folded

Nothing was declined outright. Three items are **partially** rebutted, and each rebuttal is stated at its
row above rather than only here:

- **P2-2** — the review's "arm (g) may be rulable without resolving D-1 at all" is recorded as a
  *possibility with an argument on each side*, not adopted as a fact. Asserting D-1-independence would be
  the overclaim class this lock exists to prevent.
- **P2-4** — the review's implication that §4 would misdirect an implementer toward a non-required
  standalone lane is rebutted: `45490f57ec` (which post-dates the review's baseline) shows the standalone
  lane is the correct **default** for a new gate file, and required-lane promotion is the exception tied
  to activation dependency. The absolute prohibition is still withdrawn, as asked.
- **P2-8** — the review's "no in-product recovery other than re-login with a tenant selector, which the
  draft does not know is available" understates what exists: the Vue client already sends the selector
  header, including on login. The correction is folded at §2.2(iii), together with the caveat that it
  does nothing for the zero-membership class.

**Two items are carried forward, unresolved by design**, and are listed here so they are not mistaken for
folds: Lock-10's `:412` internal contradiction (**D-5**, recorded not adjudicated, as in r1) and the
`resolveRuntimeInstallContext` namespace (**U5**, deliberately left unverified so it is not quietly
adopted).

---

### 9.8 Round 2 — itemized disposition (r2 → r3)

**Source**: `/tmp/lock11-review2-20260822.md`, independent fold-verification review, verdict
**REQUEST-CHANGES** (2 P1, 2 P2, 3 P3, 6 NIT), bound to r2 sha256
`2933f56669f1f30f0d57cfd48dd59d06e7dcb23a18087baab1ead41dd1d0f600`, anchors verified at `604ae14e26`,
live tip `1b77c71348`. **Every finding has a row. Nothing is dropped.** Its verdict on the r1 fold
("close to exemplary … I could not break any of them") means §9.1–§9.7 are **not** re-opened; only the
three sites it names as still-defective are corrected (§9.3's P3-2 row, §9.6 items 2 and 6).

**Every anchor in every row below was re-read in this session at `604ae14e26` before the fold** — not
taken from the review's text — per `feedback_implementation_is_not_the_ratified_contract` and
`feedback_verifier_must_check_doc_vs_code`. Two rows record where that re-reading produced a **sharper**
answer than the review's, and two record where it produced a **narrower** one.

#### 9.8.1 P1

| # | Finding | Disposition | Where |
|---|---|---|---|
| **P1-A** | `OD-L11-9` arm (i)'s consequence is FALSE — the org conjunct is ANDed **outside** the readability disjunction, so a stale row goes dark for the subject and admins too, not only "their approvers in the new org". Inverts D-10's trade | **FOLDED+EXTENDED, and the RECOMMENDATION DID NOT SURVIVE.** Independently re-verified: `approval-instance-readability.ts:188-194` assembles `orgClause` only when the pin is on, and `:219` is literally `)${orgClause}` — the `)` closes the disjunction (arms 1–4 + admin at `:216-218`) and the conjunct is appended after it. The false parenthetical is **deleted**; arm (i)'s true cost is restated as "the row goes dark for **everyone, the subject included**, until Migration B or an admin re-stamps it"; the SQL is reproduced in OD-L11-9 so the reader can check the placement rather than trust the sentence. The trade table is re-derived under the corrected semantics ("subject loses read (i/iii)" vs "old-org approvers lose read (ii)"), the review's both-readings argument (moved vs added) is folded verbatim in substance, and the internal contradictions the review used as evidence (§7 class 3, RATIFIED OD-S1-9(e), D-9's invariant) are named. **Extension 1: `Recommended: (i)` is WITHDRAWN and D-10 is escalated with no lean** — every arm carries a cost this document elsewhere calls unacceptable, so an executing session recommending one would be choosing an outage or a widening on the owner's behalf. **Extension 2: the discriminator that may moot D-10** — all four arms differ only when a membership **moves between two orgs**, so if U1a returns `count(DISTINCT org_id) = 1` there is nowhere to move to. No new probe (same shape as U2 mooting D-7). **Extension 3: G-L11-9 gains the who-can-read assertion** the review asked for, plus the corrected conflict-branch witness (below) | OD-L11-9, D-10, §0.1, §6, G-L11-9 |
| **P1-B** | §2.3 concludes the attendance approval-create path has **no** membership validation. It has exactly arm (f)'s validation — in-transaction, before DML, on all five W-4 call sites | **FOLDED+EXTENDED, and SHARPENED IN BOTH DIRECTIONS.** The chain was re-walked in this session, not taken from the review: route `:30062` → `w4c3b-request-operation-boundary.ts:479` (`resolveSourceRef` handles `request_create` at `:323-325`) → `w4c0-operation-registry.ts:585,596` → `w4c0-authorization.ts:310,329-335`. Adapter reachability re-verified (each `execute*RequestCreate` twice repo-wide: definition + the `:34276-34279` dispatch; adapters registered at `:35415-35420`; no direct call sites). §2.3's conclusion is **withdrawn** and the paragraph rewritten as a **two-level path split** (below). The five consequences the review enumerated are folded where each belongs: OD-L11-7's arm (a) row corrected, its arm (f) row re-sized favourably, the **authorized-then-422** hazard folded into **D-3**'s attendance half *and* promoted to §0.1 item 5, `G-L11-4`'s negative re-specced to discriminate, and the boundary added to OD-L11-8 as the **third precedent** — the one that makes D-1's "forbid both" answer a ruling against a *landed* mechanism. **W-4's recommendation recomputed: (f) unchanged, basis materially stronger** (the slice adds stamping, not validation), **scope corrected** (a named legacy residue, not a new decision, so the D-count is unchanged) | §2.3, OD-L11-7, OD-L11-8, D-1, D-3, §0.1, G-L11-4, §5 trap 1, §8-U8, §7 (xv) |

**Where r3 goes BEYOND the review on P1-B (declared, because these are executing-session findings and
must be attackable separately):**

1. **The validated leg is CLIENT-OPT-IN, and the unvalidated leg is the posture every org is in
   today.** The review honestly scoped itself — "I did **not** exhaustively prove every route variant
   reaches the preflight … sizing the legacy branch is a probe-shaped question, not a repo-knowable
   one" — and proposed a path-split without sizing it. The **posture half is repo-knowable and is
   resolved here**: `w4c3b:449-466` returns before the preflight whenever `operationId === null` and the
   posture is `legacy_projection_only`, and `resolveSegmentCalculationPosture` yields exactly that for
   **every** org absent a persisted non-`legacy` row with `scope='synthetic_staging'` ∧ the
   `SEGMENT_CALCULATION_IMPLEMENTATION_CAPABILITY` flag ∧ an exact allowlist match — the module says so
   itself at `w4c0-identity.ts:377`. A **second** bypass leg the review did not name exists at
   `:427-437` (non-canonical org key + null `operationId`). And `operationId` is **`.optional()` on
   every request-create schema** (`index.cjs:32978`, `:32986`, `:31598`, `:31694`, `:31707`), so the
   discriminator is a client-supplied field. **Only the client population remains a probe — U8.**
   *Consequence for the parent task's own framing*: writing §2.3 as the flat sentence "arm (f) on the
   named path, `'default'`-admission on the unnamed path, no fall-to-(a)" would have been a live
   overclaim in the section whose whole purpose is to prevent one. That sentence is true **inside** the
   leg where validation runs; §2.3 now says so at two levels.
2. **The validation principal is an actor∧subject CONJUNCTION, not "subject-keyed".** The review wrote
   "for each subject in `subjectScope`". `recheckAttendanceActorLivenessInTransactionV1` also runs
   `requireActiveMembership(verified.actorId)` at `:344-346`, skipped only at
   `actorPosture === 'platform_admin'` and waived wholesale for the registered internal scheduler
   identity; and when `subjectScope.kind === 'org_scheduler'` (`:315-320`) `subjectUserIds` is `[]`, so
   **no subject is checked at all**. All three facts are in §2.3's principal table. This *strengthens*
   the review's finding on the cross-user posture (both principals must hold the org) and *qualifies*
   it on the scheduler scope.
3. **G-L11-4's non-discrimination is conditional on the fixture's `operationId` posture.** The review
   said negative (i) "plausibly already passes today". That is true on the **validated** leg only; on
   the legacy leg `O-EVIL` is written. So the gate must **pin its `operationId` posture explicitly**, or
   it tests an unspecified path — a requirement neither the review nor the parent task states, and the
   difference between a reproducible gate and a coin flip.

#### 9.8.2 P2

| # | Finding | Disposition | Where |
|---|---|---|---|
| **P2-A** | Arm (f)'s **validation principal** is unspecified at W-4's cross-user posture — the only posture where it matters, and W-4 is the writer (f) is recommended for. Three downstream defects follow | **FOLDED+EXTENDED.** §3's (f) definition now **rules the principal: the SUBJECT** (= the requester OD-L11-1 keys on), with the rationale stated (validating against the operator would stamp an org the requester may not hold — the exact failure OD-L11-1 exists to prevent) and with the **specification / shipped-fact distinction kept explicit**: the shipped boundary additionally conjoins the actor except at `platform_admin`, and checks neither at `org_scheduler`. The cited punch precedent is recorded as **not** settling it (`resolvePunchOrgIdV1` validates the *caller*, and punch is self-service so caller ≡ subject; its docblock scopes it to one route at `:119`). **Propagated to both sites the review named**: **OD-L11-10's scope sentence** is re-scoped — under (f)-with-a-name the stamp **is** `route.orgId`, so the two agree and no split-brain arises; the divergence is arm-(a)-specific plus (f) falling back to (a) — and **G-L11-8's negative is re-aimed** onto the one cleanly constructible divergence (request names nothing ⇒ `attendance_requests.org_id = 'default'` while the subject's single membership is `O1` ⇒ instance `O1`), replacing r2's case, which under the now-specified (f) would have been **vacuously green** — the exact failure its own mutation cell warns about. **G-L11-4's negative (i)** is likewise made writable-from-spec by naming the principal and the refusal code | §3 (f), OD-L11-10, G-L11-8, G-L11-4 |
| **P2-B** | §9.6 item 6's "all ten … re-diffed programmatically … and now match" is FALSE for `:910`, which is still silently truncated inside the "Verbatim" column; the count and scoping are also wrong | **FOLDED+EXTENDED.** Lock-10 `:910`'s dropped clause — "(environment, approver, time, evidence, rollback — ledger rule 5)" — is **restored in full** in §1 (not ellipsed; the clause is short and its content is load-bearing for §5's activation row). The false claim is **withdrawn at BOTH sites that carried it**: §9.6 item 6 and **§9.3's P3-2 row**, which r2 used to record the review's byte-for-byte confirmation and which the round-2 review did not name — *the withdrawn-absolute-propagation discipline this document applies to r1's absolutes, applied to its own*. Count and scope corrected: **nine** fragments in §1 plus **two** quoted elsewhere (`:376` in §2.5, `:375` in OD-L11-9), not "ten in §1". The replacement claim is deliberately narrower than the one it replaces and is explicitly a **transcription** check, not a semantic one. **Extension — a THIRD instance of the same defect class, found by r3's own re-diff and named by neither review**: the provenance-grading note cut Lock-10 `:819`'s "2026-08-21 (§5.1.1)" from inside the bold with no ellipsis. Restored | §1, §1's transcription-repair note, §9.3 P3-2, §9.6 item 6 |

#### 9.8.3 P3 / NIT

| # | Finding | Disposition | Where |
|---|---|---|---|
| **P3-A** | §2.8's zero-membership claim is unconditional; true only for admissions **after** `zzzz20260114110000` ran | **FOLDED**, at all three sites the review named (§2.8, §0.1 item 1, §7 class 1b), with the reason (backfill 1 is one-time and swept the pre-migration cohort into `'default'`) and the reason it does not change D-8 (U1b measures the population directly) | §2.8, §0.1, §7 class 1b |
| **P3-B** | §7's sweep table omits the absolute arm (g) rests on — "`req.authenticatedTenantId` is claim-only and the header backfill cannot reach it" | **FOLDED.** Added as absolute **(xiv)**, with the review's verification **independently re-run in this session** and cited as its basis: `git grep -nE "authenticatedTenantId[[:space:]]*=[^=]" 604ae14e26` returns exactly three lines — `jwt-middleware.ts:101` (local, from the verified JWT payload), `:103` (**the only production write**), and one unit-test assignment; the header backfill at `:106-108` runs **after** `:103` and writes only `user.tenantId`. Every other repo-wide hit is a read, a type declaration, a test fixture literal, or a comment. Scoped "this baseline only" and tied to U6's re-census. **Extension**: absolute **(xv)** added for r3's own new load-bearing absolute (§2.3's client-opt-in split), so the table stays the artifact a gate round attacks | §7 (xiv), (xv) |
| **P3-C** | `OD-L11-9` omits the fail-loud arm — the one most consistent with the document's own failure-shape discipline | **FOLDED.** Arm **(iv)** added: re-derive, and refuse the re-submit if the result differs from the stored value. Posed with the review's own argument (it is the shape OD-L11-3 mandates and arm (a) uses, so omitting it was an internal inconsistency) **and rejected-or-accepted by the owner rather than by this document** — its cost, mid-flow wedging at every subsequent state transition, is stated plainly. **Partial rebuttal of the review's lean**: the review suggested (iv) "reads much more attractively" once (i)'s true cost is stated. r3 declines to convert that into a recommendation — with (i)/(iii) breaking D-9's invariant, (ii) a widening, and (iv) an outage of a different shape, **the honest output is an escalation with no lean**, not a re-ranking toward (iv) | OD-L11-9, D-10 |
| **NIT-1** | §1's `:818` cell adds `**` emphasis not in Lock-10 `:818` | **FOLDED.** Emphasis removed; verified against the source line, which reads "… no `'default'` fallback. Rejected: (d) leave the derivations to the implementing slice" with no emphasis | §1 |
| **NIT-2** | `:7342` does not pass `requesterOverride`; there is exactly **one** such caller | **FOLDED at all three sites.** Re-verified: `:7342` is `previewApprovalRoute`'s call with `whitelistFormDataToSchema` + `requesterChoicePresence` only; the single override caller is `previewTemplateRoute` at `:7366-7371`, token at `:7370`, itself conditional on `options.sampleRequester`. The correction runs in the **safe** direction (the requester≡actor argument is strengthened), and that is stated at each site so no reader mistakes it for a weakening | §2.1, §7 (viii), §9.6 item 2 |
| **NIT-3** | §2.7 cites `approval-instance-readability.ts:64-71` for B-1/B-2; the findings are the bullets at `:57-62` | **FOLDED.** Both ranges now cited with their roles (`:57-62` the bullets, `:64-71` the "Consequence:" paragraph citing them at `:68`) | §2.7 |
| **NIT-4** | The W-1 requester-snapshot object literal runs `:7253-7288`, not `:7253-7268` | **FOLDED**, with the substantive claim ("no `orgId` key anywhere in it") explicitly restated as holding across the full range — re-verified by reading `:7250-7292` | §2.1 |
| **NIT-5** | The drift enumeration's three globs miss `apps/web/tests/multitable-record-provenance-panel.spec.ts` | **FOLDED.** The baseline block now gives the **thirteen-file** count with the missed file named, and the unchanged conclusion restated. Re-verified with `git diff --name-only 604ae14e26..1b77c71348` | baseline block |
| **NIT-6** | §5's "Suggested order" mixes D- and OD-numbering and never names D-3 or D-4 | **FOLDED.** The order is re-sequenced with **every** step named by D-number, D-3 and D-4 placed explicitly, and D-5/D-6 recorded as sitting outside the chain. **Extension**: D-3's placement now carries the pointer to the authorized-then-422 hazard, and U8 is placed before W-4 | §5 |

#### 9.8.4 What the review attacked and could not break — RECORDED, not re-litigated

The round-2 review's "what I attacked and could not break" list is **RECORDED in full and is not
re-argued anywhere in r3**: the withdrawn-absolute sweep (5 absolutes × full-document grep, no live
restatement); all three r1 partial rebuttals (P2-2's *may*, P2-4's binary `--stat` verification of
`45490f57ec`, P2-8's `authHeaders` chain); both corrections r2 made to the r1 review (W-2's collapse
verified from both ends; the `:873` quote-mark fix verified character-exact); arm (g)'s unforgeability
(attacked by repo-wide assignment census — now folded into §7 as absolute (xiv)); provenance discipline
(10 `DRAFT — OWNER-CONFIRM` lines for 10 ODs, no L11 OD claiming RATIFIED, the (c-i) downgrade correct);
probe values-freedom; the D-3/D-7 and D-8/D-3 interactions; and ~70 additional anchors verified
line-exact by two subagents. **r3 changed none of these and adds no claim that contradicts one.**

**One incidental find carried to the implementer, as the review asked** *(it is not a finding against
this document)*: W-4's UPSERT lists `version` and `created_at` in the INSERT column list but updates
**neither** on conflict (re-read at `604ae14e26`, `plugins/plugin-attendance/index.cjs:24061-24086`), so
`version` cannot witness that the conflict branch executed. Folded into **G-L11-9's positive-control
cell**, with the further constraint r3 adds: the remaining witness, `updated_at = now()`, is
**transaction-fixed**, so the two submits must be in **separate transactions** or the witness is
vacuous.

#### 9.8.5 Mechanical self-sweep of this fold

Run against the r3 text before it was declared done, because a fold that withdraws absolutes is exactly
where a live restatement survives (`feedback_absolute_claim_sweep_must_be_mechanical`, and the check the
round-2 review used to validate the r1 fold). Each term was grepped across the whole document; **every
hit must sit inside a withdrawal, a quotation of the superseded text, or a ledger row.**

| Swept term | Why | Required disposition of every hit |
|---|---|---|
| `they still read it via predicate arm 1` / `their approvers in the new org` | P1-A's false parenthetical | deleted from OD-L11-9; surviving hits only where the withdrawal quotes it |
| `no membership check at all today` / `no membership validation of its` | P1-B's withdrawn conclusion | §2.3 (inside the quoted withdrawal), OD-L11-7 arm (a) (inside "r2 said … that is FALSE") |
| every `D-10` recommendation restatement | the withdrawn `Recommended: (i)` | §0.1, §6, OD-L11-9 all say WITHDRAWN/escalated; no live "recommended (i)" |
| `ten quoted fragments` / `re-diffed programmatically` | P2-B's false claim | §9.6 item 6 only, struck; §9.3 P3-2 struck |
| `7342` | NIT-2 | **This sweep caught one live restatement and it was fixed**: OD-L11-1's first bullet still read "the only override callers are the two preview paths `:7342`/`:7366`" after §2.1 had been corrected. Now §2.1, OD-L11-1, §7 (viii) and §9.6 item 2 all state that `:7342` passes **no** `requesterOverride`. Recorded rather than quietly repaired, because "the fold missed a site" is exactly what this sweep exists to surface |
| `7253-7268` | NIT-4 | no live restatement; every hit is a correction or a ledger row, and the live range is `:7253-7288` |
| `:910` | P2-B | §1 cell carries the full clause; §9.3 / §9.6 carry the withdrawal |
| `DRAFT — OWNER-CONFIRM` vs `### OD-L11-` | the property r2 passed on and is easiest to break while editing an OD | must remain **10 : 10**; OD-L11-9's status line was edited (recommendation withdrawn) and must still carry the label |
| `recommended arm` / `created by the recommended` | **a surface the FOLD ITSELF created**, not one r3 inherited: re-scoping OD-L11-10 (P2-A) made every "the recommended arm creates the split-brain" sentence an overstatement, because W-4's recommended arm is (f) and (f)-with-a-name creates no divergence | **This sweep caught a SECOND missed site — the more consequential of the two.** Only OD-L11-10's *body* had been re-scoped; its **heading** still said "the split-brain the recommended arm creates on W-4" (contradicting the paragraph two lines below it), **§7 outage class 6** still said "**This is created by the recommended arm**, not inherited", and **§6's D-11 row** carried no scope at all — so the outage list and the menu row an owner rules from both overstated the cost of the arm the document recommends. All three corrected; the (ii) recommendation is unchanged, only its exposure. **Method note recorded deliberately**: the first pass of this table swept only terms r3 *withdrew*, and a re-scope creates a propagation surface with no withdrawn term attached to it. A sweep built from the withdrawal list alone is structurally blind to that class |
| `TWO counts` vs `U1a/b/c are BLOCKING` | a self-declared count in the sequencing section an implementer reads for merge gates — same class as the §9.6 "Four/six" miscount | §5's header said "TWO counts" and §0.1 item 4 said "two counts", while §8 marks three probes blocking. **Both** aligned to §8 (the authoritative form) with the reconciliation stated: U1a/U1b size the two refusal populations, U1c is the discriminator that explains U1a's answer; all three block |
| non-count `SELECT` in §8 | probe values-freedom, likewise easiest to break while adding U8 | **RE-RUN: PASS.** Every `SELECT` in §8 is a `count(*)` / `count(DISTINCT …)`, or a `SELECT 1` inside a `NOT EXISTS` subquery of one. U8 is count-only and emits no org id, user id, request id or client string |
| **the eleven quoted Lock-10 fragments** | the P2-B claim r3 replaces — a narrower claim still has to be true | **RE-RUN: PASS.** After the `:910`, `:818` and `:819` repairs, each fragment was tested for containment in **both** its source line at `604ae14e26` (`git show 604ae14e26:docs/development/approval-lock10-instance-readability-20260821.md`) and this document: `:805`, `:808`, `:809`, `:817`, `:818`, `:819`, `:873`(×2), `:910` — nine in §1 — plus `:375` (OD-L11-9) and `:376` (§2.5). **11/11 matched.** Transcription only; it says nothing about whether the quoted ODs mean what this document uses them for |

**Scope of this sweep, stated so it is not over-read**: it is a **text** sweep of this document against
its own withdrawals. It is not verification of anything in the repo, and it does not certify that the
r3 text is correct — only that no sentence r3 withdrew is still asserted somewhere r3 forgot to look.

#### 9.8.6 Not folded

**Nothing was declined outright.** Two items are **partially** rebutted, each stated at its row above:

- **P3-C** — the review's lean toward the fail-loud arm ("reads much more attractively") is folded as an
  **arm**, not as a re-ranking. Converting it into a recommendation would substitute one
  executing-session preference for another on a question where every arm carries a cost this document
  calls unacceptable elsewhere. D-10 is escalated with **no lean**.
- **P1-B's framing** — the review's path-split, and the parent task's flat restatement of it, are both
  **sharpened rather than adopted**: the validated leg is client-opt-in, the unvalidated leg is
  universal by posture, and the validation principal is a conjunction. §9.8.1's three declared items
  carry the evidence, and each is attackable on its own.

**Three items are carried forward, unresolved by design**: Lock-10's `:412` contradiction (**D-5**), the
`resolveRuntimeInstallContext` namespace (**U5**), and — new at r3 — the **legacy-leg client population**
(**U8**), which is an ops question like U7 and is recorded as unresolved rather than estimated.

---

*Draft r3 prepared 2026-08-22 against `origin/main@604ae14e2685f1f6f2c32e8238f0df7fb3525d29`.
Supersedes r2 (sha256 `2933f56669f1f30f0d57cfd48dd59d06e7dcb23a18087baab1ead41dd1d0f600`), which
superseded r1 (sha256 `1e31c85f21fe655e91ff1a83cf2031051ecc3e84e6e1d03ef67256ba2ef398e1`). Not in the
repo; not a ratification; not a verification report. **Ten ODs, all DRAFT — OWNER-CONFIRM; eleven owner
decisions D-1…D-11, none of them answered here.** r3 adds no OD and no decision. It **withdraws one
recommendation** (D-10, OD-L11-9 arm (i) — the arm ranking rested on a false consequence) and **re-bases
two** without moving their direction (D-1's and D-3's W-4 halves). Anchors are bound to `604ae14e26`;
an implementer must re-run U6's census at their own head
(`feedback_verify_against_current_main_not_stale_base`).*


---

## 10. Ratification block (2026-08-22) — owner sixth by-reference reply

**Provenance.** The executing session presented the owner a ten-item recommendation list (D-10 already
retired by evidence) plus the interlocked 269-row ruling; the owner replied 「按建议执行」 (2026-08-22,
the SIXTH by-reference reply of the closeout arc). The list was authored by the executing session; the
owner's authored contribution is those four characters. Per the standing rule the authorization reaches
exactly the enumerated items. The referenced list, verbatim:

> 1. **D-1** 派生通道 → **两通道皆许、但一切通道必须对 `user_orgs` 验证**(考勤边界已 shipped 此模式);
> 2. **D-2** 售后 W-3 → **(d) 现在**(afs: 留 NULL)+ 后续 (a)-带验证;OD-S1-18 范围变更记为激活前置;
> 3. **D-3** 确认 (a) 底座 + 422 失败形(实测今天拒零人);
> 4. **D-4** 确认 requester 键 + W-2 的 `config.requester.mode` 后半;
> 5. **D-5** 认可 Lock-10 `:412` 勘误;
> 6. **D-6** 不整体延迟 W-3/W-4;
> 7. **D-7** W-1 现在确认 **(a)**;(g) 留待多 org 现实出现;
> 8. **D-8 + 269 行(同一裁决)** → **(β) 为 12 名零成员活跃用户补 provisioning** + **(i)-guarded**:修订 Migration B class-6 处置为「**当且仅当全库恰一活跃 org 时**回填该唯一 org,否则照旧 ABORT」(单 org 前提在迁移内自断言,fail-loud 保留)——此项同时解锁 #5103 合并;
> 9. **D-9** 单 `is_active` 谓词;
> 10. **D-11** (ii) 加 values-free 等值门(G-L11-8)。

**Evidence the rulings rest on** (all durably archived, soak-working/ + the two in-repo evidence runs):
u1a_distinct_active_orgs=1, u1a_multi_org_active_users=0, u1b_zero_membership_active_users=12,
u1c_non_default_integration_rows=0 (run 32568321791, main); c6_terminal=269, c3_zero_membership=257
(run 32562970891, #5103 branch `0bf9f4711c`, log archived).

### 10.1 Resolution table

| Decision | Ruling | Notes |
|---|---|---|
| D-1 | **Both channels permitted, EVERY channel must validate against `user_orgs`** | unvalidated channels forbidden; the shipped attendance boundary pattern is the precedent, not a violation |
| D-2 (W-3) | **(d) now** — `afs:` rows stay NULL (dark at activation) + (a)-with-validation later | the OD-S1-18 id-shape scope change (`plm:` → `plm:`/`afs:`) is RECORDED as an activation precondition, not executed here |
| D-3 | **CONFIRMED** — arm (a) is the derivation floor for platform/automation/attendance; failure shape = values-free 422 | measured refusal population today: zero (u1a_multi=0); the zero-membership class is emptied by D-8(β) BEFORE any arm-(a) writer ships (see the binding ordering in §10.2) — no live 422 window for those 12 is scheduled |
| D-4 | **CONFIRMED** — requester-keying; W-2's keying user follows per-action `config.requester.mode` | actor≠requester consequence accepted as drafted |
| D-5 | **Erratum acknowledged** — Lock-10 `:412` (PLM `SET NOT NULL` vs NULL-permanent) affects Phase 3's migration text only (body `:1455`); it sits outside this chain (`:1425`) and is corrected whenever Phase 3's text is next edited | recorded, unexecuted here |
| D-6 | **No blanket deferral** of W-3/W-4 | activation requires all four writers dispositioned |
| D-7 | **W-1 arm (a) now**; arm (g) deferred until a multi-org reality exists | u1a=1 makes (g) zero-gain today; revisit trigger = a second active org appearing |
| D-8 + 269 rows | **(β), ordering half as the body defines it** (`:1458`): the provisioning step lands **BEFORE any writer slice, so the population is empty when the arms land** — concretely, provision the 12 zero-membership active users into the single org **+ (i)-guarded**: Migration B's class-6 disposition revised to "backfill the unique org IFF exactly one active org exists repo-wide, else ABORT as ruled" — the single-org premise self-asserted INSIDE the migration, FAIL-LOUD retained | this ruling unblocks #5103 (after its revision + re-gate); it is an owner amendment of the class-6 arm, made by this by-reference ruling. The ordering is part of the ruled arm, restated as binding in §10.2. **Residual (not closed by this ratification):** the body's (β) names an ONGOING org-aware admission step on the two producer paths (self-registration, DingTalk JIT — body `:671-687`); the ratified list scoped this ruling to the CURRENT 12, so the class refills over time and a future zero-membership user meets the 422. Making (β) durable (the admission-step code fix) is a FUTURE OWNER ITEM, deliberately not smuggled into this by-reference authorization |
| D-9 | **Single `is_active`** liveness predicate (byte-agreement with the reader) | read together with retired D-10 |
| D-10 | **RETIRED BY EVIDENCE** (u1a=1 — nowhere to move to) | not answered; re-opens automatically whenever a second active org appears — NO time bound (the body's moot-condition has one parameter and no sunset). If that happens after the W-4 slice ships, the shipped `DO UPDATE` behaviour is NOT a de-facto ruling: D-10 must then be answered before activation proceeds |
| D-11 | **(ii)** — gate the same-transaction split-brain with the values-free equality gate G-L11-8 | scope as narrowed at r3 |

### 10.2 What this ratification authorizes and what it does not

**Binding ordering (part of ruled arm D-8(β), not advisory):** the D-8(β) provisioning migration must
be MERGED (and therefore auto-deployed) **before any arm-(a) writer slice merges** — W-1/W-2 and W-4 land
only after the zero-membership population is empty. Concretely: the revised #5103 (which carries the
provisioning migration ordered before the backfill) merges FIRST; the writer slices follow. Migration B's
own position is therefore ON the (β) side of the fence: it ships WITH the provisioning step, ahead of
every writer slice.

Authorizes: the implementation slices for the ruled arms (each still requires its own PR, required CI,
independent adversarial gate, and ledger row), including the Migration B class-6 revision and the D-8(β)
provisioning migration, subject to the binding ordering above. Does NOT authorize: org-pin activation (separate authorization with its own
ledger row per Lock-10 §5.1.2), Phase 3 `SET NOT NULL`, `APPROVAL_ATTACHMENTS_ENABLED` ON, any staging/
prod flag change, or the OD-S1-18 scope change (recorded as an activation precondition only). No
verification claim is made by this block: §4's gates specify acceptance; none has run at ratification.

### 10.3 Seventh by-reference ruling (2026-08-22) — closeout-plan amendments from the max-effort review

**Provenance.** A Fable-5 max-effort adversarial review of the closeout plan
(/tmp/closeout-approach-review-20260822.md, archived copy in soak-working/) returned
PLAN-NEEDS-AMENDMENTS; the executing session presented four items; the owner replied 「按建议执行」
(2026-08-22, the SEVENTH by-reference reply). The reply covers items 1–3; item 4 (attachments-flag UAT
actor/env/checklist) requires owner-authored content and remains OPEN. The referenced items, verbatim:

> 1. **gap-closer 迁移**(P1-2):同 (i)-guarded 模式的第二个收口迁移,折进 W1W2 切片、随其部署执行——把「Migration B 一次性执行→W1W2 上线」之间产生的 NULL 行窗口结构性归零。建议:**授权**;
> 2. **阶段 3 步骤改名**(P2-1):ratified 记录的正确形是 `CHECK (org_id IS NOT NULL OR id LIKE 'plm:%')`(+afs: 按 D-2),不是字面 `SET NOT NULL`;G-S1-12-FULL 的 `is_nullable='NO'` 在该 CHECK 下不可满足,需在阶段 3 锁起草时 ratify-first 重述。建议:**采纳改名与重述路径**;
> 3. **激活前置追加**(P2-4):「激活 dispatch 时 u1b=0」为具名前置;准入修复(防回灌)开 tracked 项,建议排在激活前落地。建议:**采纳**;
> 4. **附件 flag UAT**(P3-4):需要你指定 UAT 的执行人/环境/清单。 [NOT covered — needs owner-authored content]

| Item | Ruling | Effect |
|---|---|---|
| 1 gap-closer | **AUTHORIZED** | a second (i)-guarded backfill migration (same single-org self-assertion, FAIL-LOUD, same class semantics over `org_id IS NULL` platform rows) rides the W-1/W-2 slice and executes at ITS deploy — the Migration-B→W1W2 creation window becomes structurally nil |
| 2 Phase-3 renaming | **ADOPTED** | the plan step is "OD-S1-18(b) CHECK (+`afs:` per D-2) + D-5 fold + G-S1-12-FULL ratify-first restatement", never literal `SET NOT NULL`; the restatement happens when the Phase-3 lock is drafted |
| 3 activation preconditions | **ADOPTED** | org-pin activation dispatch requires **u1b = 0** (split probes: no-row AND only-deactivated-row both zero) and re-checks u1a=1 (STOP on >1 — D-10 reopens); the admission-step fix (refill class) is a TRACKED item recommended before activation |
| 4 attachments UAT | **OPEN** | needs owner-authored actor/env/checklist; not reachable by a by-reference reply to a list that carried no recommendation content |

Session-executed under existing authorization (recorded, not new grants): u1b split probes + the
mandatory prod evidence dispatch between #5103's deploy and the W-1/W-2 merge (merge gated on u1b=0);
staging U1 probes moved outside the NOT_APPLIED short-circuit with pre-measurement before the staging
catch-up; the (β) mechanical tripwire (migration-presence assertion in each writer suite; no armed
auto-merge while #5103 is open); the evidence-workflow read-only gate (o2 precedent); W-4 scout/gate at
max effort.

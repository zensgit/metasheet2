# Lock-10 (S1) — The Per-Instance Readability Predicate (2026-08-21)

**Status:** **RATIFIED 2026-08-21** — §4 records the decision under owner-directed, execute-by-reference
provenance and separates the ODs the authorization reaches from those it does not; §7 records the
disposition of the independent adversarial review that preceded it (REQUEST-CHANGES: 3 P1, 5 P2, 6 P3,
4 NIT — all closed or rebutted in-document). Design authority ONLY. No runtime code, no migration, no
flag, no UAT, no deployment, and no completion label is authorized by this document; the ratification is
reversible before any dependent implementation lands. Every contract below still needs its own PR,
required checks, an independent adversarial gate, and a ledger row.

**This document CLOSES Lock-7 §2.7 D-5 on ratification** (§4 records that ratification; §5.3 records
the propagation edits it requires). D-5 reads, verbatim from
`docs/development/approval-lock7-field-edit-enforcement-20260817.md:344`:

> "Instance-detail read surfaces are permission-scoped, not participant-scoped; one adjacent read
> surface's guard is being aligned to its siblings in a separate hardening slice (details held in the
> private line inventory per the disclosure doctrine) | private inventory | **EXTERNAL DEPENDENCY, OPEN
> owner question, deliberately not settled here.** Lock-7 does not narrow or widen the read scope; it
> only refuses to add a values channel to the wider of the read surfaces (OD-L7-7). Any later document
> must resolve read scope on its own authority"

This is that later document, and it resolves read scope on its own authority. It is **the resolution of
D-5, not a parallel artifact**: the house hazard "another, narrower artifact for the same question is a
contract narrowing" (`feedback_second_narrower_artifact_is_contract_narrowing`) is named here because a
document that invented a new question ("who may read comments?") and quietly left D-5 open would be
exactly that failure. Lock-7's D-5 row, `:395` ("D-5 read-scope stays an OPEN owner question") and `:503`
("D-5's instance-detail read scope is an OPEN owner question and is NOT resolved by this document") all
become stale on ratification of this lock; §5.3 records that propagation as a required edit, not as a
side effect.

**It also discharges Lock-7 §2.7 D-4** (`:343`): "Two divergent participant predicates with no shared
helper | `approval-attachment-runtime.ts:201-243`; `routes/approval-metrics.ts:193-215` | Pre-existing
divergence. Lock-7 adds no third; its authorization is the active-seat check". D-4 forbids minting a
fourth predicate. This lock does not mint one: it rules ONE predicate and migrates every existing
construct onto it (§2.1, §2.10). If a reader can finish this document and still count more than one
**admission predicate** on main after the slices land, the document has failed its own claim. The test is
deliberately about admission predicates and not about "instance-membership constructs" at large: §2.10
keeps C-3 and C-4 on main as **feed filters**, and both of them compute membership in SQL. An absolute
phrased over every membership construct would be false on the day the slices land, which is the failure
mode `feedback_absolute_claim_sweep_must_be_mechanical` names (review P2-4, closed).

**Baseline (source anchors):** `origin/main@c473a079b5ff6389b98f4919bb88607a0baa913b`. Every SOURCE
anchor below was read at this baseline. At ratification the line numbers were re-checked and roughly a
dozen of them were off by one to three lines against that same baseline; they are corrected in place and
the correction is recorded in §7 (review P3-6). The unqualified header sentence this document originally
carried ("Every anchor below was READ AT THIS BASELINE") was true of the reading and false of the
transcription, so it is replaced by this qualified one rather than left standing.

**Live state (what is merged / ratified) is NOT baseline-scoped.** Per
`feedback_verify_against_current_main_not_stale_base`, every "is on main / is open / is ratified" claim in
this document is stated against **`origin/main@0ced183c04`** (2026-08-21), not against the anchor
baseline. The commits between the two are docs- and CI-only — `git diff --stat c473a079b5 0ced183c04 --
packages apps` is empty — so no source anchor moved, but two documents this lock depends on **landed**
in that window; §7 P1-3 records what that changed. The repository is not shallow
(`git rev-parse --is-shallow-repository` -> `false`), so ancestry answers here are trustworthy; no
ancestry claim is made about any document this file does not cite by SHA or PR number. Unqualified anchors carry their file path.

**Parents:**
- `approval-parity-master-design-lock-20260817.md` (RATIFIED, on main) — **M8** (`:227-232`, configuration
  and enforcement must be honest; "UI configuration cannot claim a security property the runtime does not
  enforce") and **M11** (`:247-250`, evidence language is scoped). §6 discharges both against this text.
- `approval-lock7-field-edit-enforcement-20260817.md` (RATIFIED, on main) — D-4 (`:343`) and D-5 (`:344`),
  above. Lock-7's own authorization model (the ACTIVE-seat check for WRITE) is untouched: this lock rules
  READ admission only and never widens or narrows any write path.
- `approval-lock9-handler-process-attachments-20260819.md` — **RATIFIED 2026-08-21, ON MAIN** (PR #5011,
  squash `f01045f2e9`, merged 2026-08-21; **not** an ancestor of this document's anchor baseline). Its
  ratified OD-L9-13(a) reuses `isInstanceParticipant` **UNCHANGED**, and its ratified gate G-4 is
  "Participant predicate reused unchanged" (`:398`, `:501-503`, `:631-638`). OD-S1-10 removes the org pin
  that OD-L9-13(a)'s rationale rests on and OD-S1-16 removes the function G-4 names, so this lock does
  **not** merely make a Lock-9 sentence stale — it requires an **amendment of ratified normative text**.
  §2.11 rules the interaction and §5.1 carries it as a blocking owner decision.
- The approval-comments D-arm decisions recorded in PR **#5050** — **MERGED**, squash `3c789110db`
  (2026-08-21), landed in `docs/development/approval-parity-execution-ledger-20260817.md`. §0 records that
  provenance.

**Non-effects:** no migration is executed by this document, no flag changes, no tenant UAT, no
deployment, no completion label. The contracts below are design authority for slices that must each run
the full gate.

---

## 0. Provenance (recorded verbatim-faithfully, NOT restated in owner voice)

On 2026-08-21 the executing session enumerated a list of recommendations to the owner. **The
recommendation text was authored by the executing session.** The owner replied, literally:

> 「按建议执行」

The owner therefore authorized execution **BY REFERENCE** to that enumerated list. This is recorded this
way deliberately: the house rule `feedback_authorization_source_must_be_owner_authored` names
"paraphrasing the executing session's own recommendation into owner-authored prose" as a P1
self-certifying loop. Nothing below is presented as owner-authored wording; the owner's authored
contribution to this record is the four characters quoted above, plus whatever the owner writes into §4.

The enumerated recommendations, as put to the owner (executing-session voice, condensed only by
selection, not by rewording into decisions the owner did not see):

| # | Recommendation as enumerated | Disposition |
|---|---|---|
| (a) | **§K2 identifiability amendment: DO NOT make it.** Keep the FE-only posture. The backend arm was WITHDRAWN in #5043 (`545b3cadd1`) as contradicting the RATIFIED Lock-1 §K2 create contract | executed as recommended — **out of scope of this lock**, recorded only so the reader can see what else rode the same authorization |
| (b) | **G-14: accept-as-amended.** The census was honestly downgraded to a best-effort backstop with **the COMPILER as the primary gate** (a fifth member ⇒ `tsc` and `vue-tsc` both red, mutation-proven), which satisfies G-14's intent | executed as recommended — out of scope of this lock |
| (c) | **Lock-9 (PR #5011): ratify as drafted** (13 ODs, ratify-ready) | **executed** — #5011 MERGED as `f01045f2e9` (2026-08-21) and the landed document's header reads "Status: RATIFIED 2026-08-21". The ratifying session recorded a **count erratum** (the fold added OD-L9-14, so FOURTEEN ODs were ratified, not the 13 enumerated) and a **wording amendment at ratification** (an attachment-only scope clause on OD-L9-13(a)). §2.11 sequences against the landed text, not against the draft |
| (d) | **approval-comments decisions.** **D1 arm (i)** — add `org_id` to `approval_instances` with an explicit backfill ruling. **D2 arm (b1)** — a mutable `approval_comments` table; the audit row carries a pointer (`metadata.commentId`), the body lives only in the mutable table; deletion leaves a tombstone (`deleted_at` + author retained, **body cleared**). **D3** — widen comment WRITE from acting-assignee-only to the participant union. **D5** — @-mention candidates participant-scoped, not org-wide | authorized. **These are INPUTS to this lock and are NOT re-litigated here** (§2.2 → OD-S1-9; §2.4 → OD-S1-14/15) |

**Reversibility:** the authorization is reversible before dependent implementation lands. No
implementation depends on it yet at this baseline.

**What this lock adds on top of (d):** D1(i) says "add `org_id` with an explicit backfill ruling"; the
ruling itself was not enumerated to the owner and is therefore NOT covered by 「按建议执行」. §2.2 drafts
it. The part of it that cannot be derived from the repository — the anchor for PLM mirrors, OD-S1-9(c) —
was drafted as a §5.1 escalation and is **RULED (c-iii) at ratification** under this document's own design
authority, because the independent review established that two of its three arms were outages rather than
trade-offs (§2.2(c), §4, §7 P1-1/P2-1). It is recorded as SESSION DESIGN AUTHORITY, not as an owner
decision, and it is reversible on inspection: every rejected arm and its consequence is written out.

---

## 1. Shipped surfaces census — FIVE constructs, not two

The task framing named two constructs; Lock-7 D-4 names two **different** ones. Both framings are
partial. The mechanical enumeration at this baseline is five, and writing "the two existing constructs"
would contradict the very D-4 row this document cites. Every row below was read at the baseline.

| # | Construct | Anchor | Kind | Arms present | Org pin | `is_active` |
|---|---|---|---|---|---|---|
| C-1 | `isInstanceParticipant` | `packages/core-backend/src/services/approval-attachment-runtime.ts:201-244` | **admission gate** (attachment byte path + refs) | requester `:224`; assignment user-or-role `:225-230`; past actor `:231`; CC user-or-role `:232-237`; admin `:238` | **YES, but attachment-EXISTS-scoped**: `EXISTS (SELECT 1 FROM approval_attachments att WHERE att.instance_id = i.id AND att.org_id = $4)` `:219-222` | assignment `is_active` **ignored**; `users.is_active` required on the admin arm `:238` |
| C-2 | Metrics instance ACL | `packages/core-backend/src/routes/approval-metrics.ts:193-215` | **admission gate** (`GET /api/approvals/metrics/instances/:instanceId`, `:161-163`) | requester `:197`; assignment user-or-role `:198-205`; past actor `:206-209`; admin via `isAdminActor` `:175`, `:32-42` | **NONE** | assignment `is_active` ignored; admin arm is **JWT-claims-only** (`req.user.role`, `roles`, `permissions.includes('*:*')` `:33-41`) — no DB read |
| C-3 | `listApprovals` tab SQL | `packages/core-backend/src/services/ApprovalBridgeService.ts:300-564` — **three branches**: PLM `:363-394`, external `:396-488`, platform `:489-561` | **feed filter**, not an admission gate | **per-branch AND per-tab; not a union, and the three branches do not agree.** *Platform* `:489-561`: `pending` = active seat incl. **`source_queue`** `:504-511`; `mine` = requester `:513`; `cc` `:514-525`; `completed` = requester OR actor OR cc OR seat (**`is_active` dropped**) `:528-550`; `processed` = actor `:552-561`. *External* (`includeExternalTabSources`) `:396-488`: same platform arms **plus** an actor-free source arm on `pending` `:421-424` and `completed` `:470-473`. *PLM* (`sourceSystem === 'plm'`, caller-selectable) `:363-394`: `pending` = **`status = 'pending'` with NO actor predicate** `:367-368`; `completed` = **`status <> 'pending'`, likewise none** `:383-384`; `cc` user-typed only `:372-382`; `mine`/`processed` actor-scoped | **NONE** on any branch | platform/external `pending` requires `is_active = TRUE` `:505`; `completed` omits it `:545-549` — asymmetric **within one construct**; the PLM branch consults `approval_assignments` at all only via `mine`/`processed`, i.e. not at all |
| C-4 | Pending / pending-count inline SQL | `packages/core-backend/src/routes/approvals.ts:1376`, `:1448`; params built at `:1477-1498` and `:1630-1642` | **feed filter** | active seat incl. `source_queue` | **NONE** | requires active seats |
| C-5 | `GET /api/approvals/:id` — **the absence** | `packages/core-backend/src/routes/approvals.ts:2559` -> `ApprovalBridgeService.getApproval` `:651-746` | **admission gate that does not exist** | none. `getApproval` returns the DTO for ANY instance id that loads (`:670-671`); the viewer identity is used only for field-level projection (`fieldAccess` `:687-696`) and `nodeOperations` (`:711-724`) | **NONE** | n/a |

**C-5 is the finding, stated plainly.** At this baseline any principal holding `approvals:read` reads any
approval instance in the database, cross-tenant, in full — title, `requester_snapshot`, `form_snapshot`,
assignments — because `rbacGuard('approvals', 'read')` (`:2559`) is the only gate and `getApproval`
applies none. That is what D-5 means by "permission-scoped, not participant-scoped". `#5024`
(`a0edbe39a4`, merged) brought `GET /api/approvals/:id/history` to **parity with that posture** — leg-1,
the permission leg — and its own body says so: "neither this route nor its sibling adds a per-instance
predicate on top of `rbacGuard`". This lock is leg-2.

### 1.1 Two facts that are load-bearing and were executed, not reasoned

**F-1 — the zero-attachment hole in C-1.** The org pin at `:219-222` is conjoined (`AND`) with the arm
union, so on an instance with **no `approval_attachments` row at all**, `EXISTS(...)` is false and
`isInstanceParticipant` returns **false for every viewer including the requester**. This is not a
hypothesis: it is an executed-probe fact, and it is the motivating case for OD-S1-10 and gate G-S1-1.
**Its provenance is now on main and no longer rests on this document's assertion**: the RATIFIED Lock-9
records it verbatim at `approval-lock9-handler-process-attachments-20260819.md:215-218` ("a probe executed
by the separate comments-reuse analysis (2026-08-21, NOT re-run at this head; provenance: that analysis,
not this document) reports that for an instance carrying zero attachment rows the same predicate returns
false for EVERYONE"), and the ratification-time scope clause on OD-L9-13 (`:635-640`) exists **because of**
that probe. The probe has not been re-run at this document's baseline; it is cited with the same scoping
Lock-9 gave it.
It is invisible today only because C-1's sole consumers are the attachment byte path
(`approval-attachment-storage.ts:275`) and the refs route (`routes/approval-attachments.ts:406`), which
are unreachable without an attachment row. **Any consumer that is not attachment-shaped inherits a
predicate that denies the requester their own instance.**

**F-2 — `source_queue` matches PERMISSION CODES, not user ids.** In C-3 and C-4 the arm is
`(assignment_type = 'source_queue' AND assignee_id = ANY($actorPermissions))`
(`ApprovalBridgeService.ts:417`, `:466`, `:508`, `:548`), where `actorPermissions` is
`resolveApprovalActorPermissions(req)` — `req.user.permissions` unioned with the token's `perms`
(`routes/approvals.ts:161-169`). The only writer of a `source_queue` row is `upsertPlmMirror`, which
writes the **literal string** `'plm:source-owned'` (`ApprovalBridgeService.ts:1177-1178`, update arm
`:1159`, `:1165`). So the arm reads: *"a principal whose permission set contains the string
`plm:source-owned` is a member of every PLM-mirrored instance."* Grepping the repository at this baseline,
`plm:source-owned` appears only in that writer, its tests, and the matcher — **this scan did not surface
any grant of that string to any principal**. Per `feedback_empty_read_is_not_absence` that is a statement
about the scan, not about the world: a source grep cannot see DB rows or token payloads in any deployment,
so the correct claim is "no grant path is visible in the repository at this baseline", NOT "it is granted
to no one" (review P3-4, closed — the unqualified form appeared here while §6's M11 discharge already
carried the qualified one, which is exactly the inconsistency M11 exists to catch). Per
`feedback_dead_code_defect_is_not_a_live_vulnerability`, that reachability finding is stated as a
reachability finding and **not** dressed up as a live vulnerability; it is nonetheless the reason
OD-S1-5 refuses the arm rather than inheriting it. Note also that the act path already refuses a `source_queue` seat outright. The **behavioural** anchors
for that are `ApprovalProductService.ts:3921-3934` (`assignmentMatchesActor`: `'user'` and `'role'` are
the only matching types, everything else falls through to `return false`) and
`approval-effective-node-operations.ts:132-155` (`seatNodeKeysForViewer`, the same three-way match).
`ApprovalBridgeService.ts:715-716` is a **comment** asserting that correspondence and is cited only as
such — a comment is not the mechanism (`feedback_source_text_assertions_are_not_behaviour`; review P3-1,
closed). Admitting the seat on read would therefore mint a read/act asymmetry with no ruling behind it.

---

## 2. The contract

### 2.0 Shape

**OD-S1-1 [R] — ONE predicate, one home, boolean out.**
`canReadApprovalInstance(db: Queryable, viewerId: string, instanceId: string): Promise<boolean>`, exported
from a module both `packages/core-backend/src/services/` consumers and the route layer import — the
existing `approval-attachment-runtime.ts` is the wrong home once the predicate stops being
attachment-scoped, so the function moves to a new `approval-instance-readability.ts` and
`approval-attachment-runtime.ts` becomes an importer, not the owner. Fail-closed: any thrown error from
any lookup denies, and the caller maps the denial to its surface's shape (OD-S1-11).

The signature carries **no roles and no org parameter** on purpose: both are derived inside the
predicate, from the DB, per **OD-S1-17** (§2.2a). A signature that accepted them would let each call site
choose its own notion of "the viewer's roles" — which is precisely how C-1, C-2 and C-3 came to disagree.

- *Rejected — (b) keep it in `approval-attachment-runtime.ts`*: the module name would then lie about the
  predicate's scope, and Lock-9's citation of it as an attachment predicate would keep reading true when
  it is not. Naming is part of the contract.
- *Rejected — (c) an Express middleware instead of a function*: two of the three consumers (the comments
  service, Lock-9's storage-auth layer) are not route-shaped, so a middleware would force a second call
  form and reopen D-4 by the back door.
- *Rejected — (d) return a rich reason enum instead of a boolean*: the reason is a values channel out of
  a denial path; Lock-7 OD-L7-7 (values-free audit) is the standing posture and a reason enum invites
  `403 {reason: 'cross_org'}`, which confirms existence. Callers that need to log get the boolean plus
  their own already-known context.

**OD-S1-2 [R] — the predicate is an ADMISSION GATE; feed filters are a different object.**
C-3/C-4 stay feed filters and are NOT replaced by S1. The binding rule between them is one-directional:
**a feed may be narrower than S1, never wider.** A row a tab shows to a viewer S1 would deny is a leak
laundered through a list. §3 G-S1-8 makes that a mechanical gate rather than a sentence, and §5.2
escalates the **three** places where a shipped feed is known to be wider today (§5.2 (i), (i-b),
(i-c)) — two of them pre-existing, and one created by this lock's own OD-S1-5.

- *Rejected — (b) rewrite the tabs as `S1 AND <tab predicate>`*: correct in the limit, but it changes five
  shipped queries' plans and result sets in the same slice that introduces the predicate, and a
  regression there is a silently-empty inbox. Sequenced as a follow-on slice with its own gate, not
  smuggled in.
- *Rejected — (c) leave the relationship unstated*: that is the status quo, and it is what let C-3 drift
  from C-1 without anyone noticing.

### 2.1 The arms

**OD-S1-3 [R] — Arm 1, REQUESTER: `i.requester_snapshot->>'id' = viewerId`.** Present in all five
constructs (C-1 `:223`, C-2 `:196`, C-3 `:512`). Unconditional, not status-scoped.

**OD-S1-4 [R] — Arm 2, ASSIGNMENT SEAT (user- or role-typed), `is_active`-INSENSITIVE.**
`approval_assignments` where `(assignment_type = 'user' AND assignee_id = viewerId) OR (assignment_type =
'role' AND assignee_id = ANY(viewerRoles))`, with **no `is_active` filter**. Read admission is
**monotonic**: once you have held a seat on an instance, you can read it forever. A transferred-away
approver keeps reading the instance they acted on; a completed instance stays readable by everyone who
was ever on it.

This is its own OD because "the `is_active` posture" is **two different columns**, and collapsing them is
the error to avoid:
- `approval_assignments.is_active` — C-3's `pending` tab requires TRUE (`:505`), C-3's `completed` tab
  omits it (`:545-549`), C-1 and C-2 both omit it. Ruled: **omitted** (monotonic membership).
- `users.is_active` — C-1's admin arm requires TRUE (`:238`); C-2's admin arm reads no DB row at all.
  Ruled: **retained, on the admin arm only** (OD-S1-8). A deactivated employee does not get an admin
  bypass; a deactivated employee who was a real approver still reads their own history, because arm 2
  does not consult `users` at all.

- *Rejected — (b) require `is_active = TRUE` on the seat*: it would deny an approver read access to the
  instance they approved the moment the seat is deactivated (which is what approving does), i.e. it
  breaks the completed-instance case by construction. C-3's `completed` tab already omits it for exactly
  this reason.
- *Rejected — (c) mirror C-3 exactly — active for pending instances, any for terminal ones*: it makes
  admission depend on instance status, so the same viewer's access flickers as the instance moves. Feed
  ordering may be status-sensitive; admission is not.

**OD-S1-5 [R] — Arm `source_queue`: EXCLUDED.** Per F-2. A `source_queue` "assignee id" is compared
against the caller's **permission codes**, so admitting it converts a permission check into a membership
claim; the act path already refuses the same seat (`ApprovalProductService.ts:3921-3934`,
`approval-effective-node-operations.ts:132-155`, per F-2); and the only value ever written is a constant
shared by every PLM-mirrored instance, so one grant would open every mirrored instance at once.

**Consequence, stated here rather than left to be discovered (review P1-1, closed).** `source_queue` is
not one arm among several on a PLM mirror — it is the **only** seat such an instance ever has.
`upsertPlmMirror` is the sole writer of `approval_assignments` rows for a `plm:` id and writes exactly one
shape (`'source_queue'`/`'plm:source-owned'`, `ApprovalBridgeService.ts:1176-1186`; update arm
`:1156-1170`), and **no** site in `packages/core-backend/src` ever `UPDATE`s `assignment_type` or
`assignee_id` (enumerated: every `UPDATE approval_assignments` site touches `is_active`, `node_key` or
`metadata` only). So on a PLM mirror the S1 arm set collapses: arm 2 is empty by construction, arm 4 is
empty (`cc` records are platform-side), arm 3 is empty **until the viewer has already acted**
(`ApprovalBridgeService.ts:870` writes the record), and arm 1 fires only if the PLM-side requester id
happens to equal a platform user id. Excluding `source_queue` while adopting S1 on the detail door would
therefore take a **pending** PLM approval away from the very approver who must read it — a removed read on
a shipped route, produced by this OD and not by any unresolved owner question. That is ruled in
**OD-S1-18** (§2.4a): PLM mirrors are scoped OUT of S1's consumers in v1. OD-S1-5 stands unchanged as the
predicate's arm list; what changes is that the predicate is not consulted for `plm:` ids at all.

- *Rejected — (b) admit it, scoped to `source_system = 'plm'`*: narrows the blast radius but keeps the
  category error, and leaves "holder of code X reads every PLM instance" true within that scope.
- *Rejected — (c) admit it and rename the column semantics*: a rename does not change who is admitted.

**OD-S1-6 [R] — Arm 3, PAST ACTOR: `EXISTS (SELECT 1 FROM approval_records r WHERE r.instance_id = i.id
AND r.actor_id = viewerId)`, INCLUDING `policy_denied` rows.** Present in C-1 `:231`, C-2 `:207-210`, C-3
`:534-536`, `:551-559`.

The `policy_denied` inclusion needs a mechanism argument, not a preference, because a naive reading makes
it a self-grant channel: if any principal could cause a `policy_denied` row to be written naming
themselves, they could mint their own membership. At this baseline they cannot, and the reason is
specific:
- the denial INSERT (`ApprovalProductService.ts:9209-9216`) sits **downstream of** the seat gate
  `APPROVAL_ASSIGNMENT_REQUIRED` (`:9091-9092`);
- that gate has exactly one exemption, `request.action !== 'revoke'` (`:9091`);
- and `revoke` maps to `null` in `ACTION_POLICY_KEYS`
  (`packages/core-backend/src/types/approval-product.ts:374-384`, `revoke: null` at `:378`), while the
  denial branch is entered only when `nodeOperationPolicyKey !== null`
  (`ApprovalProductService.ts:9190`). So the one verb that skips the seat gate can never reach the
  denial writer.

That is a **coupling between two tables that no test asserts**. Per `feedback_asserted_invariant_is_a_bug`
(an invariant asserted only in a comment and never executed is a hidden bug) and
`feedback_attack_your_own_criterion`, OD-S1-6 is admitted **only together with** gate G-S1-6, which
enumerates `ACTION_POLICY_KEYS` mechanically and fails if any verb both skips the seat gate and carries a
non-null policy key. If G-S1-6 cannot be written, arm 3 must exclude `policy_denied` and the slice takes
the (worse) behaviour of a refused member losing read access.

- *Rejected — (b) exclude `policy_denied` unconditionally*: a member whose click the server refused loses
  read access to the instance they are on — a denial that punishes the subject of a policy, and one the
  history route already goes out of its way to hide from the timeline (`approval-history.ts:90-100`)
  rather than from access.
- *Rejected — (c) include it with a comment explaining why it is safe*: that is precisely the pattern the
  house rule names as a hidden bug. The comment is fine; the comment **without G-S1-6** is not.

**OD-S1-7 [R] — Arm 4, CC TARGET (user- or role-typed).** `approval_records` where `action = 'cc'` and
`(metadata->>'targetType' = 'user' AND metadata->>'targetId' = viewerId) OR (metadata->>'targetType' =
'role' AND metadata->>'targetId' = ANY(viewerRoles))`. Present in C-1 `:232-237` and C-3 `:514-527`;
**absent from C-2**, which is a real (small) widening of the metrics route on migration, declared in
§2.10.

**OD-S1-8 [R] — Arm 5, ADMIN BYPASS: DB-backed only.**
`EXISTS (SELECT 1 FROM users u WHERE u.id = viewerId AND u.is_active = TRUE AND (u.is_admin = TRUE OR
u.role = 'admin'))` — C-1 `:238` verbatim. C-2's JWT-claims admin (`approval-metrics.ts:32-42`, including
`permissions.includes('*:*')`) is **rejected as the canonical form**, on the standing house rule that
production must not trust roles embedded in a token (`feedback_prod_token_via_login_not_minting`). On
migration this **narrows** the metrics route for any principal holding an admin claim in a token without
a matching `users` row; §2.10 declares that delta and G-S1-7 proves it in both directions.

- *Rejected — (b) union of DB admin and JWT admin*: a union only ever widens, and it preserves the exact
  token-trust channel the house rule forbids (`feedback_changing_the_convention_is_not_changing_the_invariant`
  — the test is "is the bad configuration now refused", not "would we still write it that way").
- *Rejected — (c) no admin arm at all (participants only)*: defensible, and strictly safer, but it breaks
  the shipped admin surfaces (`/jump` `:1887`, `/admin/reassign` `:1956`) whose operators must be able to
  read what they are about to act on. Offered to the owner as **OD-S1-8(d)** rather than taken
  unilaterally. (The draft numbered this decision `OD-S1-9(d)` in one place and `OD-S1-8(d)` in §4/§5.1 —
  one decision under two names in its own OD registry. `OD-S1-8(d)` is canonical; the other spelling is
  removed.)

### 2.2 The org anchor (D1 arm (i))

**OD-S1-9 [R] — `approval_instances.org_id`, NOT NULL, NO DATABASE DEFAULT, non-blank CHECK.**

At this baseline `approval_instances` has **no** `org_id` column: the create DDL is
`packages/core-backend/src/db/migrations/20250924105000_create_approval_tables.ts:9-15` and every later
`ALTER TABLE approval_instances ADD COLUMN` is enumerated in
`zzzz20260404100000_extend_approval_tables_for_bridge.ts:31-45`,
`zzzz20260411120100_approval_templates_and_instance_extensions.ts:106-111`, and
`zzzz20260703120000_add_node_entry_epoch.ts:26` — none adds one. `#5024`'s body records the same fact
independently.

**(a) Column shape.** `org_id text NOT NULL CONSTRAINT approval_instance_org_nonblank CHECK (org_id ~
'[!-~]')`, with **no `DEFAULT`**. The precedent to copy is `approval_attachments`
(`zzzz20260715210000_create_approval_attachments.ts:23-24`), which is exactly this shape. The
anti-precedent to refuse is the attendance family, which added `org_id text NOT NULL DEFAULT 'default'`
(`zzzz20260114100000_add_attendance_org_id.ts:5`, `:12`, `:27`, `:41`, `:55`;
`zzzz20260114120000_add_attendance_scheduling_tables.ts:16`, `:38`). The standing house rule is recorded
in the project ledger, verbatim: **「org_id 不设 DB 默认值 fail-closed（DEFAULT_ORG_ID='default' 兜底会静
默吞漏传写入，仅限旧数据迁移）」** — a default silently swallows a caller that forgot to pass an org and
stamps the row into the wrong tenant, where it then reads as legitimate membership. Migration ordering
follows the house `zzzz` rule (`feedback_migration_zzzz_ordering`): a new column on a `zzzz`-created table
must itself be `zzzz`.

**(b) Backfill source, ruled by row class.** The migration is three-phase — ADD nullable, BACKFILL, then
`SET NOT NULL` — because a single-phase NOT NULL cannot run against a populated table without a default,
and adding the default "just for the migration" is the exact hole (a) refuses.

**The classes are ORDERED, and the order is normative** (review P2-5, closed). They are not a menu of
independently-true predicates: an instance can match several, and picking the "wrong" source is not
cosmetic, because after OD-S1-10 the instance org pin is what governs **attachment downloads** on a
shipped route. The migration evaluates class 1 first, then 2, 3, 4, 5, and where the first matching class
disagrees with a later one it **FAILS LOUD** rather than choosing; specifically, a template-originated
instance whose attachments carry a different `org_id` is a migration abort, not a silent re-tenanting.
FAIL-LOUD is therefore a rule about **cross-class conflict**, not only about the attachment-vs-attachment
case the draft originally covered.

| # | Row class | Identifying predicate at baseline | Backfill source | Confidence |
|---|---|---|---|---|
| 1 | Template-originated | `template_id IS NOT NULL` (`zzzz20260411120100:106`, nullable FK `ON DELETE SET NULL`) | the template's owning org | derivable; **FAIL LOUD** if the instance also matches class 2 with a different `org_id` |
| 2 | Attachment-bearing | `EXISTS (SELECT 1 FROM approval_attachments att WHERE att.instance_id = i.id)` | `att.org_id` — already NOT NULL and non-blank there | derivable and self-consistent; if one instance carries attachments from two orgs the migration must **FAIL LOUD**, not pick one |
| 3 | Requester-resolvable | `requester_snapshot->>'id'` resolves to **exactly one** active org membership | the requester's org **at migration time**, not at creation time | **honest limit: this is not the creation-time fact.** A requester who changed org since submission backfills the instance into their *current* org, which can move a historical instance out of the tenant that ran it. **Additionally blocked by OD-S1-17(c)**: "exactly one org membership" is not a well-defined test for a multi-org user, and `zzzz20260114110000_create_user_orgs_table.ts:34-40` backfills EVERY active user into `'default'`, so multi-org rows are the expected shape in any deployment that later added an org. Class 3 is therefore unusable until OD-S1-17(c) is ruled — §5.1 lists it as blocking the migration, not only the predicate |
| 4 | After-sales bridge mirrors | `afs:`-prefixed ids; `template_id IS NULL`; rows written by `AfterSalesApprovalBridgeService` (`:515`) | class 1/2/3 in order, then the deploy's org for the after-sales channel | **separable from PLM and NOT excluded by OD-S1-18.** These rows carry real `'role'`-typed seats (`AfterSalesApprovalBridgeService.ts:568-572`), so they are S1-**admissible** by arm 2: they need an org source, not an arm. Splitting them out of the PLM class is review P2-5's fourth bullet, closed |
| 5 | PLM mirrors | `plm:`-prefixed ids; `COALESCE(source_system,'platform') <> 'platform'`; rows written by `upsertPlmMirror` (`ApprovalBridgeService.ts:1106-1195`) | **NONE EXISTS.** The mirror writer stamps no org and derives none; `plm:`-prefixed ids carry no tenant | **not derivable — ruled by OD-S1-9(c-iii) + OD-S1-18** |
| 6 | **TERMINAL — no source at all** | platform (`COALESCE(source_system,'platform') = 'platform'`) **and** `template_id IS NULL` **and** zero attachments **and** requester not resolving to exactly one active org | **NONE.** Ruled: the migration **ABORTS** and reports the offending ids; it does not invent an org and does not leave the row NULL | This class is stated as a **structural hole in the class table**, not as an asserted population: no probe was run to establish that such rows exist in any deployment (`feedback_empty_read_is_not_absence`). It is enumerated because `SET NOT NULL` has no source for it and the (c) escalation covers only the *non-platform* predicate, so without an explicit terminal arm the migration's behaviour here is undefined (review P2-5, closed) |

**(c) [R] — RULED (c-iii); (c-i) and (c-ii) are recorded as REJECTED, and why.** This was drafted as an
open owner decision. The independent review established that two of the three arms are outages rather
than trade-offs, so presenting them as a menu would have asked the owner to choose blind
(`feedback_misclassified_gap_called_a_ceiling`). The arm set, with its true consequences:
  - *Rejected — (c-i)* a single named platform org for all bridge rows. It supplies an **org** and no
    **arm**. Per the F-2/OD-S1-5 collapse above, a PLM mirror has no admissible seat at all, so a
    correctly-tenanted PLM instance is still `false` for its pending approver. This arm does not avoid the
    outage; it hides it behind a green org-pin test.
  - *Rejected — (c-ii)* `org_id` stays NULLABLE for bridge rows, enforced by
    `CHECK (org_id IS NOT NULL OR COALESCE(source_system,'platform') <> 'platform')`, with the predicate
    treating NULL per (e). It supplies **neither** org nor arm, and it is **internally unsatisfiable for
    exactly the population G-S1-4 names** (review P2-1, closed): (e) rules NULL ⇒ `false` for everyone
    including admins; nothing derives an org for a `plm:` mirror; so under the only arm that makes G-S1-3
    reachable, G-S1-4 can never be green. The draft named that hazard in prose — "a NULL-org fails-closed
    test **passes** in exactly the world where every PLM instance has become unreadable" — and then
    offered that world as a live option.
  - **(c-iii) [R] — RULED.** PLM mirror instances are scoped OUT of S1's consumers in v1: see
    **OD-S1-18** (§2.4a) for the full ruling, including the column posture, which is the part
    "exclude from the consumers" does **not** by itself settle.

  Note what (c-iii) does *not* cover: after-sales (`afs:`) bridge rows. They are class 4 above, they carry
  real role-typed seats, and they are **in** S1. (c) is a ruling about PLM, not about "bridge rows" as a
  category.

**(d)** *(vacated — this decision is canonically `OD-S1-8(d)`; see §2.1 and §5.1. The label is retired
here rather than left as a second name for one decision.)*

**(e) [R] — the predicate's NULL-org posture: FAIL CLOSED.** If `i.org_id IS NULL` the predicate returns
false for everyone, admin included. Stated alone this is uncontroversial; stated together with (b) it was
a **shipping hazard**, because the obvious acceptance gate hides it: a "NULL-org fails closed" test
**passes** in exactly the world where every PLM instance has become unreadable by every legitimate
approver. Under the ruled (c-iii) that world is closed off from two directions and both must hold:
  - PLM rows reach `SET NOT NULL` under OD-S1-18(b) rather than being left NULL, so (e) has no
    PLM population to deny; and
  - the predicate is not consulted for `plm:` ids at all, so even a NULL that somehow survived could not
    produce the outage on the PLM read path.

  (e) therefore governs only the genuinely-anomalous row — one whose org was lost, not one whose org was
  never derivable. Per `feedback_positive_control_not_failclosed` and
  `feedback_verified_one_link_generalised_to_the_chain`, G-S1-3 is still admitted **only paired with**
  G-S1-4, but G-S1-4 is now the *bypass* gate (S1 is not consulted for `plm:` ids) rather than a claim
  that a PLM approver passes S1 — see §3.

**(f) [R] — the caller does not supply the org.** The predicate takes `(db, viewerId, instanceId)` and
derives both sides server-side: the instance's org from the row, the viewer's per **OD-S1-17(b)**
(§2.2a — from `user_orgs`, with `req.authenticatedTenantId` as the only authoritative request-scoped
field). A body- or query-supplied `org_id` is a cross-tenant forgery — the same rule the attachment
routes already enforce (`routes/approval-attachments.ts:43-48`, cited by Lock-9 at its `:186-187`).

**OD-S1-10 [R] — the attachment-EXISTS org pin is REMOVED and REPLACED by the instance org pin.**
`approval-attachment-runtime.ts:219-222` disappears; the org comparison becomes `i.org_id = <viewer's
org>` on the instance row itself. This is the fix for F-1: a zero-attachment instance becomes readable by
its own requester. Two consequences must be stated rather than discovered:
- The current pin's *deliberate* property — that it counts **deleted/tombstoned** attachment rows so a
  pure-tombstone instance yields the authorized `410` rather than an outsider's `404` (the comment at
  `:210-215` says exactly this) — is **preserved for free**, because an instance-level pin does not look
  at attachments at all and therefore cannot be defeated by their status.
- The predicate **widens** for zero-attachment instances (from "nobody" to "the participant union"). For
  C-1's two shipped consumers this widening is unobservable: both require an attachment row to reach the
  check (`approval-attachment-storage.ts:275`, `routes/approval-attachments.ts:406`). G-S1-1 proves the
  widening at the predicate level and G-S1-2 proves the non-observability at the route level.

### 2.2a Derived inputs — where "the viewer's roles" and "the viewer's org" come from

**OD-S1-17 [R] — both derived inputs are resolved SERVER-SIDE FROM THE DATABASE, from the same sources
OD-S1-8 already committed to; neither is taken from a token claim or a header.**

OD-S1-1 fixes the signature at `(db, viewerId, instanceId)`, but OD-S1-4 and OD-S1-7 both match against
the viewer's **roles**, and OD-S1-9(f) says the viewer's **org** is derived from their session principal.
Leaving those two derivations unstated would not be a gap in detail — it would silently reopen, inside
the predicate, the exact token-trust channel OD-S1-8(b) rejects, because the three constructs this lock
unifies already disagree about both.

**(a) Roles — DB-backed.** The canonical derivation is the one C-1 already uses:
`viewerRoles` (`approval-attachment-runtime.ts:177-191`) — `users.role` for an **active** user (`:179`,
`WHERE id = $1 AND is_active = TRUE`) unioned with `user_roles` joined to `roles`, contributing both
`role_id` and `name` (`:181-188`). Rejected: C-2's JWT roles (`approval-metrics.ts:187-192`) and C-3's
`resolveApprovalActorRoles(req)` (`routes/approvals.ts:151-159`, `req.user.role` + `req.user.roles`),
both of which trust claims carried in the token. Taking either would produce a predicate whose admin arm
reads the DB (OD-S1-8) while its role arm reads the token — one function, two trust models, and the
weaker one wins because the arms are OR-ed.

Note the asymmetry inside C-1's own helper, kept deliberately: `users.is_active = TRUE` gates only the
`users.role` column, not the `user_roles` rows. This lock does not change that; it is recorded so a later
reader does not "fix" it as an oversight.

**(b) Org — DB-backed, from `user_orgs`; the authoritative request-scoped field is
`req.authenticatedTenantId`, never `req.user.tenantId`.** These are two different fields with two
different trust levels, and the distinction is the whole ruling. `req.authenticatedTenantId`
(`packages/core-backend/src/auth/jwt-middleware.ts:101-104`) is set **only** from a value the verified
token itself carries. `req.user.tenantId` is a **separate field with a weaker provenance**, maintained a few lines below it —
the two are not interchangeable, and a surface that reads the second one is not reading the authenticated
tenant. **How the weaker field can come to hold a value is deliberately not characterized here**: the
draft published that mechanism and then claimed to withhold the reachability analysis, which is
self-defeating (review P3-5, closed). The mechanism, the deployments and the token vintages that reach it
are all held in the private line inventory (`feedback_no_public_vuln_disclosure_on_prs`); what this
document publishes is the ruling, which is all the implementer needs. The same distinction was already settled once on another line, where
the authoritative org field was locked to `req.authenticatedTenantId` with a `403 ORG_CONTEXT_REQUIRED`
on absence; this lock takes the same posture rather than re-deriving it.

The currently-shipped approval org resolver (`approval-attachment-runtime.ts:470-475`) reads
`req.user.tenantId` and, when it is empty, returns the literal `'default'`. Both halves are refused here:
the field for the reason above, and the fallback because it is the DEFAULT_ORG_ID hole of OD-S1-9(a)
reappearing one layer up — refusing a DB default while a resolver silently substitutes the same literal
buys nothing (`feedback_failclosed_doors_cover_for_each_other`: door-level exclusivity is not word-level
exclusivity). **Per the disclosure doctrine, the reachability analysis of the shipped resolver — which
deployments and token vintages can reach which arm — is held in the private line inventory and is
deliberately not written out here** (`feedback_no_public_vuln_disclosure_on_prs`); this document records
only the design ruling it produces, which is what the implementer needs.

Ruled, therefore: the org in play is resolved server-side from `user_orgs`
(`zzzz20260114110000_create_user_orgs_table.ts`); a viewer with **no active `user_orgs` row** is denied,
never defaulted; where a request-scoped org is needed, the field is `req.authenticatedTenantId` and its
absence is a refusal, not a fallback.

**(c) OWNER DECISION REQUIRED — multi-org viewers.** `user_orgs` has PRIMARY KEY `(user_id, org_id)`
(`zzzz20260114110000:20-27`), so one user may hold rows in several orgs and "the viewer's org" has no
single answer. Until this is ruled, G-S1-10 (cross-org denial) is either sound or vacuous depending on a
choice this document has not made — which is why it is a §5.1 blocking row and not a paragraph of
caveats. Arms: **(c-i)** the predicate admits if the instance's org is in ANY of the viewer's active
orgs (union semantics — simplest, and weakest); **(c-ii)** the request carries an explicit active-org
context resolved from `req.authenticatedTenantId`, and a viewer with no membership in THAT org is denied
even if they are a member elsewhere (exact-org semantics — the posture the attendance line settled on
after a wildcard finding); **(c-iii)** single-org deployments only in v1, with a startup assert that
refuses to boot the consumers if any user holds more than one active `user_orgs` row.

- *Rejected — (d) leave the derivations to the implementing slice*: the implementer would reach for the
  nearest existing helper, and the two nearest are the JWT ones. "We would not write it that way" is not
  the test; `feedback_changing_the_convention_is_not_changing_the_invariant` — the test is whether the
  wrong wiring is now refused.

### 2.3 Denial shape

**OD-S1-11 [R] — each consumer keeps its OWN denial shape; S1 does not impose one.** The three shipped
shapes are each defensible in context, and unifying them would be a second contract change riding an
authorization slice:
- attachment byte path: **values-free 404** (`authorizeAttachmentDownload`, the existing posture);
- metrics instance route: **403 `FORBIDDEN`** (`approval-metrics.ts:214`);
- `#5024`'s history guard: rbacGuard's **403**.

Ruled: **`GET /api/approvals/:id` and `GET /api/approvals/:id/history` deny with `404
APPROVAL_NOT_FOUND`**, matching the shape the detail route already returns for a non-existent id
(`routes/approvals.ts:2573-2575`). Rationale: a 403 on detail *confirms the instance exists* to a
cross-org caller, which is an existence oracle over another tenant's request numbers; the detail route
already has a values-free 404 in hand, so this costs nothing and leaks nothing. The metrics route keeps
its 403 — the divergence is declared in §2.10 rather than silently normalized.

- *Rejected — (b) 403 everywhere*: creates the cross-tenant existence oracle above.
- *Rejected — (c) 404 everywhere including metrics*: changes a shipped error contract on a surface this
  slice has no other reason to touch; `feedback_tests_freeze_change_not_approve_it` — when a public
  contract is in play, the default is to keep the contract.

**OD-S1-12 [R] — adopting S1 on `GET /api/approvals/:id` is a CONTRACT NARROWING and is ratify-first.
It applies to PLATFORM ids only.** Per OD-S1-18, `plm:` ids do not adopt S1 in v1, so their detail
posture is unchanged by this lock and the narrowing below does not describe them; that scoping is stated
here, at the OD, and not only in §2.10, because an implementer reading this OD alone would otherwise apply
it to every id shape. Today a non-participant holding `approvals:read` gets `200` with the full instance.
After adoption they get `404` — **on a platform id**. That is a behaviour change for existing clients, so per
`feedback_tests_freeze_change_not_approve_it` the question is "does an existing client break today", and
the answer is yes for any integration that lists under one identity and fetches detail under another, or
any admin tool relying on the permission-only posture. This must be ratified explicitly in §4 and must
NOT be inferred from 「按建议执行」, which was answered to a list that did not contain it.

### 2.4 The three consumers

**OD-S1-13 [R] — Consumer (b), the detail/history PAIR, adopts S1 in the SAME slice.**
`GET /api/approvals/:id` (`routes/approvals.ts:2559`) and `GET /api/approvals/:id/history`
(`routes/approval-history.ts:50`) adopt S1 together, as leg-2 on top of `#5024`'s leg-1 rbacGuard. This
is not tidiness. The frontend calls both **concurrently under one identity**:
`apps/web/src/views/approval/ApprovalDetailView.vue:1926`, `:2008` **and `:2359`** all run
`Promise.all([store.loadDetail(id), store.loadHistory(id)])` — three sites, not two, and the store writes both failures into one
shared `error` ref (`apps/web/src/approvals/store.ts:125-147`). Adopting S1 on one door only produces a
**detail-200 / history-403 split**: the page renders a fully populated instance with an error banner over
it, or the mirror image. `#5024`'s own body flagged this as the reason it did not attempt the predicate:
"A per-instance scope would need a paired change to both endpoints (the frontend's
`ApprovalDetailView.vue` loads detail + history together, under one identity)". G-S1-5 is the pairing
gate.

`#5024` also recorded a second pairing hazard this lock must not inherit: `getApprovalHistory` skips the
`refreshPlmInstance` step that `getApproval` performs on the PLM branch
(`ApprovalBridgeService.ts:659-668`), "so a mirror-keyed predicate would deny a legitimate PLM approver on
one door and not the other."

**The draft's answer to that — "OD-S1-9's org anchor is instance-keyed, not mirror-keyed, which avoids
that specific trap" — is WITHDRAWN as unfounded** (review P1-2, closed). For a `plm:` id the
`approval_instances` row **is** the mirror, and it is materialized by the detail door alone:
`routes/approvals.ts:2559` -> `getApproval` -> `if (isPlmId(id)) await this.refreshPlmInstance(id)`
(`ApprovalBridgeService.ts:658-667`) -> `upsertPlmMirror` (`:1197-1215` -> `:1118`, the INSERT into
`approval_instances`), while the history door's PLM branch (`routes/approval-history.ts:52-76`) goes
straight to the adapter (`new ApprovalBridgeService(plmAdapter).getApprovalHistory(id)`) and **never
touches `approval_instances`**. An instance-keyed predicate evaluated on both doors therefore reads a row
that one door creates and the other does not: on a never-refreshed mirror, history denies while detail
admits after its own refresh — reproducing exactly the detail-200/history-404 split #5024 warned about.
"Instance-keyed" is not a defence when the instance row is the mirror.

This is the **same root as review P1-1 and takes the same remedy**: `plm:` mirrors are structurally
unlike platform instances (no user/role seat; their row materialized by one door only), and OD-S1-18
scopes them out of S1 in v1, which discharges both findings and P2-1 with one ruling instead of three
patches. G-S1-5 is amended to pin the never-refreshed-mirror case rather than to assume a fixture where
the mirror already exists.

**OD-S1-14 [R] — Consumer (a), comments (D2(b1)/D3/D5), reads S1 for BOTH read and write.**
Per the owner-authorized D3, comment WRITE widens from acting-assignee-only to the participant union —
and "the participant union" is **defined by S1 and by nothing else**. A comments surface that
re-implements the union inline would mint the fourth predicate D-4 forbids, in the very slice that closes
D-5. Concretely: `canReadApprovalInstance` gates comment list/read, and the same predicate gates comment
create. Deletion tombstones (D2(b1)) are readable under the same gate — a tombstone is comment data.

- *Rejected — (b) a separate `canWriteApprovalComment` with its own arms*: D3 says "widen to the
  participant union", i.e. the union, not a cousin of it. If a future ruling wants write to be narrower
  than read, it must be expressed as `S1 AND <extra>` so the union stays single-sourced.

**OD-S1-15 [R] — @-mention candidacy and mention NOTIFICATION are BOTH participant-scoped, and the
notification seam defaults FAIL-CLOSED.** D5 already rules candidacy (the picker offers participants, not
the org). This OD adds the half D5's wording does not reach: the notification seam. The precedent is
`CommentService.canNotifyUserAboutCommentTarget`
(`packages/core-backend/src/services/CommentService.ts:1107-1114`), which correctly denies on a thrown
checker — but whose backing seam is initialized **open**:
`private commentTargetReadChecker: CommentTargetReadChecker = async () => true`
(`CommentService.ts:186`). Production wires a real checker (`packages/core-backend/src/index.ts:3426`),
so this is a latent seam and not a live hole — but any bootstrap path that constructs the service without
calling `setCommentTargetReadChecker` (`:188-190`) notifies everyone. **The approval equivalent must
initialize to `async () => false`**, so an unwired seam notifies nobody instead of everybody, and the
failure mode is a missing notification rather than a leaked instance title. That multitable default is
cited here explicitly as the anti-pattern; G-S1-9 is its gate.

**OD-S1-16 [R] — Consumer (c), Lock-9: S1 REPLACES `isInstanceParticipant`; Lock-9 mints nothing.**
See §2.11.

#### 2.4a PLM mirrors are scoped OUT of S1 in v1

**OD-S1-18 [R] — S1 is NOT consulted for `plm:`-prefixed ids in v1; their read posture is unchanged by
this lock.** This is the single ruling that discharges review findings P1-1, P1-2 and P2-1, and it is
stated as its own OD because "OD-S1-9(c-iii)" alone reads as a migration choice when it is in fact a
scope boundary on every consumer.

**(a) Consumers.** `GET /api/approvals/:id` and `GET /api/approvals/:id/history` keep their current
posture for `plm:` ids — `authenticate` + `rbacGuard('approvals','read')` and nothing more. The comments
consumer (OD-S1-14) is **not** enabled for `plm:` ids in v1; there is no participant union to widen a
comment write to. Lock-9's attachment surfaces are unaffected: an attachment-bearing instance reaches the
predicate through class 1/2/3 of §2.2(b) regardless of id shape, and PLM mirrors do not carry process
attachments in v1.

**(b) Column posture — the part "exclude from the consumers" does NOT settle.** Excluding `plm:` ids from
S1's *consumers* is not the same as excluding them from the *migration*: the column still has to reach
`NOT NULL`, and PLM mirrors still have no org source. Ruled: `org_id` is **NULLABLE for `plm:` rows
only**, enforced by `CHECK (org_id IS NOT NULL OR id LIKE 'plm:%')` — the id-shape form, not the
`source_system` form of the rejected (c-ii), because after-sales rows are also non-platform and they
**do** get an org (class 4). **The CHECK's predicate was matched against the runtime's own id test, not
assumed**: the three shipped detectors are `routes/approvals.ts:94-96`, `routes/approval-history.ts:18-20`
and `ApprovalBridgeService.ts:113-115`, and all three are exactly `id.startsWith('plm:')`. That agreement
is load-bearing — a row that the CHECK treats as PLM (NULL org permitted) but a detector does not would be
routed through S1 with a NULL org and denied by (e), which is the outage OD-S1-18 exists to prevent. It is
also **fragile**: the test is hand-copied into three separate private functions, so the implementing slice
must either consolidate them or gate the agreement, and the divergence of any one of them is a P1. OD-S1-9(e)'s fail-closed NULL posture is then unreachable on the PLM path by
construction, because the predicate is never consulted there; that is the one sentence a reader needs so
they do not reconstruct P2-1 against this ruling.

**(c) The residual this creates, declared not buried.** The C-5 hole of §1 — a non-participant holding
`approvals:read` reads any instance — **stays open for `plm:` ids** after this lock's slices land.
That is a deliberate, named non-closure, recorded in §5.2 (iii). It is strictly the status quo (this lock
removes nothing and adds nothing there), but M8 forbids describing approval detail reads as
participant-scoped while a whole id class is permission-scoped, so no copy anywhere may say "approval
instance reads are participant-scoped" without the PLM qualifier.

**(d) What would close it.** A real membership fact on the mirror — `upsertPlmMirror` writing a
user- or role-typed seat resolved from the PLM source's approver identity, plus an org — is the exit, and
it is a bridge-side change with its own lock, not something S1 may mint. It is **not** authorized here.

- *Rejected — (e) admit the `source_queue` seat for `source_system = 'plm'` only*: this is OD-S1-5's
  rejected arm (b) reappearing as a scoping trick. It keeps the category error (a permission code read as
  a membership claim) and leaves "holder of code X reads every PLM instance" true within the scope.
- *Rejected — (f) adopt S1 on PLM anyway and accept the outage as a declared behaviour delta*: a removed
  read on a live route is not a declarable delta at design time; `feedback_tests_freeze_change_not_approve_it`
  makes the criterion "does an existing client break today", and here a human approver does.

## 2.10 Migration table — every construct, and its declared behaviour delta

| Construct | Action | Behaviour delta on migration | Gate |
|---|---|---|---|
| C-1 `isInstanceParticipant` | **replaced by** `canReadApprovalInstance`; call sites `approval-attachment-storage.ts:275` and `routes/approval-attachments.ts:406` re-point; the `orgId` parameter leaves the signature (the predicate derives it) | widens on zero-attachment instances (F-1 fixed); unobservable at the two shipped routes | G-S1-1, G-S1-2 |
| C-2 metrics ACL | **replaced**; the inline SQL at `approval-metrics.ts:193-215` deleted, and `isAdminActor` (`:32-42`) **deleted outright** — it is called from exactly one site, `:175`, verified by grep at the baseline | **widens** by the CC arm (OD-S1-7, absent from C-2) — **a grant of new read access on a shipped ACL, escalated to §5.1 for owner confirmation** (review P2-3, closed-by-promotion; the review's stated rationale is rebutted there, the escalation is granted anyway); **narrows** three ways — the DB-backed admin arm (OD-S1-8), **DB-backed roles (OD-S1-17(a)): a JWT-only role claim with no `user_roles`/`users.role` row stops matching a role-typed seat**, and the org pin (C-2 has none) | G-S1-7 |
| C-3 `listApprovals` tabs | **kept as a feed filter**; not rewritten in this slice | none | G-S1-8 (subset direction only) |
| C-4 pending / pending-count | **kept as a feed filter** | none | G-S1-8 |
| C-5 `GET /api/approvals/:id` — **platform ids** | **gains** S1 (it had nothing) | **narrows**: non-participant `approvals:read` holders go 200 -> 404 | OD-S1-12, G-S1-5 |
| `GET /api/approvals/:id/history` — **platform ids** | **gains** S1 as leg-2 | same narrowing, in lockstep with C-5 | G-S1-5 |
| Both doors — **`plm:` ids** | **unchanged**: S1 is not consulted (OD-S1-18) | **none.** The C-5 permission-only posture persists for this id class, declared as residual §5.2 (iii) | G-S1-4 (now a *bypass* gate — S1 is not consulted), plus G-S1-5's never-refreshed-mirror case |

Routes deliberately **out of scope**, derived by enumerating the `/api/approvals/:id*` family at the
baseline rather than asserted: `POST /:id/mark-read` (`:1543`), `POST /:id/remind` (`:1697`),
`POST /:id/jump` (`:1887`, `approvals:admin`), `POST /:id/actions` (`:2101`), `POST /:id/approve`
(`:2252`), `POST /:id/reject` (`:2402`). The last four are **act/write** surfaces already gated by the
act-side seat check (`ApprovalProductService.ts:9091-9092`), which is Lock-7's authorization and is not
touched here. `POST /:id/mark-read` and `POST /:id/remind` carry `rbacGuard('approvals','read')` and are
write-shaped reads; they are listed as **a known residual, NOT as cleared** — a reminder is a
notification channel into an instance's participants, and a non-participant can currently trigger one.
Escalated in §5.2 (ii).

### 2.11 Lock-9 interaction (PR #5011 — MERGED `f01045f2e9`, RATIFIED 2026-08-21)

**Correction, recorded rather than silently applied (review P1-3, closed).** This section was drafted
against a state in which Lock-9 was OPEN and could still be edited before merge. That state expired
before this document was ratified: #5011 merged as `f01045f2e9` and the landed header reads "Status:
RATIFIED 2026-08-21". Three of the draft's sentences ("OPEN (PR #5011, not on main)", "authorized, not
yet executed", "Lock-9 is described as OPEN, not ratified") were false against current main, and the last
of them was offered *as evidence of scoping discipline* — the failure mode
`feedback_verify_against_current_main_not_stale_base` names, made worse by being cited as a credit.

More importantly the **classification** was wrong, not just the status. What Lock-9 carries is not a
rationale sentence but **ratified normative text**:
- **OD-L9-13(a)**, RATIFIED AS AMENDED (`:501-503`, `:631-640`): "reuse `isInstanceParticipant`
  **UNCHANGED** — no fourth participant predicate is minted (Lock-7 §L7-A / D-4) — its org-pin EXISTS
  clause being self-satisfied by the bound process row itself";
- ratified gate **G-4** (`:398`): "Participant predicate reused **unchanged**", whose negative is
  "mutating `isInstanceParticipant` reds the process-download test too".

OD-S1-10 deletes the org pin those rest on, and OD-S1-16 deletes the function G-4 names. That is an
**amendment of a ratified lock**, not a propagation edit — and per
`feedback_implementation_is_not_the_ratified_contract` and
`feedback_second_narrower_artifact_is_contract_narrowing` it is owner-level. It moves to **§5.1 as a
blocking decision** and is deliberately NOT executed by this document: nothing in Lock-9 is edited here.

Rulings:
1. **S1 replaces, it does not add.** After OD-S1-10, `isInstanceParticipant` no longer exists as a
   separate function; Lock-9's consumers call `canReadApprovalInstance`. Lock-9's D-4 citation continues
   to resolve — there is still exactly one admission predicate — but it resolves to a different function.
   This is the difference between closing D-4 and quietly reopening it. **It is nonetheless a change to
   what OD-L9-13(a) ratified**, because "UNCHANGED" is the operative word of that arm, so ruling (1)
   binds only once §5.1's Lock-9 amendment row is answered.
2. **The affected Lock-9 text, enumerated so the amendment can be scoped**: OD-L9-13(a)'s "UNCHANGED" and
   its org-pin self-satisfaction clause; the matching §L9-C bullet (`:213-220`); and gate G-4 (`:398`),
   whose named mutation target ceases to exist. The *conclusions* survive and get stronger — an
   instance-level org pin cannot be defeated by attachment binding state at all, and Lock-9's own
   ratification-time scope clause (which confines arm (a) to attachment surfaces **because** of the
   zero-attachment probe, F-1) is exactly what S1 generalizes. But a conclusion surviving is not the same
   as normative text staying true, and only the owner may amend the latter.
3. **Sequencing — collapsed to the resolved branch.** Lock-9 landed first. Therefore: this lock's §2.10
   C-1 row must gain Lock-9's process-attachment call sites when that slice implements, and Lock-9's L9-C
   text is amended by an owner-authorized follow-up, not by this document's ratification. The draft's
   "whichever ratifies first" fork is moot and is removed rather than left as a live-looking alternative.

---

## 3. Acceptance gates

Every gate below carries a positive control and a discriminating negative, per
`feedback_positive_control_not_failclosed` and `feedback_gate_the_mechanism_not_the_claim`.
"Discriminating" means the negative must fail for **this** reason — a `notEqual`-family assertion that
merely proves "not that error" is explicitly insufficient
(`feedback_not_this_error_is_not_an_outcome_assertion`), so every negative asserts a positive equality on
the observed outcome.

| # | Gate | Positive control | Discriminating negative |
|---|---|---|---|
| G-S1-1 | **Zero-attachment instance is readable by its requester** — the exact case C-1 fails (F-1). Real DB, an instance with **no** `approval_attachments` row | `canReadApprovalInstance(db, requesterId, instanceId)` === `true` | a same-org non-participant on the SAME instance === `false`. **Mutation target**: re-introduce the `EXISTS (... att.org_id = $4)` conjunct (`approval-attachment-runtime.ts:219-222`) into the new predicate and confirm **this gate reds**. The draft's diagnostic ("this gate, and ONLY this gate, reds — if other gates also red the fixture is not isolating F-1") is **withdrawn as wrong and actively harmful** (review P3-3, closed): that conjunct reds the positive control of EVERY gate whose fixture instance carries no attachment row (G-S1-3, G-S1-10, G-S1-11 as specified), so the draft's rule would have pushed the implementer to weaken those fixtures until the mutation looked isolated. The correct diagnostic: this gate MUST red, and any other gate that reds must be shown to red **because its fixture instance has zero attachments** — that is the mutation working, not a fixture defect. If this gate does NOT red, the gate has no teeth |
| G-S1-2 | **The C-1 widening is unobservable at the shipped attachment routes** | download + refs still 200 for a participant on an attachment-bearing instance | the same routes still deny a non-participant with the SAME status code and the SAME error envelope as before the change, asserted by equality on both |
| G-S1-3 | **NULL-org fails closed** — **re-scoped at ratification**: the draft made this gate "reachable only under OD-S1-9(c-ii)", and (c-ii) is now REJECTED (§2.2(c)). Under the ruled (c-iii) the only NULL-org populations are (a) `plm:` rows permitted by OD-S1-18(b)'s CHECK, which the predicate is never consulted for, and (b) a genuinely anomalous row whose org was lost. The gate covers (b), and it must be paired with G-S1-4 proving (a) is a bypass, not a denial | an instance with `org_id` set is readable by its requester | the same instance with `org_id` NULL is `false` for requester, seat-holder, past actor, CC target, **and DB admin** — all five asserted, not one |
| G-S1-4 | **REFRAMED (review P1-1, closed) — a PLM-mirrored instance is NOT subjected to S1, and its shipped read survives.** The draft specified the positive control as "a `plm:`-prefixed instance with a real user-typed seat". That row shape **no production path produces**: `upsertPlmMirror` writes only a `source_queue` seat and no site ever updates `assignment_type`/`assignee_id`, so the gate would have hand-INSERTed a seat that cannot exist, gone green, and shipped an outage (`feedback_fixture_shape_must_match_named_scenario`). The gate now proves the OD-S1-18 bypass instead of a passage through S1 | a `plm:` instance in the state `upsertPlmMirror` **actually produces** (sole seat `('source_queue','plm:source-owned')`, `org_id` NULL under OD-S1-18(b)): its legitimate approver gets **200 on `GET /api/approvals/:id` AND 200 on `/history`**, asserted as an equality on status — i.e. byte-for-byte the pre-slice posture | **two negatives.** (i) `canReadApprovalInstance` is **never invoked** for that id — asserted by a spy/counter equal to **zero** on the predicate, not by "no error thrown", so a future refactor that starts routing `plm:` ids through S1 reds this gate rather than silently bricking PLM. (ii) a principal holding `plm:source-owned` **as a permission code** and nothing else === `false` **on a platform instance** (proves OD-S1-5's exclusion is load-bearing, per F-2). Mutation: route `plm:` ids through S1 -> (i) reds AND the positive control flips to 404 |
| G-S1-5 | **Detail/history pairing** — for one identity and one instance the two routes return the SAME admission outcome. **Extended (review P1-2, closed) to pin mirror-materialization order**, which the draft's "instance-keyed, not mirror-keyed" claim assumed away | (i) platform instance, participant: detail 200 **and** history 200. (ii) **never-refreshed `plm:` mirror** — the id is called on `/history` FIRST, with no prior detail call in the fixture, so `upsertPlmMirror` has never run for it: both doors behave as they do today (OD-S1-18), asserted by equality on both statuses. The fixture must NOT pre-create the `approval_instances` row, because that is the state the trap needs | non-participant on a platform instance: detail 404 **and** history 404, asserted **as a pair inside one test** so a one-sided adoption cannot pass. Mutations: (a) remove S1 from `approval-history.ts` only -> this gate reds while every single-route gate stays green; (b) route `plm:` ids through S1 -> case (ii) reds with a detail/history split, which is the #5024 hazard reproduced |
| G-S1-6 | **`policy_denied` cannot be self-minted** (the OD-S1-6 coupling). Mechanical, not a spot check: iterate the exported `ACTION_POLICY_KEYS` (`types/approval-product.ts:374-384`) and assert that every key with a **non-null** policy value is subject to the `APPROVAL_ASSIGNMENT_REQUIRED` gate | a seat-holder refused by node policy writes a `policy_denied` row and still reads the instance | a non-participant attempting each seat-gate-exempt verb writes **no** `approval_records` row (asserted by row count on that instance before and after) and remains `false`. Mutation: flip `ACTION_POLICY_KEYS.revoke` to a non-null key -> the enumeration must red. **Fixture precondition, without which that mutation is silently ineffective** (review P3-2, closed): the denial INSERT is reached only when `isOperationAllowedAtNode` returns false, and the widen-only semantics make ABSENT ≡ ALLOWED (`ApprovalProductService.ts:9196-9203`), so the fixture's node policy MUST pin an **explicit `false`** for the mutated key. A fixture that merely omits the key makes the mutated build pass and the gate reads green while proving nothing (`feedback_ineffective_mutation_looks_like_a_useless_test`) |
| G-S1-7 | **Metrics migration deltas, all four directions** — one gate, because they are one substitution | a CC-only viewer, previously denied by C-2, now reads instance metrics (the declared widening) | **three negatives, each paired with its own positive so the test discriminates the DB read from the claim rather than merely failing**: (i) a principal with `role: 'admin'` **in the JWT only** and no matching `users` row is **denied**, while the SAME principal WITH the `users` row is allowed; (ii) a principal whose **role claim exists only in the JWT** and who holds a role-typed seat by that name is **denied** (OD-S1-17(a)), while the same principal with the matching `user_roles` row is allowed; (iii) a principal whose org is **not** established by `req.authenticatedTenantId` plus an active `user_orgs` row is **denied** (OD-S1-17(b)) — including the case where only the more permissive request-scoped field carries a value — while the same principal with the active `user_orgs` row is allowed. Each asserted as an equality on the observed status/body, never as "not the other error" |
| G-S1-8 | **Feed ⊆ admission** (OD-S1-2). Over a fixture spanning all five tabs and several identities, every `(viewer, instanceId)` pair returned by `listApprovals` satisfies `canReadApprovalInstance` | a participant's tabs return their instances unchanged (no silently-empty inbox) | a constructed row the tab SQL returns but S1 denies makes the gate red — this negative must be **constructed and observed red**, because **three** shipped branches are known wider than S1 (§5.2 (i), (i-b), (i-c)), so the gate is expected to fail until those residuals are ruled. Shipping it green without having seen it red is `feedback_ineffective_mutation_looks_like_a_useless_test`. The fixture must exercise all three: the external-source arm, the `?sourceSystem=plm` actor-free tabs, and a `source_queue` permission-code holder |
| G-S1-9 | **Mention-notify seam defaults CLOSED** (OD-S1-15) | with the checker wired, a participant mentioned on an instance receives the notification | constructing the service **without** calling the setter notifies **nobody** — asserted as zero deliveries, not as "no error thrown". Mutation: change the field initializer to `async () => true` (mirroring `CommentService.ts:186`) -> this gate must red |
| G-S1-10 | **Cross-org denial** | requester reads their own instance | the same principal id, present as a stale seat on **another org's** instance, is denied on that instance across all six migrated surfaces (detail, history, metrics, download, refs, comments) — enumerated, not sampled |
| G-S1-11 | **Monotonic membership** (OD-S1-4) | an approver whose seat is now `is_active = FALSE` still reads the instance (200 on detail and history) | a user who never held a seat on that instance is denied in the SAME fixture, so the gate distinguishes "seat ever existed" from "any row exists in `approval_assignments`" |
| G-S1-12 | **Migration is org-default-free** (OD-S1-9(a)) | after migration, `information_schema.columns` reports `column_default IS NULL` for `approval_instances.org_id`, and `is_nullable = 'NO'` (or the `plm:`-scoped CHECK form of OD-S1-18(b)) | a mutation adding `DEFAULT 'default'` to the migration reds this gate — mechanically, per `feedback_absolute_claim_sweep_must_be_mechanical` |

**Gate hygiene binding on the implementing slices:** mutation restores use a sha256-verified `cp` from a
file backup, never `git checkout -- <file>` in any form (`feedback_never_git_checkout_dot`); each mutation
must be shown to have actually changed the file and to red the **named execution point** rather than a
same-named declaration (`feedback_ineffective_mutation_looks_like_a_useless_test`); and real-DB suites
follow the two-point wiring rule — excluded from the no-DB vitest config **and** wired into a CI lane
(`feedback_realdb_test_two_point_wiring`), since a suite that exists but sits in no lane is
`feedback_triggered_is_not_verified`.

---

## 4. Ratification

**Decision: RATIFY** (2026-08-21). **Design authority ONLY** — this ratification authorizes no runtime
code, no migration, no flag change, no UAT, no deployment and no completion label. Every OD below still
needs its own PR, required checks, an independent adversarial gate, and a ledger row.
**Reversible before any dependent implementation lands**; none has at the time of this record.

**Provenance — recorded exactly, not improved.** The owner directed execution **BY REFERENCE** to a list
of recommendations the **executing session authored** and enumerated on 2026-08-21 (§0); the owner's
authored contribution is the reply 「按建议执行」. That list contained (a) the §K2 non-amendment,
(b) G-14 accept-as-amended, (c) ratify Lock-9 as drafted, and (d) the approval-comments D1/D2/D3/D5 arms.
Item (d) is a direction to **start S1 with those D-arms decided**, and it is the authorization this
ratification rests on. It is the same provenance shape, from the same reply on the same day, under which
Lock-9 was ratified (`f01045f2e9`).

**What that authorization does NOT reach, stated before the OD list rather than after it.** The
enumerated list did not contain this document's ODs individually, and
`feedback_authorization_source_must_be_owner_authored` forbids paraphrasing the session's own
recommendations into owner-authored decisions. So the ODs are recorded in **three buckets**, and the
bucket is part of the record:

- **[RATIFIED]** — follows from "start S1 with the decided D-arms": the predicate's shape, its arms, its
  derived inputs, its denial shapes, and its consumers.
- **[SESSION DESIGN AUTHORITY]** — rulings the review demanded that were never put to the owner in any
  form. They are ratified as **this document's** design authority, explicitly not as owner decisions, and
  the rejected arms are recorded in-line so each is reversible on inspection rather than on trust.
- **[OWNER-CONFIRM BEFORE IMPLEMENTATION]** — items that change what a shipped surface returns or grants.
  These are RECORDED here with their arm but are **NOT authorized**; the implementing slice is blocked on
  §5.1.

### Recorded arms — one line per OD

**Eighteen ODs (OD-S1-1 .. OD-S1-18).** The table below has more rows than that, because five ODs carry
lettered arms that are decided separately (OD-S1-8(d); OD-S1-9(a)/(b)/(c)/(e)/(f); OD-S1-17(a)/(b)/(c)).
The count is of ODs, not of rows — stated here so the discrepancy is not discovered later as an erratum,
the way Lock-9's OD count was.

| OD | Recorded arm | Bucket |
|---|---|---|
| OD-S1-1 | ONE predicate `canReadApprovalInstance(db, viewerId, instanceId) -> boolean`, homed in a new `approval-instance-readability.ts`; fail-closed on any thrown lookup. Rejected: (b) keep it in `approval-attachment-runtime.ts`, (c) an Express middleware, (d) a reason enum | RATIFIED |
| OD-S1-2 | The predicate is an **admission gate**; C-3/C-4 stay **feed filters**; binding rule is one-directional — a feed may be narrower than S1, never wider. Rejected: (b) rewrite the tabs in this slice, (c) leave the relationship unstated | RATIFIED |
| OD-S1-3 | Arm 1 REQUESTER — `i.requester_snapshot->>'id' = viewerId`, unconditional, not status-scoped | RATIFIED |
| OD-S1-4 | Arm 2 SEAT (user- or role-typed), **`approval_assignments.is_active`-INSENSITIVE** — membership is monotonic. Rejected: (b) require an active seat, (c) mirror C-3's status-dependent form | RATIFIED |
| OD-S1-5 | `source_queue` **EXCLUDED** — it matches permission codes, not user ids (F-2), and the act path already refuses the seat. Rejected: (b) admit it scoped to `source_system='plm'`, (c) admit it and rename the semantics. **Its PLM consequence is ruled by OD-S1-18, not left implicit** | RATIFIED |
| OD-S1-6 | Arm 3 PAST ACTOR including `policy_denied` rows — admitted **only together with gate G-S1-6**; if G-S1-6 cannot be written, the arm excludes `policy_denied`. Rejected: (b) exclude unconditionally, (c) include it on a comment | RATIFIED |
| OD-S1-7 | Arm 4 CC TARGET (user- or role-typed) | RATIFIED **as a predicate arm**; its metrics-route effect is a widening — see §5.1 → **widening CONFIRMED 2026-08-21 (§5.1.1)** |
| OD-S1-8 | Arm 5 ADMIN BYPASS, **DB-backed only** (`users.is_active` + `is_admin`/`role='admin'`); C-2's JWT-claims admin rejected as the canonical form. Rejected: (b) union of DB and JWT admin, (c) no admin arm | RATIFIED |
| OD-S1-8(d) | Keep or drop the admin arm entirely | OWNER-CONFIRM (§5.1) |
| OD-S1-9(a) | `org_id text NOT NULL`, **no DB DEFAULT**, non-blank CHECK, `zzzz`-ordered; `approval_attachments` is the precedent, the attendance `DEFAULT 'default'` family the anti-precedent | RATIFIED |
| OD-S1-9(b) | Three-phase migration (ADD nullable → BACKFILL → SET NOT NULL) over **six ORDERED row classes** with cross-class conflict = **FAIL LOUD**, after-sales split out from PLM, and an explicit **terminal ABORT** class | SESSION DESIGN AUTHORITY (the review demanded precedence, the split and the terminal arm; none was put to the owner) |
| OD-S1-9(c) | **(c-iii) — PLM mirrors scoped out of S1's consumers in v1.** (c-i) named platform org and (c-ii) nullable-for-bridge are **REJECTED as outages, not trade-offs**, with the reasons recorded in §2.2(c) | SESSION DESIGN AUTHORITY (drafted as an owner menu; ruled here because two of three arms were outages the owner would have been choosing blind between) |
| OD-S1-9(e) | NULL `org_id` ⇒ **false for everyone including admins**; unreachable on the PLM path by construction under (c-iii) | RATIFIED |
| OD-S1-9(f) | The caller never supplies the org; both sides are derived server-side | RATIFIED |
| OD-S1-10 | The attachment-EXISTS org pin (`approval-attachment-runtime.ts:219-222`) is **removed** and replaced by an instance-level org pin — the fix for F-1 | RATIFIED **as a design ruling**; implementation BLOCKED on §5.1 `L9-AMEND` → **UNBLOCKED 2026-08-21** (L9-AMEND ruled arm (a), §5.1.1; amendment executed in Lock-9 §4.1) |
| OD-S1-11 | Each consumer keeps its own denial shape; **detail and history deny with `404 APPROVAL_NOT_FOUND`**, metrics keeps `403 FORBIDDEN`. Rejected: (b) 403 everywhere, (c) 404 everywhere | RATIFIED |
| OD-S1-12 | The detail/history narrowing (200 → 404 for non-participant `approvals:read` holders) is a **public contract change**, **platform ids only** | OWNER-CONFIRM (§5.1) — explicitly NOT inferred from 「按建议执行」 → **CONFIRMED 2026-08-21 by the second by-reference reply (§5.1.1)** |
| OD-S1-13 | Detail + history adopt S1 in the **same slice** (three paired `Promise.all` FE sites). The draft's "instance-keyed, not mirror-keyed, which avoids that specific trap" is **WITHDRAWN** as unfounded; G-S1-5 now pins the never-refreshed-mirror case | RATIFIED, with the withdrawal recorded |
| OD-S1-14 | Comments read **and** write both gate on S1 — D3's "participant union" is defined by S1 and nothing else; tombstones read under the same gate. Rejected: (b) a separate `canWriteApprovalComment` | RATIFIED (D3/D2(b1) are owner-decided inputs per §0(d)) |
| OD-S1-15 | @-mention candidacy **and** the notification seam are participant-scoped, and the seam initializes `async () => false` — the inverse of `CommentService.ts:186` | RATIFIED (D5 is an owner-decided input) |
| OD-S1-16 | Lock-9's consumers call `canReadApprovalInstance`; `isInstanceParticipant` ceases to exist; no fourth predicate is minted | RATIFIED **as a design ruling**; implementation BLOCKED on §5.1 `L9-AMEND` → **UNBLOCKED 2026-08-21** (L9-AMEND ruled arm (a), §5.1.1; amendment executed in Lock-9 §4.1) |
| OD-S1-17(a) | Viewer **roles** derived from the DB (`users.role` for an active user ∪ `user_roles`⋈`roles`), never from token claims | RATIFIED |
| OD-S1-17(b) | Viewer **org** derived from `user_orgs`; the only authoritative request-scoped field is `req.authenticatedTenantId`; no `'default'` fallback. Rejected: (d) leave the derivations to the implementing slice | RATIFIED |
| OD-S1-17(c) | Multi-org viewers — union / exact-org / single-org-with-boot-assert | OWNER-CONFIRM (§5.1); also blocks the migration's class 3 → **RULED (c-i) 2026-08-21 (§5.1.1)** |
| OD-S1-18 | **PLM mirrors (`plm:` ids) are scoped OUT of S1's consumers in v1**; `org_id` NULLABLE for `plm:` rows only via `CHECK (org_id IS NOT NULL OR id LIKE 'plm:%')`; the C-5 permission-only posture persists there and is declared as residual §5.2 (iii); the exit is a bridge-side membership fact, not authorized here. Rejected: (e) admit `source_queue` scoped to PLM, (f) adopt S1 anyway and declare the outage | SESSION DESIGN AUTHORITY (created by the independent review; never put to the owner) |

### What this ratification explicitly does NOT do

- It does **not** amend Lock-9. OD-L9-13(a) and G-4 remain as the owner ratified them; §5.1 `L9-AMEND`
  carries the conflict, and OD-S1-10/OD-S1-16 cannot be implemented until it is answered.
  *(Answered 2026-08-21: arm (a) — §5.1.1; the amendment is executed in Lock-9 §4.1, a later commit than this ratification.)*
- It does **not** authorize the OD-S1-12 narrowing, the OD-S1-7/C-2 metrics widening, OD-S1-17(c), or
  OD-S1-8(d). *(All four RULED 2026-08-21 by the second by-reference reply — §5.1.1.)*
- It does **not** close C-5 for `plm:` ids (§5.2 (iii)).
- It reports **no verification of any kind**: §3 specifies gates; none has been run.

**Status:** DRAFT -> **RATIFIED 2026-08-21**, plus the §5.3 propagation edits, which land in the same
commit as this record.

---

## 5. Open owner decisions and declared residuals

### 5.1 Blocking owner decisions

| # | Decision | Why it cannot be derived | Blocks |
|---|---|---|---|
| **L9-AMEND** | **Amend RATIFIED Lock-9 OD-L9-13(a) ("reuse `isInstanceParticipant` UNCHANGED", `:501-503`, `:631-640`) and RATIFIED gate G-4 ("Participant predicate reused unchanged", `:398`)**, which OD-S1-10 and OD-S1-16 contradict. Arms: (a) amend both to name `canReadApprovalInstance` and re-point G-4's mutation target; (b) hold OD-S1-10/OD-S1-16 until Lock-9's attachment slices land and amend afterwards; (c) leave Lock-9 as ratified and give S1 a different home, keeping `isInstanceParticipant` alive — which reopens D-4 | Lock-9 was ratified by the owner on 2026-08-21 under the **same** by-reference authorization this lock cites. An executing session may not amend ratified normative text **that the ratified document did not delegate** — see §5.3 for the delegation test that distinguishes this row from the Lock-7 annotations this same commit does make — and "one sentence goes stale" was a mis-classification of a text conflict as a bookkeeping edit (review P1-3) | OD-S1-10, OD-S1-16, and therefore the C-1 migration |
| OD-S1-12 | Confirm the detail-route contract narrowing (200 -> 404 for non-participant `approvals:read` holders, **platform ids only** per OD-S1-18) | it is a public behaviour change; the house rule is ratify-first, and §0's 「按建议执行」 answered a list that did not contain it | consumer (b) |
| OD-S1-7 / C-2 | Confirm the metrics-ACL **widening**: after migration a CC target reads another user's instance metrics where C-2 denies them today (review P2-3, promoted here) | it grants new read access on a shipped surface. **The review's stated rationale is rebutted** — under `feedback_tests_freeze_change_not_approve_it` the criterion is "does an existing client break today", and a widening breaks none, so it is NOT the same class as OD-S1-12's narrowing. It is escalated anyway on a different and sufficient ground: an ACL widening is a security-relevant grant, and the executing session's by-reference authorization does not reach grants | the metrics consumer only; the rest of S1 may proceed |
| OD-S1-17(c) | Multi-org viewers: (c-i) union over the viewer's active orgs / (c-ii) exact-org from `req.authenticatedTenantId` with denial outside it / (c-iii) single-org-only in v1 with a boot assert | `user_orgs` PK is `(user_id, org_id)` (`zzzz20260114110000:20-27`), so "the viewer's org" has no single answer for a multi-org user. Until it is ruled, **G-S1-10 is either sound or vacuous** | the org half of the predicate, G-S1-10's meaning, **and the migration** — §2.2(b) class 3 ("resolves to exactly one org membership") is undefined until it is ruled, and `zzzz20260114110000:34-40` backfills every active user into `'default'`, so multi-org rows are the expected shape (review P2-5) |
| OD-S1-8(d) | Keep or drop the admin bypass arm | product judgement about the admin surfaces (`/jump`, `/admin/reassign`), not a code fact | the predicate's arm list |
| §5.2 (i)(i-b)(i-c) | The **three** feed branches wider than S1 (below) | they are shipped product behaviour, not bugs with an obvious fix; narrowing them changes what a shipped inbox shows | G-S1-8 can be written but is expected red until ruled |

**Removed from this table at ratification:** `OD-S1-9(c)`. It was drafted as an owner decision with three
arms; the review established that two of the three are outages rather than trade-offs (§2.2(c)), so
offering the menu would have asked the owner to choose blind. It is RULED (c-iii) by the executing session
as design authority, with the rejected arms and their consequences recorded in §2.2(c) so the ruling is
reversible on inspection rather than on trust.

### 5.1.1 RESOLUTION (2026-08-21) — five of the six §5.1 rows RULED, by the second by-reference reply

**Provenance.** After ratification the executing session presented the owner a six-item recommendation
list; the owner replied 「按建议执行」 (2026-08-21). This is the **second** by-reference reply of that
date — distinct from the one §0 cites, which answered a different list — and per §0's own rule it reaches
exactly the enumerated items and nothing else. The list was authored by the executing session; the
owner's authored contribution is those four characters. The referenced list, verbatim:

> (1) L9-AMEND→建议 (a);(2) OD-S1-12→建议确认 404 收窄;(3) OD-S1-7→建议确认 metrics 放宽;
> (4) OD-S1-17→建议 (c-i) 多 org 并集;(5) OD-S1-8(d)→建议保留 admin bypass;
> (6) HISTORY-TIMELINE→建议 (i) history 排除指针行。

| §5.1 row | Ruling | Effect |
|---|---|---|
| **L9-AMEND** | **arm (a)** | The owner-level amendment of Lock-9 OD-L9-13(a) and gate G-4 is now AUTHORIZED and is **executed in this same commit** — see Lock-9 §4.1, which names `canReadApprovalInstance` and re-points G-4's mutation target. Unblocks OD-S1-10, OD-S1-16, and the C-1 migration |
| OD-S1-12 | **CONFIRMED** | the detail/history 200→404 narrowing for non-participant `approvals:read` holders is authorized, **platform ids only** (the OD-S1-18 `plm:` carve-out is unchanged); consumer (b) may land |
| OD-S1-7 / C-2 | **CONFIRMED** | the metrics-ACL widening is authorized: after migration a CC target reads the instance metrics C-2 denies them today; the metrics consumer may land |
| OD-S1-17(c) | **arm (c-i)** | the org half of the predicate is a **union over the viewer's ACTIVE org memberships**; G-S1-10 is **SOUND** under this ruling — noting §2.2a(c) itself grades (c-i) the simplest and **weakest** arm, and its fixture must be constructed against the fact that `zzzz20260114110000:34-40` backfills EVERY active user into `'default'`: a cross-org-denial viewer must hold NO membership in the instance's org, or the union admits them and the negative is vacuous. Migration consequence: §2.2(b) class 3's identifying test ("resolves to exactly one **active** org membership") is now well-defined — a multi-org requester **fails** class 3 and falls through the ordered table under the unchanged FAIL-LOUD/terminal-ABORT discipline. The class-3 declared limit ("can move a historical instance out of the tenant that ran it") is **NOT diminished** by (c-i): a participant whose memberships lie only in the original org is still denied after such a move; only the requester's own readability survives it, via the union |
| OD-S1-8(d) | **KEEP** | the DB-backed admin bypass stays in the predicate's arm list as ratified in OD-S1-8 |

Item (6) of the referenced list is not a §5.1 row: HISTORY-TIMELINE is the S2 brief's escalation (the
comment audit-pointer row would land in the shipped `/history` timeline). Its ruling — arm (i): the
history reader excludes pointer rows (`metadata->>'commentId' IS NULL`) applied to **both** the count and
the page query with the same literal, the exact `approval-history.ts:90-120` `policy_denied` pattern
(count exclusion `:98-99`, page exclusion `:117-120`) — is recorded in the parity execution ledger §3 for
the S2 lock to cite; it authorizes nothing outside S2. The ruling as recorded here and in that ledger row
is **self-contained**: the "(i)" label refers to a session-authored S2 brief that is NOT in the repo, so
the S2 lock must restate the ruling from these two in-repo records, never by citing the label alone.

**NOT covered by this reply:** the §5.1 table's last row (the three §5.2 (i)(i-b)(i-c) feed branches) was
not in the referenced list — the session had stated, in the same thread, that it required no owner answer
and would be treated as declared residuals. It remains **OPEN**; G-S1-8 stays expected-red as ratified.

**What this resolution does NOT change:** every SESSION-DESIGN-AUTHORITY and RATIFIED item stands exactly
as ratified; no gate in THIS lock's §3 table is edited by this commit (the one gate edit anywhere in the
commit is Lock-9 G-4, amended as §5.1.1's L9-AMEND row authorizes — re-pointed, intent preserved); no
verification claim is added — §3's gates still specify acceptance
and none has been run at the time of this edit.

### 5.2 Declared residuals — NOT closed by this document

**Corrected count (review P2-2, closed).** The draft said "the one place where C-3 is *known* to be
wider". There are **three**, and the draft's own C-3 census row characterized only the platform branch
while anchoring all three — so two of them were cited and never described. The absolute has been removed
and the census row rewritten (§1, C-3).

(i) **C-3's external-source arm is WIDER than S1, in the direction OD-S1-2 forbids.** In the
`includeExternalTabSources` branch, the `pending` tab admits `COALESCE(source_system,'platform') <>
'platform' AND status = 'pending'` with **no actor predicate at all**
(`ApprovalBridgeService.ts:421-424`), and `completed` does the same for `status <> 'pending'`
(`:470-473`). Any caller of that branch sees every external instance.

(i-b) **The `sourceSystem === 'plm'` branch is wider still, and is caller-selectable.** `pending` is
`status = 'pending'` (`:367-368`) and `completed` is `status <> 'pending'` (`:383-384`) — **no actor
predicate whatsoever** — reached through the caller-supplied `?sourceSystem=plm` query parameter
(`routes/approvals.ts:994-1006`, `:1059-1076`, adapter-gated at `:1053`). Its `cc` tab is also
user-typed-only (`:372-382`), so a role-typed CC target does not see their own row there. The code says
why (a comment at `:364-366`: "PLM assignment filtering is not available in phase 1"), which makes it a
declared phase-1 limitation rather than an accident — but it is a limitation of a **shipped feed**, and
this lock does not rule it.

(i-c) **This lock CREATES a third one.** OD-S1-5 excludes the `source_queue` arm from S1 while that arm
survives in the tabs on both the platform (`:508`, `:548`) and external (`:417`, `:466`) branches. A
holder of the matching permission code therefore sees tab rows S1 denies — structurally, by this lock's
own ruling, not by pre-existing drift. It is recorded here rather than presented as inherited, and it is
the reason G-S1-8's negative must be constructed from all three branches.

All three are stated as open conflicts between shipped feeds and the admission rule this lock introduces;
none is ruled here, because narrowing any of them changes what a shipped inbox shows.

(ii) **`POST /:id/mark-read` (`:1543`) and `POST /:id/remind` (`:1697`)** carry only
`rbacGuard('approvals','read')` and no participant predicate. `/remind` is a notification channel into an
instance's participants. Listed as a residual, explicitly **not** cleared.

(iii) **The C-5 permission-only read posture PERSISTS for `plm:` ids.** OD-S1-18 scopes PLM mirrors out of
S1 in v1, so after this lock's slices land a principal holding `approvals:read` still reads any `plm:`
instance through `GET /api/approvals/:id` and `/history`. This lock removes nothing there and adds
nothing; it is the status quo, declared as a named non-closure rather than absorbed into "S1 closes C-5".
No copy anywhere may describe approval instance reads as participant-scoped without this qualifier
(master M8). The exit is a bridge-side change that mints a real membership fact on the mirror
(OD-S1-18(d)), which is not authorized here.

(iv) **This document asserts nothing about surfaces it did not enumerate.** The `/api/approvals/:id*`
family was enumerated mechanically at the baseline (§2.10) and the metrics family from its own router
(`approval-metrics.ts:63-161`). Per `feedback_empty_read_is_not_absence`, a grep that returned nothing is
reported as "this scan did not surface X", never as "X does not exist" — and no claim is made about
plugin packages, `apps/web` route guards, or any surface outside those two enumerations.

### 5.3 Propagation required at ratification (required edits, not side effects)

**The delegation test — why Lock-7 is annotated here and Lock-9 is not.** This commit edits three sites in
a RATIFIED Lock-7 while §5.1 `L9-AMEND` refuses to edit a RATIFIED Lock-9. Those are not the same act, and
the discriminator is in the ratified text itself, not in convenience:

> a ratified lock that **delegates its own resolution** may be annotated by the delegate, and only to
> record that the delegation was discharged; a ratified lock whose operative word is **"UNCHANGED"**
> delegates nothing and may be amended only by the owner.

Lock-7's D-5 row says, verbatim, "Any later document must resolve read scope on its own authority" — it
names a successor and hands it the question, so annotating D-5 with its resolution is discharging Lock-7's
own instruction. Lock-9's OD-L9-13(a) says "reuse `isInstanceParticipant` **UNCHANGED**" and its gate G-4
is "Participant predicate reused unchanged"; nothing there delegates, and OD-S1-10/OD-S1-16 would
contradict rather than discharge it. Hence: annotation below, escalation in §5.1. The annotations
themselves are additive — no Lock-7 ruling is rewritten, narrowed or widened.

- `approval-lock7-field-edit-enforcement-20260817.md:344` (the D-5 row), `:395`, and `:503` all said D-5 is
  OPEN. They are stale on ratification and are annotated **RESOLVED-BY Lock-10** in this commit — per
  `feedback_gate_verdict_is_head_scoped` and the house rule that a retraction must propagate to every
  place the superseded claim was made. Each annotation also carries the `plm:` carve-out (§5.2 (iii)), so
  no reader of Lock-7 concludes D-5 is closed for every id shape.
- **NOT a propagation edit:** Lock-9 (`approval-lock9-handler-process-attachments-20260819.md`, RATIFIED,
  on main as `f01045f2e9`). Its OD-L9-13(a) and gate G-4 conflict with OD-S1-10/OD-S1-16 as **ratified
  normative text**, so they move to §5.1 (row `L9-AMEND`) as a blocking owner decision. This document
  edits nothing in Lock-9, and the reclassification is itself recorded in §7 (review P1-3).
- `docs/development/approval-parity-execution-ledger-20260817.md` — a row for this lock, and an update to
  the #5050 comments row, which already anticipates it: "S1 (the per-instance readability predicate) is
  the first implementation dependency and its lock is being drafted as the resolution of this same D-5".

---

## 6. Honesty discharge (master M8, M11)

**M8 — configuration and enforcement must be honest**
(`approval-parity-master-design-lock-20260817.md:227-232`; "UI configuration cannot claim a security
property the runtime does not enforce"). Discharged as follows:

- Nothing in this document is enforced at this baseline. The predicate does not exist; `org_id` does not
  exist; `GET /api/approvals/:id` is permission-scoped and returns any instance to any `approvals:read`
  holder (§1, C-5). No copy anywhere — UI, docs, or PR body — may describe approval instance reads as
  participant-scoped until the slices land and their gates are observed green.
- The zero-attachment hole (F-1) and the `source_queue`/permission-code collision (F-2) are stated as
  what they are: F-1 is a real defect currently unreachable from its two consumers; F-2 is a reachability
  finding whose grant side is unpopulated at this baseline. Neither is described as a live exploited
  vulnerability, and neither is described as safe.
- OD-S1-6 is admitted **conditionally on a gate** (G-S1-6) rather than on a comment, because an invariant
  asserted only in prose is a hidden bug.
- OD-S1-17 rules two derivations that are **not** what the shipped approval surfaces do today (roles from
  the DB rather than token claims; org from `user_orgs` with `req.authenticatedTenantId` as the only
  authoritative request-scoped field, rather than the more permissive field plus a `'default'` fallback).
  Those are stated as the ruling this lock makes, not as behaviour that is in place — and the
  reachability analysis of the shipped resolver is held in the private line inventory per the
  disclosure doctrine, not published here.

**M11 — evidence language is scoped** (`:247-250`). Discharged as follows:

- Every SOURCE anchor was read at `c473a079b5ff6389b98f4919bb88607a0baa913b` and is qualified by that
  baseline; a dozen transcription drifts of one to three lines were corrected at ratification and the
  header's unqualified "every anchor was READ AT THIS BASELINE" was replaced with the qualified form,
  because the original sentence was true of the reading and false of the transcription (§7, P3-6).
- **LIVE-STATE claims are separated from anchor claims and are stated against `origin/main@0ced183c04`.**
  The draft asserted Lock-9 (#5011) and the decisions ledger (#5050) were OPEN and not on main; both had
  **merged** (`f01045f2e9`, `3c789110db`) and Lock-9 was **RATIFIED**. Worse, "Lock-9 is described as
  OPEN, not ratified" was offered *here*, in the M11 discharge, as evidence of scoping discipline — a
  false statement presented as an honesty credit. It is retracted in place rather than quietly fixed, and
  §7 P1-3 records both the correction and the re-classification it forced (a conflict with ratified
  normative text, escalated to §5.1, not a stale sentence handled in §5.3).
- F-1 is labelled an executed-probe fact **and is now sourced to Lock-9's landed record of that probe**
  rather than to this document's assertion; F-2's grant-side emptiness is labelled a **scan result**, not
  a proof of absence — the draft carried the qualified form here and the unqualified form ("granted to no
  one") in §1.1, and §1.1 has been corrected to match.
- No gate in §3 is reported as passing: none has been run. §3 specifies gates, and this document contains
  **no verification claim of any kind**.
- The owner's authorization is scoped in §0 to the enumerated list it answered, and §4 records explicitly
  what it does **not** cover — bucketing every OD as RATIFIED, SESSION DESIGN AUTHORITY, or
  OWNER-CONFIRM, so no reader can infer owner authorization for a ruling the owner never saw.
- **No claim of completeness is made about this document's own review.** §7 records the disposition of
  one independent adversarial review at one head; it is not evidence that no further defect exists
  (`feedback_gate_verdict_is_head_scoped`).

---

## 7. Independent adversarial review — disposition (2026-08-21)

An independent opus refute-first review of this draft returned **REQUEST-CHANGES** at head
`19c04f58aa4b606ce4e3b9481f00759fe96e2c9d` (3 P1, 5 P2, 6 P3, 4 NIT). The review read every cited anchor
at the declared baseline in a clean non-shallow worktree and re-checked live-state claims against current
main. Its dispositions are below. **One finding is partly rebutted; every other finding is closed by an
edit to this document, not by argument.** Nothing here is a verification claim: the review is a document
review, and §3's gates remain unrun.

| # | Finding | Disposition |
|---|---|---|
| **P1-1** | Adopting S1 makes every **pending** PLM approval unreadable by its approver, and G-S1-4 cannot detect it (its positive control is a row shape no production path produces) | **CLOSED — confirmed and remedied.** Independently re-verified here: `upsertPlmMirror` is the sole seat writer for `plm:` ids and writes only `('source_queue','plm:source-owned')`; no site updates `assignment_type`/`assignee_id`; `AfterSalesApprovalBridgeService.ts:568-572` writes `'role'` seats, so the after-sales population is **not** affected. Remedy: **OD-S1-18** (§2.4a) scopes `plm:` ids out of S1's consumers in v1; OD-S1-5 now states the collapse explicitly; G-S1-4 is reframed to prove the **bypass** (predicate invocation count = 0) against a state `upsertPlmMirror` actually produces |
| **P1-2** | OD-S1-13's "instance-keyed, not mirror-keyed, which avoids that specific trap" is unfounded — for `plm:` ids the instance row **is** the mirror, materialized by the detail door alone while the history door never touches `approval_instances` | **CLOSED — claim WITHDRAWN.** Re-verified: `routes/approval-history.ts:52-76` takes the PLM branch straight to the adapter. The sentence is retracted in §2.4, the mechanism is written out, and G-S1-5 gains a never-refreshed-mirror case whose fixture must NOT pre-create the row. Same root and same remedy as P1-1, as the review argued |
| **P1-3** | Lock-9 (#5011) and #5050 are MERGED and Lock-9 is RATIFIED; the draft's premise that both are OPEN is false against current main — and the consequence is under-classified (it contradicts ratified normative text, not one stale sentence) | **CLOSED — confirmed on both counts.** Re-verified against `origin/main`: `f01045f2e9` / `3c789110db`; the landed Lock-9 header reads "Status: RATIFIED 2026-08-21"; OD-L9-13(a) (`:501-503`, `:631-640`) says "reuse `isInstanceParticipant` **UNCHANGED**" and gate G-4 (`:398`) is "Participant predicate reused unchanged". §Parents, §0(c), §2.11 and §6 are corrected; the conflict is **re-classified from a §5.3 propagation edit to a §5.1 blocking owner decision** (`L9-AMEND`); F-1 is re-sourced to Lock-9's landed probe record; §2.11's "whichever ratifies first" fork is collapsed |
| **P2-1** | OD-S1-9(c-ii) + (e) + G-S1-4 are mutually unsatisfiable for exactly the PLM population | **CLOSED.** (c-ii) is recorded as REJECTED with this reason stated (§2.2(c)); the ruled (c-iii) plus OD-S1-18(b) makes (e) unreachable on the PLM path by construction, and that sentence is written where a reader would otherwise reconstruct the finding |
| **P2-2** | "the one place where C-3 is *known* to be wider" is false — there are three, and the C-3 census row characterizes only one of the three branches it anchors | **CLOSED.** Re-verified: the `sourceSystem === 'plm'` branch's `pending` (`:367-368`) and `completed` (`:383-384`) carry no actor predicate and are caller-selectable. The absolute is removed, the census row rewritten branch-by-branch, and §5.2 now carries (i), (i-b) and (i-c) — the third **created by this lock's own OD-S1-5**, recorded as such rather than as inherited drift |
| **P2-3** | The metrics CC-arm **widening** is only "declared" while the symmetric detail narrowing is ratify-first; same class ⇒ same treatment | **PARTLY REBUTTED, then CLOSED-BY-PROMOTION.** The stated rationale is rejected: under `feedback_tests_freeze_change_not_approve_it` the criterion is "does an existing client break today", and a widening breaks none — a narrowing and a widening are **not** the same class under the house rule the review invokes. The finding is nonetheless granted on a different and sufficient ground: an ACL widening **grants new read access to another user's data**, and the executing session's by-reference authorization does not reach grants. It is promoted to §5.1 as an OWNER-CONFIRM row |
| **P2-4** | The preamble self-test ("more than one instance-membership construct") is contradicted by §2.10 keeping C-3/C-4 | **CLOSED.** Reworded to "admission predicate", with the reason for the distinction stated so a later reader does not "restore" the stronger-sounding absolute |
| **P2-5** | Backfill classes lack precedence, have a structural terminal hole, presuppose OD-S1-17(c) for class 3, and mis-label class 4 by `upsertPlmMirror` alone though it also captures after-sales rows | **CLOSED on all four.** The class table is now ordered and normative, cross-class conflict is FAIL-LOUD (the load-bearing half: after OD-S1-10 the instance pin governs attachment downloads), class 6 is an explicit terminal ABORT arm **stated as a structural hole and not as an asserted population**, class 3 is marked blocked by OD-S1-17(c) and §5.1 updated accordingly, and after-sales is split out as class 4 — S1-admissible by arm 2, needing an org and not an arm |
| **P3-1** | OD-S1-5 cites a **comment** (`ApprovalBridgeService.ts:715-716`) as "the act path" | **CLOSED.** Re-anchored to `ApprovalProductService.ts:3921-3934` and `approval-effective-node-operations.ts:132-155`, both read; the comment is retained and labelled as a comment |
| **P3-2** | G-S1-6's named mutation can be silently ineffective under widen-only ABSENT ≡ ALLOWED unless the fixture pins an explicit `false` | **CLOSED.** The fixture precondition is written into the gate |
| **P3-3** | G-S1-1's "only this gate reds" diagnostic is wrong and pushes toward weakening fixtures | **CLOSED.** The diagnostic is withdrawn and replaced with the correct reading (other gates reding because their fixture instance has zero attachments is the mutation working) |
| **P3-4** | F-2's "granted to no one" over-reaches a source grep | **CLOSED.** §1.1 now carries the scan-scoped form that §6 already used |
| **P3-5** | §2.2a publishes both halves of the mechanism it says it is withholding | **CLOSED.** The `jwt-middleware.ts:106-108` characterization is dropped to the private inventory; only the ruling is published |
| **P3-6** | ~8 anchors drift 1–3 lines against the header's unqualified "Every anchor was READ AT THIS BASELINE" | **CLOSED.** Corrections applied (C-1 requester `:224`; C-2 `:197` / `:198-205` / `:206-209` / `:215`; C-3 external `:396`, `mine` `:513`, `cc` `:514-525`, `processed` `:552-561`; `getApproval` `:651-746`; `fieldAccess` `:687-696`; `viewerRoles` union `:182-188`; denial INSERT `:9211-9216`), spot-verified against the tree; the header absolute is replaced with a qualified statement rather than left standing |
| **NIT-1** | A third paired `Promise.all([loadDetail, loadHistory])` site at `ApprovalDetailView.vue:2359` is uncited | **CLOSED** — cited in OD-S1-13; it strengthens the pairing argument |
| **NIT-2** | §0 row (d) drops the ledger's "**body cleared**" from D2(b1) in a section claiming condensation by selection only | **CLOSED** — restored verbatim |
| **NIT-3** | The header says "CLOSES Lock-7 D-5" in the present tense while Status was DRAFT | **CLOSED** — bound to ratification, which §4 now records |
| **NIT-4** | `zzzz20260818120000_create_approval_usable_member_groups.ts` is a fresher in-domain precedent: default-free column, but an application-level `'default'` org fallback — ratifying OD-S1-17(b) creates an intra-domain inconsistency worth declaring | **ACCEPTED AND DECLARED HERE.** OD-S1-17(b) refuses the application-level `'default'` fallback, so after S1 lands two approval-domain surfaces resolve the request org differently until the older one is aligned. That is a **declared inconsistency, not a silent one**; aligning it is out of scope of this lock and is not authorized here (`feedback_scope_deferral_shield_does_not_cover_new_lines` cuts the other way for code this lock introduces, and OD-S1-17(b) binds every surface S1 touches) |

**What the review verified clean**, recorded so a later editor knows what not to "fix": Lock-7 D-4/D-5 and
master M8/M11 quoted verbatim; C-1 arm-for-arm including its org pin and the tombstone-410 comment; F-1
and F-2 both sound; `approval_instances` carries no `org_id` at the baseline (mechanically enumerated over
all 22 added columns); the `approval_attachments` precedent and attendance anti-precedent exact; the
`user_orgs` PK and the `authenticatedTenantId` vs `user.tenantId` trust split exact; the FE pairing
evidence and both #5024 PR-body quotes verbatim; the `CommentService` fail-open seam exact; the route
enumerations complete repo-wide (`/api/approvals/:id*` family plus the metrics router), `isAdminActor`
single-site, `isInstanceParticipant` two consumers; §0's provenance construction and OD-S1-12's
ratify-first framing correct; G-S1-7 and G-S1-12 well-formed.

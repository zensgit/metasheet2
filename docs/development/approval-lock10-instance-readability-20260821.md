# Lock-10 (S1) — The Per-Instance Readability Predicate (2026-08-21)

**Status:** DRAFT — PENDING RATIFY. Design authority ONLY. No runtime code, no migration, no flag, no
UAT, no deployment, and no completion label is authorized by this document. Every contract below still
needs its own PR, required checks, an independent adversarial gate, and a ledger row.

**This document CLOSES Lock-7 §2.7 D-5.** D-5 reads, verbatim from
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
instance-membership construct on main after the slices land, the document has failed its own claim.

**Baseline:** `origin/main@c473a079b5ff6389b98f4919bb88607a0baa913b`. Every anchor below was READ AT THIS
BASELINE. The repository is not shallow (`git rev-parse --is-shallow-repository` -> `false`), so ancestry
answers here are trustworthy; no ancestry claim is made about any document this file does not cite by SHA
or PR number. Unqualified anchors carry their file path.

**Parents:**
- `approval-parity-master-design-lock-20260817.md` (RATIFIED, on main) — **M8** (`:227-232`, configuration
  and enforcement must be honest; "UI configuration cannot claim a security property the runtime does not
  enforce") and **M11** (`:247-250`, evidence language is scoped). §6 discharges both against this text.
- `approval-lock7-field-edit-enforcement-20260817.md` (RATIFIED, on main) — D-4 (`:343`) and D-5 (`:344`),
  above. Lock-7's own authorization model (the ACTIVE-seat check for WRITE) is untouched: this lock rules
  READ admission only and never widens or narrows any write path.
- `approval-lock9-handler-process-attachments-20260819.md` — **OPEN** (PR #5011, not on main, drafted
  ratify-ready). Its L9-C / OD-L9-4 / OD-L9-13 reuse `isInstanceParticipant` **without modification**.
  §2.11 rules the interaction and names the one Lock-9 sentence that goes stale.
- The approval-comments D-arm decisions recorded in PR **#5050** (**OPEN**, not on main) —
  `docs/development/approval-parity-execution-ledger-20260817.md`. §0 records that provenance.

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
| (c) | **Lock-9 (PR #5011): ratify as drafted** (13 ODs, ratify-ready) | authorized, **not yet executed** — #5011 is still OPEN at this baseline. §2.11 sequences against that fact rather than assuming it |
| (d) | **approval-comments decisions.** **D1 arm (i)** — add `org_id` to `approval_instances` with an explicit backfill ruling. **D2 arm (b1)** — a mutable `approval_comments` table; the audit row carries a pointer (`metadata.commentId`), the body lives only in the mutable table; deletion leaves a tombstone (`deleted_at` + author retained). **D3** — widen comment WRITE from acting-assignee-only to the participant union. **D5** — @-mention candidates participant-scoped, not org-wide | authorized. **These are INPUTS to this lock and are NOT re-litigated here** (§2.2 → OD-S1-9; §2.4 → OD-S1-14/15) |

**Reversibility:** the authorization is reversible before dependent implementation lands. No
implementation depends on it yet at this baseline.

**What this lock adds on top of (d):** D1(i) says "add `org_id` with an explicit backfill ruling"; the
ruling itself was not enumerated to the owner and is therefore NOT covered by 「按建议执行」. §2.2 drafts
it and §5.1 escalates the one part of it that cannot be derived from the repository (OD-S1-9(c)).

---

## 1. Shipped surfaces census — FIVE constructs, not two

The task framing named two constructs; Lock-7 D-4 names two **different** ones. Both framings are
partial. The mechanical enumeration at this baseline is five, and writing "the two existing constructs"
would contradict the very D-4 row this document cites. Every row below was read at the baseline.

| # | Construct | Anchor | Kind | Arms present | Org pin | `is_active` |
|---|---|---|---|---|---|---|
| C-1 | `isInstanceParticipant` | `packages/core-backend/src/services/approval-attachment-runtime.ts:201-244` | **admission gate** (attachment byte path + refs) | requester `:223`; assignment user-or-role `:225-230`; past actor `:231`; CC user-or-role `:232-237`; admin `:238` | **YES, but attachment-EXISTS-scoped**: `EXISTS (SELECT 1 FROM approval_attachments att WHERE att.instance_id = i.id AND att.org_id = $4)` `:219-222` | assignment `is_active` **ignored**; `users.is_active` required on the admin arm `:238` |
| C-2 | Metrics instance ACL | `packages/core-backend/src/routes/approval-metrics.ts:193-215` | **admission gate** (`GET /api/approvals/metrics/instances/:instanceId`, `:161-163`) | requester `:196`; assignment user-or-role `:198-206`; past actor `:207-210`; admin via `isAdminActor` `:175`, `:32-42` | **NONE** | assignment `is_active` ignored; admin arm is **JWT-claims-only** (`req.user.role`, `roles`, `permissions.includes('*:*')` `:33-41`) — no DB read |
| C-3 | `listApprovals` tab SQL | `packages/core-backend/src/services/ApprovalBridgeService.ts:300-564` (platform branch `:489-561`; external branch `:395-488`; PLM branch `:363-394`) | **feed filter**, not an admission gate | per-tab, not a union: `pending` = active seat incl. **`source_queue`** `:504-511`; `mine` = requester `:512`; `cc` `:514-527`; `completed` = requester OR actor OR cc OR seat (**`is_active` dropped**) `:528-550`; `processed` = actor `:551-559` | **NONE** | `pending` requires `is_active = TRUE` `:505`; `completed` omits it `:545-549` — asymmetric **within one construct** |
| C-4 | Pending / pending-count inline SQL | `packages/core-backend/src/routes/approvals.ts:1376`, `:1448`; params built at `:1477-1498` and `:1630-1642` | **feed filter** | active seat incl. `source_queue` | **NONE** | requires active seats |
| C-5 | `GET /api/approvals/:id` — **the absence** | `packages/core-backend/src/routes/approvals.ts:2559` -> `ApprovalBridgeService.getApproval` `:651-750` | **admission gate that does not exist** | none. `getApproval` returns the DTO for ANY instance id that loads (`:670-671`); the viewer identity is used only for field-level projection (`fieldAccess` `:686-700`) and `nodeOperations` (`:711-724`) | **NONE** | n/a |

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
`plm:source-owned` appears only in that writer, its tests, and the matcher — it is **granted to no one**,
so the arm is currently unreachable in the grant direction. Per
`feedback_dead_code_defect_is_not_a_live_vulnerability`, that reachability finding is stated as a
reachability finding and **not** dressed up as a live vulnerability; it is nonetheless the reason
OD-S1-5 refuses the arm rather than inheriting it. Note also that the act path already refuses a
`source_queue` seat outright (`ApprovalBridgeService.ts:715-716`: "`assignmentMatchesActor` exactly,
including refusing a `'source_queue'` seat outright"), so admitting it on read would mint a read/act
asymmetry with no ruling behind it.

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
escalates the one place where C-3 is *known* to be wider today.

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
claim; the act path already refuses the same seat (`ApprovalBridgeService.ts:715-716`); and the only
value ever written is a constant shared by every PLM-mirrored instance, so one grant would open every
mirrored instance at once. PLM readability is instead ruled on its own terms in OD-S1-9(b)/(c) and
§5.1 — the legitimate PLM approver must reach the instance through a real membership fact, not through a
permission string that happens to collide with an `assignee_id`.

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
  read what they are about to act on. Offered to the owner as OD-S1-9(d) rather than taken unilaterally.

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

| Row class | Identifying predicate at baseline | Backfill source | Confidence |
|---|---|---|---|
| Template-originated | `template_id IS NOT NULL` (`zzzz20260411120100:106`, nullable FK `ON DELETE SET NULL`) | the template's owning org | derivable, **pending (c)** for the rest |
| Attachment-bearing | `EXISTS (SELECT 1 FROM approval_attachments att WHERE att.instance_id = i.id)` | `att.org_id` — already NOT NULL and non-blank there | derivable and self-consistent; if one instance carries attachments from two orgs the migration must **FAIL LOUD**, not pick one |
| Requester-resolvable | `requester_snapshot->>'id'` resolves to exactly one org membership | the requester's org **at migration time**, not at creation time | **honest limit: this is not the creation-time fact.** A requester who changed org since submission backfills the instance into their *current* org, which can move a historical instance out of the tenant that ran it |
| PLM / bridge mirrors | `COALESCE(source_system,'platform') <> 'platform'`; `template_id IS NULL`; rows written by `upsertPlmMirror` (`ApprovalBridgeService.ts:1106-1195`) | **NONE EXISTS.** The mirror writer stamps no org and derives none; `plm:`-prefixed ids carry no tenant | **not derivable — escalated, OD-S1-9(c)** |

**(c) OWNER DECISION REQUIRED — the unbackfillable class.** For rows in the last class the choice is a
real product decision, not an engineering preference, and it is escalated rather than dressed as prose
about "honest limits" (`feedback_misclassified_gap_called_a_ceiling`: when the criterion cannot reach,
first ask whether this is one problem or two). Arms:
  - **(c-i)** a single named platform org for all bridge rows (e.g. the deploy's primary org), accepting
    that a multi-tenant deployment mixes bridge instances into one tenant;
  - **(c-ii)** `org_id` stays NULLABLE **for bridge rows only**, enforced by
    `CHECK (org_id IS NOT NULL OR COALESCE(source_system,'platform') <> 'platform')`, and the predicate
    treats NULL per (e);
  - **(c-iii)** bridge instances are excluded from S1's consumers entirely in v1 (comments off; detail
    keeps its current posture for `plm:` ids), deferring the question until the bridge carries an org.

**(d) Optional, owner-only:** drop the admin arm (rejected alternative (c) of OD-S1-8).

**(e) [R] — the predicate's NULL-org posture: FAIL CLOSED, and this is the dangerous gate.** If
`i.org_id IS NULL` the predicate returns false for everyone, admin included. Stated alone this is
uncontroversial; stated together with (b) it is a **shipping hazard**, and the hazard is named here
because the obvious acceptance gate hides it: a "NULL-org fails closed" test **passes** in exactly the
world where every PLM instance has become unreadable by every legitimate approver. Per
`feedback_positive_control_not_failclosed` and `feedback_verified_one_link_generalised_to_the_chain`, the
NULL gate (G-S1-3) is admitted **only paired with** G-S1-4 (a PLM-mirrored instance is still readable by
its legitimate approver); a slice that ships G-S1-3 green without G-S1-4 has proven nothing.

**(f) [R] — the caller does not supply the org.** The predicate takes `(db, viewerId, instanceId)` and
derives both sides server-side: the instance's org from the row, the viewer's from their session
principal. A body- or query-supplied `org_id` is a cross-tenant forgery — the same rule the attachment
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

**OD-S1-12 [R] — adopting S1 on `GET /api/approvals/:id` is a CONTRACT NARROWING and is ratify-first.**
Today a non-participant holding `approvals:read` gets `200` with the full instance. After adoption they
get `404`. That is a behaviour change for existing clients, so per
`feedback_tests_freeze_change_not_approve_it` the question is "does an existing client break today", and
the answer is yes for any integration that lists under one identity and fetches detail under another, or
any admin tool relying on the permission-only posture. This must be ratified explicitly in §4 and must
NOT be inferred from 「按建议执行」, which was answered to a list that did not contain it.

### 2.4 The three consumers

**OD-S1-13 [R] — Consumer (b), the detail/history PAIR, adopts S1 in the SAME slice.**
`GET /api/approvals/:id` (`routes/approvals.ts:2559`) and `GET /api/approvals/:id/history`
(`routes/approval-history.ts:50`) adopt S1 together, as leg-2 on top of `#5024`'s leg-1 rbacGuard. This
is not tidiness. The frontend calls both **concurrently under one identity**:
`apps/web/src/views/approval/ApprovalDetailView.vue:1926` and `:2008` both run
`Promise.all([store.loadDetail(id), store.loadHistory(id)])`, and the store writes both failures into one
shared `error` ref (`apps/web/src/approvals/store.ts:125-147`). Adopting S1 on one door only produces a
**detail-200 / history-403 split**: the page renders a fully populated instance with an error banner over
it, or the mirror image. `#5024`'s own body flagged this as the reason it did not attempt the predicate:
"A per-instance scope would need a paired change to both endpoints (the frontend's
`ApprovalDetailView.vue` loads detail + history together, under one identity)". G-S1-5 is the pairing
gate.

`#5024` also recorded a second pairing hazard this lock must not inherit: `getApprovalHistory` skips the
`refreshPlmInstance` step that `getApproval` performs on the PLM branch
(`ApprovalBridgeService.ts:659-668`), "so a mirror-keyed predicate would deny a legitimate PLM approver on
one door and not the other." OD-S1-9's org anchor is **instance-keyed, not mirror-keyed**, which avoids
that specific trap — but only if OD-S1-9(c) resolves, which is why G-S1-4 exists.

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

### 2.10 Migration table — every construct, and its declared behaviour delta

| Construct | Action | Behaviour delta on migration | Gate |
|---|---|---|---|
| C-1 `isInstanceParticipant` | **replaced by** `canReadApprovalInstance`; call sites `approval-attachment-storage.ts:275` and `routes/approval-attachments.ts:406` re-point; the `orgId` parameter leaves the signature (the predicate derives it) | widens on zero-attachment instances (F-1 fixed); unobservable at the two shipped routes | G-S1-1, G-S1-2 |
| C-2 metrics ACL | **replaced**; the inline SQL at `approval-metrics.ts:193-215` deleted, `isAdminActor` (`:32-42`) deleted or reduced to non-authorization use | **widens** by the CC arm (OD-S1-7, absent from C-2); **narrows** by the DB-backed admin arm (OD-S1-8) and by the org pin (C-2 has none) | G-S1-7 |
| C-3 `listApprovals` tabs | **kept as a feed filter**; not rewritten in this slice | none | G-S1-8 (subset direction only) |
| C-4 pending / pending-count | **kept as a feed filter** | none | G-S1-8 |
| C-5 `GET /api/approvals/:id` | **gains** S1 (it had nothing) | **narrows**: non-participant `approvals:read` holders go 200 -> 404 | OD-S1-12, G-S1-5 |
| `GET /api/approvals/:id/history` | **gains** S1 as leg-2 | same narrowing, in lockstep with C-5 | G-S1-5 |

Routes deliberately **out of scope**, derived by enumerating the `/api/approvals/:id*` family at the
baseline rather than asserted: `POST /:id/mark-read` (`:1543`), `POST /:id/remind` (`:1697`),
`POST /:id/jump` (`:1887`, `approvals:admin`), `POST /:id/actions` (`:2101`), `POST /:id/approve`
(`:2252`), `POST /:id/reject` (`:2402`). The last four are **act/write** surfaces already gated by the
act-side seat check (`ApprovalProductService.ts:9091-9092`), which is Lock-7's authorization and is not
touched here. `POST /:id/mark-read` and `POST /:id/remind` carry `rbacGuard('approvals','read')` and are
write-shaped reads; they are listed as **a known residual, NOT as cleared** — a reminder is a
notification channel into an instance's participants, and a non-participant can currently trigger one.
Escalated in §5.2 (ii).

### 2.11 Lock-9 interaction (PR #5011, OPEN)

Lock-9's L9-C (OD-L9-4, OD-L9-13) reuses `isInstanceParticipant` **without modification**, and cites
Lock-7's D-4 as the reason it does not write its own. Its rationale observes that the attachment-EXISTS
org pin "is self-satisfied by the process row itself once bound, so an instance carrying only process
attachments still resolves participants correctly with no change" to the predicate.

Rulings:
1. **S1 replaces, it does not add.** After OD-S1-10, `isInstanceParticipant` no longer exists as a
   separate function; Lock-9's consumers call `canReadApprovalInstance`. Lock-9's D-4 citation therefore
   continues to resolve — there is still exactly one predicate — but it resolves to a different function.
   This is the difference between closing D-4 and quietly reopening it.
2. **One Lock-9 sentence goes stale on ratification of this lock**: the "self-satisfied by the process
   row" rationale, because the pin it reasons about is gone. The *conclusion* (no change needed to the
   predicate for process attachments) survives and gets stronger — an instance-level org pin cannot be
   defeated by attachment binding state at all. The sentence must be edited in Lock-9, not left standing
   as a live mechanism claim.
3. **Sequencing.** Lock-9 is OPEN at this baseline. Whichever ratifies first, the other rebases: if
   Lock-9 ratifies first, this lock's §2.10 C-1 row gains Lock-9's two new call sites; if this lock
   ratifies first, Lock-9's L9-C text is amended per (2) before its own merge. Neither may assume the
   other landed. This is an **adoption note**, not authorization to edit Lock-9's ODs.

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
| G-S1-1 | **Zero-attachment instance is readable by its requester** — the exact case C-1 fails (F-1). Real DB, an instance with **no** `approval_attachments` row | `canReadApprovalInstance(db, requesterId, instanceId)` === `true` | a same-org non-participant on the SAME instance === `false`. **Mutation target**: re-introduce the `EXISTS (... att.org_id = $4)` conjunct (`approval-attachment-runtime.ts:219-222`) into the new predicate and confirm **this gate, and only this gate, reds** — if other gates also red the fixture is not isolating F-1; if none red the gate has no teeth |
| G-S1-2 | **The C-1 widening is unobservable at the shipped attachment routes** | download + refs still 200 for a participant on an attachment-bearing instance | the same routes still deny a non-participant with the SAME status code and the SAME error envelope as before the change, asserted by equality on both |
| G-S1-3 | **NULL-org fails closed** (reachable only under OD-S1-9(c-ii)) | an instance with `org_id` set is readable by its requester | the same instance with `org_id` NULL is `false` for requester, seat-holder, past actor, CC target, **and DB admin** — all five asserted, not one |
| G-S1-4 | **PLM-mirrored instance is still readable by its legitimate approver** — the gate that keeps G-S1-3 from being vacuous | a `plm:`-prefixed instance with a real user-typed seat: that user === `true`, and `GET /api/approvals/:id` + `/history` both 200 | a principal holding `plm:source-owned` **as a permission code** and nothing else === `false` (proves OD-S1-5's exclusion is load-bearing, per F-2) |
| G-S1-5 | **Detail/history pairing** — for one identity and one instance the two routes return the SAME admission outcome | participant: detail 200 **and** history 200 | non-participant: detail 404 **and** history 404, asserted **as a pair inside one test** so a one-sided adoption cannot pass. Mutation: remove S1 from `approval-history.ts` only -> this gate reds while every single-route gate stays green |
| G-S1-6 | **`policy_denied` cannot be self-minted** (the OD-S1-6 coupling). Mechanical, not a spot check: iterate the exported `ACTION_POLICY_KEYS` (`types/approval-product.ts:374-384`) and assert that every key with a **non-null** policy value is subject to the `APPROVAL_ASSIGNMENT_REQUIRED` gate | a seat-holder refused by node policy writes a `policy_denied` row and still reads the instance | a non-participant attempting each seat-gate-exempt verb writes **no** `approval_records` row (asserted by row count on that instance before and after) and remains `false`. Mutation: flip `ACTION_POLICY_KEYS.revoke` to a non-null key -> the enumeration must red |
| G-S1-7 | **Metrics migration deltas, both directions** | a CC-only viewer, previously denied by C-2, now reads instance metrics (the declared widening) | a principal with `role: 'admin'` **in the JWT only** and no matching `users` row is now **denied**, asserted as an equality on the 403 body — and the SAME principal WITH a `users` row is allowed, so the test discriminates the DB read from the claim |
| G-S1-8 | **Feed ⊆ admission** (OD-S1-2). Over a fixture spanning all five tabs and several identities, every `(viewer, instanceId)` pair returned by `listApprovals` satisfies `canReadApprovalInstance` | a participant's tabs return their instances unchanged (no silently-empty inbox) | a constructed row the tab SQL returns but S1 denies makes the gate red — this negative must be **constructed and observed red**, because the known-wider external-source arm (§5.2 (i)) means the gate is expected to fail until that residual is ruled. Shipping it green without having seen it red is `feedback_ineffective_mutation_looks_like_a_useless_test` |
| G-S1-9 | **Mention-notify seam defaults CLOSED** (OD-S1-15) | with the checker wired, a participant mentioned on an instance receives the notification | constructing the service **without** calling the setter notifies **nobody** — asserted as zero deliveries, not as "no error thrown". Mutation: change the field initializer to `async () => true` (mirroring `CommentService.ts:186`) -> this gate must red |
| G-S1-10 | **Cross-org denial** | requester reads their own instance | the same principal id, present as a stale seat on **another org's** instance, is denied on that instance across all six migrated surfaces (detail, history, metrics, download, refs, comments) — enumerated, not sampled |
| G-S1-11 | **Monotonic membership** (OD-S1-4) | an approver whose seat is now `is_active = FALSE` still reads the instance (200 on detail and history) | a user who never held a seat on that instance is denied in the SAME fixture, so the gate distinguishes "seat ever existed" from "any row exists in `approval_assignments`" |
| G-S1-12 | **Migration is org-default-free** (OD-S1-9(a)) | after migration, `information_schema.columns` reports `column_default IS NULL` for `approval_instances.org_id`, and `is_nullable = 'NO'` (or the CHECK form of (c-ii)) | a mutation adding `DEFAULT 'default'` to the migration reds this gate — mechanically, per `feedback_absolute_claim_sweep_must_be_mechanical` |

**Gate hygiene binding on the implementing slices:** mutation restores use a sha256-verified `cp` from a
file backup, never `git checkout -- <file>` in any form (`feedback_never_git_checkout_dot`); each mutation
must be shown to have actually changed the file and to red the **named execution point** rather than a
same-named declaration (`feedback_ineffective_mutation_looks_like_a_useless_test`); and real-DB suites
follow the two-point wiring rule — excluded from the no-DB vitest config **and** wired into a CI lane
(`feedback_realdb_test_two_point_wiring`), since a suite that exists but sits in no lane is
`feedback_triggered_is_not_verified`.

---

## 4. Ratification

*(BLANK — to be completed by the owner. Nothing in §0 constitutes ratification of this document:
「按建议执行」 was answered to the enumerated list reproduced in §0, which contained the D-arm decisions
and did NOT contain this lock's ODs, its backfill ruling (OD-S1-9(c)), or the detail-route contract
narrowing (OD-S1-12). Per `feedback_authorization_source_must_be_owner_authored`, the executing session
does not write into this section.)*

**Status on ratification:** DRAFT -> RATIFIED, plus the §5.3 propagation edits.

---

## 5. Open owner decisions and declared residuals

### 5.1 Blocking owner decisions

| # | Decision | Why it cannot be derived | Blocks |
|---|---|---|---|
| OD-S1-9(c) | Backfill/anchor for bridge + PLM instances (`template_id IS NULL`, non-platform `source_system`): (c-i) named platform org / (c-ii) nullable-for-bridge with CHECK / (c-iii) exclude bridge rows from S1's consumers in v1 | `upsertPlmMirror` (`ApprovalBridgeService.ts:1106-1195`) stamps no org and derives none; `plm:` ids carry no tenant. There is no repository fact to read | the migration, and therefore every consumer |
| OD-S1-12 | Ratify the detail-route contract narrowing (200 -> 404 for non-participant `approvals:read` holders) | it is a public behaviour change; the house rule is ratify-first | consumer (b) |
| OD-S1-8(d) | Keep or drop the admin bypass arm | product judgement about the admin surfaces (`/jump`, `/admin/reassign`), not a code fact | the predicate's arm list |
| §5.2 (i) | The external-source feed arm (below) | it is shipped product behaviour, not a bug with an obvious fix | G-S1-8 can be written but is expected red until ruled |

### 5.2 Declared residuals — NOT closed by this document

(i) **C-3's external-source arm is WIDER than S1, in the direction OD-S1-2 forbids.** In the
`includeExternalTabSources` branch, the `pending` tab admits `COALESCE(source_system,'platform') <>
'platform' AND status = 'pending'` with **no actor predicate at all**
(`ApprovalBridgeService.ts:421-424`), and `completed` does the same for `status <> 'pending'`
(`:470-473`). Any caller of that branch sees every external instance. This is stated as an open conflict
between a shipped feed and the admission rule this lock introduces; it is **not** ruled here, because
narrowing it changes what a shipped inbox shows.

(ii) **`POST /:id/mark-read` (`:1543`) and `POST /:id/remind` (`:1697`)** carry only
`rbacGuard('approvals','read')` and no participant predicate. `/remind` is a notification channel into an
instance's participants. Listed as a residual, explicitly **not** cleared.

(iii) **This document asserts nothing about surfaces it did not enumerate.** The `/api/approvals/:id*`
family was enumerated mechanically at the baseline (§2.10) and the metrics family from its own router
(`approval-metrics.ts:63-161`). Per `feedback_empty_read_is_not_absence`, a grep that returned nothing is
reported as "this scan did not surface X", never as "X does not exist" — and no claim is made about
plugin packages, `apps/web` route guards, or any surface outside those two enumerations.

### 5.3 Propagation required at ratification (required edits, not side effects)

- `approval-lock7-field-edit-enforcement-20260817.md:344` (the D-5 row), `:395`, and `:503` all say D-5 is
  OPEN. They become stale and must be edited to cite this lock, in the ratification PR — per
  `feedback_gate_verdict_is_head_scoped` and the house rule that a retraction must propagate to every
  place the superseded claim was made.
- `approval-lock9-handler-process-attachments-20260819.md` (PR #5011) L9-C — the "self-satisfied by the
  process row" rationale sentence (§2.11 ruling 2).
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

**M11 — evidence language is scoped** (`:247-250`). Discharged as follows:

- Every anchor was read at `c473a079b5ff6389b98f4919bb88607a0baa913b` and is qualified by that baseline.
- Lock-9 is described as **OPEN (PR #5011)**, not ratified, and #5050 as **OPEN**, not landed —
  including in the places where their content is relied on.
- F-1 is labelled an executed-probe fact; F-2's grant-side emptiness is labelled a grep result at this
  baseline, not a proof of absence.
- No gate in §3 is reported as passing: none has been run. §3 specifies gates, and this document contains
  **no verification claim of any kind**.
- The owner's authorization is scoped in §0 to the enumerated list it answered, and §4 records explicitly
  what it does **not** cover.

# Lock-2 — Organization Form Controls, Field-Derived Assignees, and Department Routing (2026-08-17)

**Status:** PROPOSED — NOT RATIFIED. This document authorizes nothing; §4 is blank until an explicit owner
decision names it and its SHA.
**Baseline:** `origin/main@a4ee60d290b10b859b42f7a9e453c80cfe08660e`. Every anchor below was READ AT THIS
BASELINE, newer than every parent (master pins `d33a6a0fa1`, Lock-0 `5b31cb4349`, Lock-1 `0e8ed11671`,
Lock-3 `2f4bf6ce3e`) — line numbers are exact here and may differ from those documents'.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-2 row and §P2 (the binding
scope), M4, M5, M8, M11, UI-2 — this is that row's draft.
`approval-lock1-enterprise-assignees-20260817.md` (RATIFIED, on main) — its §2.1-§2.6 invariants govern the
three kinds below **by inheritance and are not re-derived here** (freeze-at-create and resolver purity;
unimplemented-is-fail-closed; registry rows; compile-forced fingerprints; five mirror sites, including the
§2.5(5) `assigneeSource.ts:29` `JSON.stringify` leak these kinds must not inherit; empty resolution,
values-free errors, `resolvedFrom`). Its K4 supplies the department-parent-tree walker these kinds re-anchor;
its K5 level semantics and **OD-L1-6** (downward `最高-n` blocked on chain completeness) are cited, never
re-owned. Also Lock-0 L0-2 registry and Lock-3 R-10/R-14 (both RATIFIED, on main — the silent-skip class
extended here on a second axis); the S7 resolver lock (RATIFIED), unimplemented fails closed 422 at
authoring AND runtime; and `approval-canvas-v2-interaction-design-lock-20260721.md` §10.2, typed pickers
with no raw IDs.
**Conditional parent (NOT on main — every citation is conditional):** `approval-lock8-field-vocabulary-20260817.md`
(PROPOSED, branch `docs/approval-lock8-field-vocabulary-20260817` @ `cbf1014a65`) — §0.3 MS-1…MS-13 census,
invariant 2.4 (no print flag), invariant 2.5 (restore re-validation), **OD-L8-6** carrier precedent. Lock-8
excludes these controls by the master's own definition of its row (*"excluding department/contact"*) and
restates they *"are Lock-2's and are not narrowed here"*; every argument below also stands on shipped
anchors, so this document is ratifiable whether or not Lock-8 lands.
**Non-effects:** no runtime code, migration, flag change, tenant UAT, deployment, or completion label; each
contract still needs its own PR, required checks, adversarial gate, and ledger row. `readonly`/`editable`
enforcement is Lock-7; dedup/fallback/same-person policy is Lock-4; the handler node is Lock-3;
`continuous_dept_heads` and `dept_head_at_level` are Lock-1's K4/K5-b.

## 0. Corpus evidence, and two inherited readings this document corrects

Corpus = the offline Feishu administrator handbook (`feishu/6933484342190538780.txt`), section boundaries
derived from the file's own `## ` headers, never a fixed-width slice. Master M11 governs the language.

| # | Corpus evidence | Lines | Disposition |
|---|---|---|---|
| C-1 | `## 部门`: 可选数量 单/多, 展示设置, 默认值设置 (申请人部门 / 指定部门, 支持发起时修改), 打印, 必填 | 1010-1062 | L2-A |
| C-2 | `## 联系人`: 选择范围 可选自己 / 可选多人 (**默认均未勾选**, 1091), 默认值设置 (申请人 / 指定人员), 打印, 必填 | 1063-1111 | L2-B |
| C-3 | 表单内联系人 as approver: 联系人自己 / 联系人上级 / 联系人部门负责人, 可指定层级 | 1655-1663 | L2-C |
| C-4 | 表单内部门 as approver → 部门负责人, 可以指定部门负责人层级 | 1665-1670 | L2-C |
| C-5 | requester-keyed 上级 / 部门负责人 spell out 向上加 n / 向下减 n; the form-field rows say only 可指定层级 | 1584-1597 | Lock-1 K5 |
| C-6 | same roster on 办理节点 (1973, 1982); on 抄送节点 the 表单内部门 row admits 部门负责人 **and 直属部门成员** | 1973-1986, 1886-1891 | §2.4 |
| C-7 | *"只有当表单设计中添加了部门控件后，才可以设置此项"*, stated three times | 1661/1668, 1979/1985, 1882/1890 | §2.4 |

**Correction 1 — 展示设置 is a display format, not a selection predicate.** C-1 lines 1039-1044 read
*"设置部门信息的展示格式"*: 末级 name only versus the full hierarchy path. Reading it as leaf-only *selection*
would invent a validation the corpus does not evidence and reject legitimate mid-tree choices; it maps onto
the shipped `directory_departments.full_path` column, not onto a predicate.

**Correction 2 — the design is not unbuildable; submit IS create.** `createApproval` receives
`request.formData` on the same call that freezes `form_snapshot` (`ApprovalProductService.ts:4686`,
persisted `:5204-5216`), so the chosen department or contact is known before any org read and before any
insert. No live directory read at dispatch is needed and Lock-1 §2.1 resolver purity survives intact; the
only requirement is intra-create **ordering** (§2.1).

## 1. Contracts

### L2-A — the `department` form field type

`FormFieldType` gains a twelfth member `'department'`. There is no existing carrier in the shipped eleven
(`types/approval-product.ts:59-71`; FE hand-copy `apps/web/src/types/approval.ts:35-47`, member-for-member
identical, no shared package), so the new-member presumption is discharged on its face and Lock-2 pays every
site Lock-8 §0.3 enumerates. The runtime admission set `FORM_FIELD_TYPES` (`:431`, consumed `:782`) is a
plain `Set<string>` with no type link to the union: a third hand copy, not a compiler consequence.

**Value shape (OD-L2-1).** On the wire, `Array<{ id: string }>` where `id` is the LOCAL surrogate
`directory_departments.id` (uuid PK, migration `zzzz20260324150000_create_directory_sync_tables.ts:44`), one
element under `single`. Local-versus-external turns on durability under re-sync, and that is settled: the
sync writer UPSERTs `ON CONFLICT (integration_id, external_department_id)`
(`directory/directory-sync.ts:3930-3935`) against the unique index at migration `:59-62`, so an unchanged
department's surrogate id **survives every re-sync**, and the uuid is globally unique so it identifies
`(integration, external department)` without the client ever seeing a provider or integration id. The frozen
shape is a separate decision: after validation the server canonicalizes into the snapshot as
`Array<{ id, name, fullPath }>`, appending the display fields it just read and **dropping every
client-supplied key**, exactly as `canonicalizeRecordLinkFormData` (`:4713`) and the record-link normalizer
(`:836`) do — so display and print read the frozen name and a rename or delete cannot retro-edit history.

**Props (typed allowlist).** `{ selection: 'single' | 'multi'; display: 'leaf_only' | 'full_path';
defaultMode?: 'requester_department' | 'designated'; defaultDepartmentIds?: string[];
maxSelections?: number }`. `display` is C-1's 展示设置 per Correction 1. `defaultMode` is C-1's 默认值设置 and
is a **client prefill only** — the value still travels in the payload and is validated identically, because a
server-side injection would let a required-field pin be satisfied by a value nobody chose. **No `print`
flag** is authored although C-1 lines 1055-1057 carry 打印: Lock-8 invariant 2.4 records that no shipped
runtime reads one, and a switch nothing reads is master M8 theater.

**Submit-time validation closes a fail-open.** `validateFieldType` (`ApprovalGraphExecutor.ts:412-413`) ends
`default: return null` and `validateFieldConstraints` (`:552-553`) ends `default: return []`, so a new member
is **auto-admitted with no value validation whatsoever**. The slice adds an explicit `case 'department'`
structural parse in the `record-link` mould (`parseRecordLinkFormValue`, defined `:422-431` and called from the
`case 'record-link'` arm at `:403-411`): an array of `{ id }` objects, non-blank, no duplicates, no extra keys,
length 1 under `single`, ≤ `maxSelections` under `multi`.

**Existence and corp scoping is async, and needs an anchor the create path lacks (OD-L2-8).**
`directory_departments` carries **no `org_id` and no `corp_id`** (migration `:44-57`); tenancy is transitive
through `integration_id` → `directory_integrations.org_id` (`:16`) and the corp is
`directory_integrations.corp_id` (`:20`), so the only sound scoping key is an **integration id**. The gap:
the kernel create path calls `resolveApprovalRequesterOrgRelations` with **no `orgId`** (`:4794` passes only
`{ includeManagerChain }`), and absent a policy row the resolver falls through to a legacy
`ORDER BY a.updated_at DESC … LIMIT 1` pick. Locked: the check reuses the SAME canonical integration that
produced this create's org relations (`org_directory_routing_policy`, `ApprovalDirectoryOrg.ts:263-322`),
surfaced in the creation context — never a second, independently derived notion of "the requester's org". A
new `assertDepartmentsResolvableAtSubmit` runs in the `assertRecordLinksReadableAtSubmit` band (`:4725-4737`);
each id must resolve to an `is_active` row under that integration; "not found" and "outside your org" share
ONE values-free failure shape, so the surface is not an existence oracle (`:4715-4718`).

**Detail-leaf exclusion is a positive edit in the same commit, and the two sides disagree in direction.**
Backend `DETAIL_LEAF_FIELD_TYPES` (`:450-452`) is DERIVED — `[...FORM_FIELD_TYPES].filter((type) => type !==
'detail' && type !== 'record-link')`, consumed as an allow-list at `:892-894` — so `'department'` becomes a
legal detail sub-column the moment it joins the union, with no code change and no failing test; both
constants are module-private and pinned by **zero** backend tests. Frontend
`apps/web/src/approvals/detailField.ts:25-33` is an explicit eight-member literal pinned by
`apps/web/tests/approval-detail-field.test.ts:50-58`, so the member is silently OMITTED there. Locked:
`'department'` is excluded from detail in v1 (N row-values are ambiguous for routing and display), the
backend exclusion lands in the same commit as the union member, and the FE literal keeps its exact-set
assertion.

**The department picker.** `ApprovalDepartmentPicker`: directory-backed search plus tree browse, emitting
only opaque local uuids and displaying `name` or `fullPath` per `display`. Nothing is reusable — no
department picker exists in the repo, and both existing department LIST endpoints are `ensurePlatformAdmin`
with `GET /api/admin/role-delegation/departments` (`routes/admin-users.ts:2130`) returning `corp_id` and
`external_department_id` to the client. The new endpoint sits on the `approval-directory.ts` seam but **must
not copy Lock-1 §2.5's guard**: Lock-1's group picker is template-admin because authoring is admin-time,
whereas this one serves the **submitter at fill time**, so its guard is the participant-directory guard
(`routes/approvals.ts:66`, `:788` precedent). It derives the integration from the caller's own resolved
policy and accepts **no org or integration parameter at all**, returning
`{ id, name, fullPath, parentId?, hasChildren }`.

### L2-B — the contact control is the shipped `user` type, enhanced by props

The shipped `user` FormFieldType **is** C-2's 联系人 control (*"用于搜索并选择组织内成员"*) and
`ApprovalUserPicker` is its person picker, so Lock-2 adds properties to `user` and mints no new member. This
follows Lock-8 OD-L8-6(a) — props on an existing type leave the whole MS census *unreachable rather than
merely handled* — but does not depend on it: `FormField.props?: Record<string, unknown>` already exists
(`types/approval-product.ts:287`) and the record-link arm (`:816-836`) is the shipped worked precedent for a
strict per-type props allowlist. (Lock-8 §0.2 forbids re-citing the FWB type-compatibility ripple in either
direction; no argument here uses it.)

**Props, and the narrowing they require.** `{ allowSelf?: boolean; selection?: 'single' | 'multi';
defaultMode?: 'requester' | 'designated'; defaultUserIds?: string[] }`. C-2 line 1091 fixes the defaults —
默认均未勾选 — so absent `allowSelf` ≡ `false` and absent `selection` ≡ `'single'`; absent ≡ today's behavior,
so every shipped template stays byte-stable. `allowSelf: false` is a **server-side** check, not picker
chrome, since a client can post its own id whatever the picker offers; needing the requester's identity it
sits in the async band beside the department check. The cost that makes this an owner enum: today
`normalizeFormField` carries props for every non-record-link type as a shallow spread of arbitrary client
keys — `props: { ...value.props }` (`:857-861`), validated only as `isRecord` — so props round-trip but are
**unvalidated free text**, and a props-carried semantic is unenforceable until `user` gets an allowlist.
Adding one NARROWS a shipped type: `assertFormSchema` runs on save, on publish, and on
`restoreTemplateVersion` (`:3654`), so a persisted `user` field carrying any unlisted prop would newly fail
all three. Locked mitigation: the slice runs a mechanical census of persisted `user` props before the
allowlist lands, and a non-empty census escalates.

**The L2-B × L2-C interaction, correctly classified.** `resolveFormUserValue`
(`ApprovalAssigneeResolver.ts:44-51`) is single-valued — a string id or `{ id }` — and an **array yields
`null`** because its `isRecord` excludes arrays. That drop is **latent, not live** today:
`validateApprovalFormData`'s `user` arm (`ApprovalGraphExecutor.ts:351-355`) rejects an array with a 400
before resolution is reached, so a multi-valued contact field is unsubmittable at this baseline. It becomes
LIVE in the same slice that widens that arm for `selection: 'multi'` — the field then resolves to NOBODY,
falls to `emptyAssigneePolicy`, and under an author-selected `'auto-approve'` auto-approves silently. The two
halves sit in different files with nothing linking them, which is why the sequencing is locked rather than
left to the implementer (OD-L2-7).

### L2-C — field-derived assignee kinds

Three kinds, each `{ kind; fieldId: string; level: number }`:

| Kind | Corpus | Anchor | Pointer |
|---|---|---|---|
| `form_field_dept_head` | C-4 | a department chosen in a `department` field | department parent tree (`external_parent_department_id`), reading `raw.dept_manager_userid_list` per level |
| `form_field_user_manager` | C-3 联系人上级 | a person chosen in a `user` field | the `leader_in_dept` leader pointer (`findDeptLeaderHop`, `ApprovalDirectoryOrg.ts:525`) |
| `form_field_user_dept_head` | C-3 联系人部门负责人 | a person chosen in a `user` field | that person's primary department, then the parent tree |

C-3's third option, 联系人自己, is the **shipped `form_field_user`** and gets no new kind.

**Field-anchored, not requester-anchored — that is the whole boundary with Lock-1.** Lock-1 K4/K5-b address
the same two pointers and its §K4 establishes they are genuinely different pointers on different trees; what
differs here is only the **anchor**. Stated precisely so no reader infers a shipped walker:
`external_parent_department_id` is referenced **nowhere** in `ApprovalDirectoryOrg.ts` at this baseline, and no
reusable **upward/ancestor** walker over that column exists anywhere — the recursive traversals that do exist
walk DESCENDANTS for role-delegation scoping (`routes/admin-users.ts:1477`, `:1532`, `:1631`) or serve the
`provider='local'` directory CRUD subsystem (`directory/local-directory-org.ts:109-114`, `:311+`); none is an
ancestor walk and none is on an approval-routing path. The parent-tree walker is therefore Lock-1 K4's to
BUILD, this document re-anchors it to take an anchor department rather than deriving one from the requester,
and `form_field_dept_head` is sequenced after K4 rather than duplicating it. **Lock-1 §K4's empty-level
posture is RATIFIED and binds that walker and this document's re-anchored use of it:** a level whose manager
list is empty or resolves to no linked user contributes nothing and the walk CONTINUES upward. That is
buildable on the parent tree precisely because the next level comes from the structural parent pointer rather
than from the current level's occupants (§4 records one citation imprecision in Lock-1's supporting precedent;
it changes no behavior and re-opens nothing). The multi-head
"primary" rule is inherited byte-identically from shipped `dept_head` (*first external id in `raw` order,
excluding the requester, that resolves to a LINKED local user*, `:466-478`) via Lock-1 K4 and is not
re-specified. `dept_manager_userid_list` is a key inside the department's `raw` JSONB, not a column, and
`parseDeptManagerExternalIds` (`:137-147`) accepts both spellings (`:139`).

**Levels.** `level` is validated `[1, MAX_MANAGER_CHAIN_LEVELS]` at the authoring choke exactly as the shipped
kinds are (`ApprovalProductService.ts:616-631`, explicit `failValidation` and "never silently defaulted"; the
constant is `ApprovalDirectoryOrg.ts:101`, default 10 at `:76`) — never coerced, never defaulted;
`level: 1` is the chosen anchor's own manager or listed head. **Upward only in v1**: per C-5 the corpus
spells out 向上加 n / 向下减 n for the requester-keyed kinds but says only 可指定层级 for the form-field rows,
which per M11 is absence of evidence about direction, not evidence of unidirectionality — and Lock-1 OD-L1-6
already blocks the downward variant on chain-completeness grounds, inherited not re-owned.

**Snapshot.** A new opt-in `fieldDerivedAssigneeIds?: Record<string, string[]>` keyed by the source
fingerprint (§2.5), so identical sources share one entry and resolution is a pure map lookup. It is NOT
`deptHeadChainIds`, which is requester-keyed and a bare `string[]`. Populated only for sources the published
runtime graph references — the `includeManagerChain` posture (`ApprovalDirectoryOrg.ts:493`, gate `:4783`) —
so unrelated approvals pay nothing and the resolver adds no database call (Lock-1 §2.1).

**Publish pins, and the hole they close.** `validateApprovalAssigneeSourcesAgainstFormSchema` (`:648-671`,
six call sites incl. publish `:3721` and restore `:3656`) is the cross-validator, and its loop `continue`s on
every kind except `form_field_user` (`:661`) — so all three new kinds would be **silently unvalidated**. This
is the kind-axis twin of Lock-3 R-10's node-type axis on the same function. Each kind pins at publish: (1)
the field exists and is **TOP-LEVEL only**, inheriting `:653-655`'s stated reason verbatim (a sub-field has N
row-values and is ambiguous as a single approver); (2) the field's type is `department` or `user` as the kind
requires; (3) **`required: true`**; (4) the field carries **no `visibilityRule`**; (5) `level` in range; (6)
for `user` fields, `selection` is not `'multi'` until OD-L2-7 resolves.

**Pin (3) alone closes nothing, and this document's own baseline reading is why.** `validateApprovalFormData`
(`ApprovalGraphExecutor.ts:622-632`) computes `visibleFieldIds` and `continue`s on every field not in it, so
`field.required` is enforced for VISIBLE fields only — a `required: true` field hidden by its
`visibilityRule` is skipped, is pruned from the payload by `pruneHiddenFormData` (`:265-269`), yields no
value, and falls to `emptyAssigneePolicy`. Pin (4) makes the pair provably sufficient: `:230-233` returns
visible `true` for any field with no `visibilityRule`, which also makes it immune to the subtler attack —
visibility is evaluated twice, on the raw payload inside `pruneHiddenFormData` and again on the pruned
payload inside `validateApprovalFormData`, and pruning a controlling value can flip a dependent field between
passes, but a field with no rule is visible in both passes regardless of data. **Severity, honestly:**
`emptyAssigneePolicy` absent ≡ `'error'` and both executor arms test `=== 'auto-approve'` (`:1019-1035`,
`:1311-1327`), so the silent-approval outcome requires an author to have opted in; the wrong-approver and
no-approver outcomes do not. **Provenance:** Lock-1 does not address this — its §K2 is `requester_choice`, and
neither its K-sections nor its §2 mention `form_field_user` or a required pin. The hole is this document's
finding **relative to the lock lineage**, not an absolute first sighting: the 2026-08-16 corpus digest (a
scratchpad working note, not a lock) already recorded *"form_field_user 无 required pin(静默空洞)"*. What is
new here is that no ratified document owns it; the retrofit is OD-L2-4.

**Empty, unresolvable, and failed reads are three different things.** Value ABSENT is made impossible by pins
(3)+(4) and additionally rejected by the independent create-time door in §2.2. Value PRESENT but resolving
to nobody — an empty `dept_manager_userid_list`, no external id resolving to a linked local user, a chain
shorter than `level`, a chosen contact with no directory account — is EMPTY resolution falling to
`emptyAssigneePolicy` per Lock-1 §2.6, unchanged. A directory READ FAILURE is neither, and is fail-closed by
the new wedge in §2.3.

**Multi-value: UNION, capped at publish (OD-L2-3).** A multi-select department or contact field contributes
every resolved principal with the node's `approvalMode` governing aggregation — what every shipped
multi-valued source already does, whereas "first only" would invent a selection rule no shipped kind has.
The union is unbounded today: `resolveApprovalAssignees` (`ApprovalAssigneeResolver.ts:92-243`) dedups inside
`pushResolved` but caps nothing anywhere, so a fifty-department selection becomes fifty 会签 seats. The bound
belongs at publish, as a pin that the referenced field declares `maxSelections`. Runtime **truncation is
inadmissible**: silently dropping approvers is the silent-wrong-approver class this program exists to close.

**Corp scoping negatives.** The chosen department resolves only under the create's canonical integration
(L2-A); the chosen contact's org relations resolve under the SAME anchor and never globally, so a contact
linked in more than one policy-governed org raises the shipped `ApprovalRoutingPolicyError` and surfaces as
422 `APPROVAL_ROUTING_POLICY_MISCONFIGURED`. Self-exclusion is deliberately NOT applied to field-derived
resolution — shipped `dept_head`'s inline requester-exclusion (`:471`) is a requester-anchored artifact —
and the same-person question composes through Lock-4's shipped `mergeWithRequester` surface.

## 2. Cross-cutting

**2.1 Create-time ordering, and where the transaction actually starts.** Verified at this baseline: form
validation, every directory read, and seat resolution all run **before `BEGIN`**; `assembleCreationContext`
(`:4620-4982`) is shared verbatim with route preview. In order: `pruneHiddenFormData` (`:4686`) →
`validateApprovalFormData` (`:4698`, where pin (3) becomes load-bearing) → **NEW** async department
existence/corp and `allowSelf` checks in the record-link authz band (`:4725-4737`) → **NEW** department
canonicalization beside `canonicalizeRecordLinkFormData` (`:4713`) → runtime graph (`:4765`) → requester org
read, on the pool rather than a transaction client (`:4794`) → **NEW** field-derived org reads under the new
detector → shipped wedges (`:4846`, `:4861`) and the **NEW** wedge → `requesterSnapshot` (`:4942-4959`) →
`resolveInitialState()` resolves seats (`:5132`) → `BEGIN` (`:5149`) → write-boundary re-checks
(`:5158-5199`) → `INSERT approval_instances` with `form_snapshot` (`:5204-5216`) → `insertAssignments`
(`:5276`) → `COMMIT` (`:5324`). Locked: **org reads never precede payload validation**, because reading the
directory for unvalidated client ids is both a wasted read and an enumeration surface; the write-boundary
re-checks deliberately re-verify only record-link readability, template visibility and `approvals:write`,
**not** org relations or seats; and every failure in the band leaves zero instance and zero assignment rows.

**2.2 Two independent doors, tested independently.** Door 1 is the publish pin (3)+(4). Door 2 is a
create-time values-free 422, `APPROVAL_FORM_ROUTING_FIELD_EMPTY`, when a field-derived source's referenced
field is empty at create. Door 2 is not redundant: it survives any later widening of door 1, without which a
widened pin walks back into `emptyAssigneePolicy`. Because two fail-closed doors cover for each other, §3
neuters each separately and asserts the other still fails.

**2.3 Detector, wedge, and the coordination problem this document must name.** The three kinds need a NEW
detector, `runtimeGraphUsesFieldDerivedOrgSource`, with its own wedge and codes in the same pre-`BEGIN` band
— **not** an extension of `runtimeGraphUsesOrgAssigneeSource` (`:2922-2937`, sole call site `:4846`), which
gates whether the **requester's** relations are read: folding field-derived kinds into it makes every such
template pay a requester org read it does not need, while omitting them leaves `:4846`'s wedge uncovered for
the new reads. **Three locks now claim that one function on three axes with no shared helper:** Lock-3 R-14
(node type — LATENT here, since `ApprovalNodeType` has six members with no `handler`
(`types/approval-product.ts:13`) and `CcNodeConfig` (`:213-216`) carries no `assigneeSources`, so only
approval nodes carry sources today), Lock-1 §2.1/G-20 (kinds K4/K5-b), and this document (three new kinds) —
while `runtimeGraphUsesManagerChain` (`:2900-2910`) is already a second hand-maintained copy of the shape.
Locked: the kind disjunction becomes a set DERIVED from the capability registry with a mechanical exact-set
assertion, not a fourth hand-edited `||` chain; hand-maintained disjunctions in four places do not converge.
Whichever slice lands first performs that refactor; if none has, this document's slice does.

**2.4 Registry rows (Lock-0 L0-2), and the authoring cross-dependency.** Each row lands in the SAME commit as
its kind and the Lock-0 A-3 exact-set test grows with it.

| Registry row | Roster label | Node types | Admitted when |
|---|---|---|---|
| `form_field_dept_head` | 表单内部门负责人 | `approval`, `handler` | L2-A landed; K4 walker re-anchored; OD-L2-1/3/5/8 decided |
| `form_field_user_manager` | 表单内联系人上级 | `approval`, `handler` | publish pins + snapshot landed |
| `form_field_user_dept_head` | 表单内联系人部门负责人 | `approval`, `handler` | as above |

The `handler` rows are corpus-evidenced, not an M11 widening (C-6); Lock-3 §1.5's forward-row sentence names
only 表单内部门 although its own roster lists 表单内联系人, so the two contact-derived rows supply what fell
between the locks. **Cc rows are DEFERRED explicitly:** per C-6 the cc roster's 表单内部门 admits 部门负责人
**and 直属部门成员**, i.e. a fourth kind — department *members* — that the approval and handler variants do
not carry; giving cc the approval-node shape silently would narrow a corpus-evidenced capability, and
`CcNodeConfig` is a separate contract anyway (Lock-1 §K1 / OD-L1-7). Two further locks on this surface. First,
per C-7 each row gains a **form-schema precondition** so the source is not offered when the form declares no
eligible field — nothing on main gates the inspector affordance on schema contents, since
`validateApprovalAssigneeSourcesAgainstFormSchema` gates the *reference* at publish, a different predicate,
and that validator remains the enforcement because an affordance is not a boundary. Second, an inherited
hazard must be closed: `APPROVAL_ASSIGNEE_SOURCE_LABELS`
(`apps/web/src/approvals/approvalCapabilityRegistry.ts:24-33`) is a `Record` over the union and IS
compile-forced, but `SHIPPED_ASSIGNEE_SOURCE_KIND_ORDER` (`:38-47`) is a plain array that the label spec's
exact-equality assertion does not cover — so a ninth kind can be absent from the rendered roster with a green
build and a green suite.

**2.5 Fingerprints (Lock-1 §2.4, compile-forced both sides via the `_exhaustive: never` guards).**
`form_field_dept_head:<fieldId>:<level>`, `form_field_user_manager:<fieldId>:<level>`,
`form_field_user_dept_head:<fieldId>:<level>` — all provably identical for the same field and level, so
identical sources on parallel branches are publish-blocked, unlike K2's deliberate `null`.

**2.6 Transfer and audit.** A frozen seat transfers normally and is never re-resolved; `resolvedFrom` records
the ORIGINAL derivation and is not rewritten, and the transfer is an `approval_records` row, which master §7
makes the only history source. `resolvedFrom` (`types/approval-product.ts:179-183`) already carries optional
`fieldId`; it gains optional `level?: number` and `departmentId?: string`, so "why is this person an
approver" is answerable from the row alone. **The distinction that must not blur:** `resolvedFrom` is
assignment audit metadata and may carry the chosen department's id; ERROR messages may not, because Lock-1
§2.6's values-free rule names form values and a chosen department IS a form value.

**2.7 Mirror sites and restore.** Lock-1 §2.5's five sites govern the three kinds by inheritance; for the
field type, Lock-8 §0.3's MS-1…MS-13 census is cited rather than rebuilt (conditionally — not on main), and
if L8-A lands first its mechanical census gate is extended with a `department` row rather than replaced. Five
sites are named here regardless, each read at this baseline and each fail-open, asymmetric, or uncompiled:
`FORM_FIELD_TYPES` (`:431`); the two `DETAIL_LEAF_FIELD_TYPES` (§L2-A); the `validateFieldType` /
`validateFieldConstraints` fail-open defaults (§L2-A); and FE `AUTHORABLE_FIELD_TYPES`
(`templateAuthoring.ts:81-92`, ten members) **plus a second independent set** derived from `FIELD_LABELS`
(`approvalFormCommands.ts:134-136`) — missing either forces whole-template read-only, which is the shipped
forward-compat door, preserved rather than improved. Print and version-diff conventions are Lock-8's; the one
mechanism this document depends on is `restoreTemplateVersion` re-validating history against **today's**
contract (`:3651-3660`, calling `assertFormSchema` and `validateApprovalAssigneeSourcesAgainstFormSchema`).
Vocabulary may widen but must never narrow after a version is published with it — which is why the `user`
props allowlist (OD-L2-2) and the required-pin retrofit (OD-L2-4) are genuine owner forks: both are
narrowings, both would fail restore and re-save of an already-published version, and both leave in-flight
instances untouched because those execute the frozen runtime graph.

## 3. Acceptance gates

Master §P2 exit applies to every contract. Every absence assertion carries a positive control; every mutation
row names the test it turns red and asserts the anchor was actually hit.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| M-1 | Nothing inert, nothing leaked | every authored prop changes server-enforced behavior; no `print` carrier exists in any contract or payload; every new error path carries no person id, department name, or form value | the SAME tests prove `display` DOES change the canonicalized snapshot and that those error paths DO carry node key / field id / source index — neither check passes on an empty payload |
| A-1 | Value validation is not fail-open | a wrong-shaped `department` value (array of strings, extra keys, duplicate ids, over `maxSelections`, two ids under `single`) is rejected at create with zero rows | **deleting only the `case 'department'` arm** makes every one of those values ACCEPTED via `ApprovalGraphExecutor.ts:412-413` and reds a named test |
| A-2 | Detail-leaf exclusion, both sides | `department` is rejected as a `detail` column at publish; the FE literal is asserted by EXACT SET | two mutations: remove the backend exclusion at `:450-452` (the derived filter auto-admits it, and no backend test covers either constant today) and add `'department'` to `detailField.ts:25-33` — each reds a distinct named test |
| A-3 | Corp scoping, one shape, one anchor; no raw ids | a department id from another integration, an `is_active=false` row, and a non-existent uuid produce ONE identical values-free failure, anchored to the same canonical integration that produced this create's org relations; the fill-time endpoint accepts no org/integration parameter and returns no external or integration id | an in-scope active department submits in the same fixture and a second fixture in the other org resolves that org's tree — both directions asserted; and the admin catalog at `admin-users.ts:2130` DOES return `corp_id`/`external_department_id`, asserted as the shape NOT served here |
| B-1 | `allowSelf` is server-enforced | with `allowSelf` absent or `false`, a payload naming the requester is rejected at create even though the picker would not offer it | with `allowSelf: true` the same payload succeeds — enforcement is prop-selected |
| B-2 | Props allowlist and its census | an unlisted key on `user` props fails save, publish, and restore; the pre-landing census of persisted `user` props is recorded | the four listed keys survive all three paths — rejection is key-selected |
| B-3 | Multi-selection is not silently empty | a `selection: 'multi'` `user` field referenced by ANY assignee source is rejected at publish (or, post-OD-L2-7(b), resolves every chosen person) | one fixture pins the baseline classification — an array value is rejected 400 by `ApprovalGraphExecutor.ts:351-355` today — and a second reds when that arm is widened without extending `resolveFormUserValue` |
| C-1 | Publish pins, per kind | for EACH kind: dangling field, wrong field type, a detail sub-field, `level` out of range, and a non-`required` field each fail at publish | a fully compliant configuration of the SAME kind publishes — rejection is shape-selected, not blanket |
| C-2 | The required pin needs the visibility pin | a `required: true` field carrying a `visibilityRule` is rejected at publish; a fixture proves that WITHOUT pin (4) the hidden field is skipped at `ApprovalGraphExecutor.ts:625-627`, pruned, and reaches `emptyAssigneePolicy` | a `required: true` field with no rule publishes and its value is enforced at create — the pin pair is jointly load-bearing |
| C-3 | Door independence | neuter pin (3)+(4) only ⇒ the create-time 422 still fires with zero rows; neuter the create-time door only ⇒ publish still rejects | with BOTH intact a compliant template creates normally — neither door is dead code and neither covers for the other |
| C-4 | Pointer distinctness | in an org where `leader_in_dept` and `raw.dept_manager_userid_list` disagree, `form_field_user_manager` and `form_field_user_dept_head` resolve DIFFERENT people for the same chosen contact | a fixture where they agree resolves the same person — the test discriminates the pointer, not the label |
| C-5 | Field-anchored, not requester-anchored | the resolved approver derives from the CHOSEN department/contact and is unchanged when the requester's own department and manager are mutated | mutating the CHOSEN principal's relations before a NEW create DOES change the new instance — the anchor is the field |
| C-6 | Union, capped, never truncated | a multi-select field with N values yields N distinct seats with `approvalMode` governing; a selection exceeding `maxSelections` is rejected rather than truncated | assert the resolved count equals the distinct chosen count — no path silently reduces a resolved list |
| D-1 | Ordering | with an invalid payload AND a failing directory, the failure is the payload's and ZERO org reads occur, asserted by a query spy rather than by reading the source | with a valid payload the org read runs — the ordering is validation-first |
| D-2 | New wedge is fail-closed | directory read failed or routing policy misconfigured + a field-derived source present ⇒ 422/503 with zero instance and zero assignment rows | a graph whose only org-derived source is requester-anchored still fails via the shipped wedge, and a graph with NO org-derived source still creates |
| D-3 | Coverage is derived, not enumerated | the detector's kind set AND the roster order array are each asserted by exact set equality against the registry-derived set. **The set must first be proven DERIVED**: editing only the registry row — touching neither detector nor order array — must red the test. Without that arm the gate passes on three hand-maintained `||` chains that happen to agree, which is the count-style assertion its own text calls insufficient | four further mutations: drop a kind from the detector set, add an unrelated one, drop a kind from `SHIPPED_ASSIGNEE_SOURCE_KIND_ORDER`, and drop a registry row — each reds a named test |
| D-4 | Freeze is temporal; transfer preserves derivation | a directory change between node 1 and node 2 does not move an in-flight field-derived seat, and renaming then deleting a chosen department leaves an existing instance's rendered value byte-identical; a transfer DOES move the seat, keeping `resolvedFrom` | the same directory change and the same rename DO affect a NEWLY created approval — the freeze is temporal, not a dead read |
| D-5 | Audit answers the question | each field-derived assignment carries `resolvedFrom` with `kind`, `sourceIndex`, `fieldId`, `level`, and (department kinds) `departmentId` | the SAME slice's error messages carry no department id or name — audit and error surfaces asserted separately |
| D-6 | Affordance precondition (C-7) | the three sources are not offered by the inspector when the form declares no eligible field, and the publish validator still rejects a dangling reference posted directly | a form carrying the control DOES offer them — the affordance is schema-selected, and the validator is asserted independently of it |
| X-1 | Round-trip and restore | save → publish → preview → execute → version-compare → restore preserves every new prop and kind byte-for-byte; mutating one prop SHOWS in the diff | a pre-Lock-2 template corpus round-trips unchanged through the same path |
| X-2 | FE unknown-value safety | a persisted `department` field or new kind outside the FE registry leaves the template read-only and round-trips unchanged; no `JSON.stringify` fallback reaches any surface (Lock-1 §2.5(5)) | a registered kind renders editable with its typed summary — read-only is registry-selected |

## 4. Owner ratification block

Intentionally blank until an explicit owner decision names this document and its SHA.

```text
Decision: <RATIFY | REQUEST CHANGES | REJECT>
Owner:
Date:
Document SHA:
Independent review: independent adversarial review of head a30970af13 returned REQUEST-CHANGES with one
  P1 (this block's Lock-1 §K4 disposition), one P2 (OD-L2-8(a)'s omitted cost), one P3 and four NITs; it
  refuted no code claim and spot-verified 15 load-bearing claim groups against origin/main. All seven were
  applied in the fix round that produced this text. This field records the review only — the decision,
  owner, date, and SHA above remain blank for the owner.
Decisions required ([R] = this document's recommendation; rejected options carry their citation so
they are not re-proposed):

  OD-L2-1  L2-A value shape — (a)[R] local `directory_departments.id` uuid (sync UPSERTs on
           `(integration_id, external_department_id)`, `directory-sync.ts:3930-3935`, so it survives
           re-sync and exposes no provider id) · (b) the external pair [rejected §L2-A: provider ids on the
           client, contrary to D0 §10.2, no durability gain] · (c) `full_path` [rejected: renames repoint it]
  OD-L2-2  L2-B carrier — (a)[R] typed props allowlist on the SHIPPED `user` type, no new member (Lock-8
           OD-L8-6(a) plus the record-link allowlist `:816-836`), narrowing gated on a props census ·
           (b) a new `contact` member (second value reader, second MS-1…MS-13 payment) · (c) props accepted
           unvalidated, today's `{ ...value.props }` spread [rejected §L2-B: free text is not a boundary]
  OD-L2-3  L2-C multi-value — (a)[R] UNION with `approvalMode` governing, bounded by a publish-time
           `maxSelections` pin · (b) union unbounded (no cap exists today, `ApprovalAssigneeResolver.ts:92-243`)
           · (c) first value only [rejected §L2-C: invents a selection rule no shipped kind has]. Runtime
           truncation is inadmissible in all three
  OD-L2-4  `form_field_user` required-pin retrofit timing — (a)[R] applies to all four kinds at the next
           save/publish; published versions keep shipped behavior and in-flight instances are untouched, with
           the cost disclosed in authoring copy (re-saving an old draft or restoring an old version whose
           referenced field is optional newly fails, `:3651-3660`) · (b) new kinds only, leaving the shipped
           hole open — the accepted-configuration union only widens · (c) immediate retro-invalidation of
           published versions [rejected §2.7: narrows a published contract]
  OD-L2-5  The visibility arm — (a)[R] pin (4) no `visibilityRule`, PLUS the independent create-time 422
           (§2.2) · (b) required-pin only [rejected §L2-C: closes nothing — `ApprovalGraphExecutor.ts:625-627`
           skips hidden fields] · (c) allow `visibilityRule` and rely on the create-time door alone, so a
           legitimately hidden required field fails at submit rather than at publish
  OD-L2-6  Cc-node rows — (a)[R] DEFERRED with the C-6 cite (1886-1891): the cc roster admits 直属部门成员 as
           well, a fourth kind, and `CcNodeConfig` is a separate contract (Lock-1 §K1 / OD-L1-7) · (b) admit
           the approval-node shape on cc now [narrows a corpus-evidenced capability silently] · (c) design
           the fourth kind here
  OD-L2-7  `user` `selection: 'multi'` and the single-valued reader — **a confirm-or-veto, not a choice**: arm
           (b) is rejected in its own text, so what is asked of the owner is confirmation of (a) — (a)[R] array
           support lands in the SAME slice as the prop; until then publish rejects a multi-selection `user`
           field referenced by any assignee source · (b) ship the prop first [rejected §L2-B: widening
           `ApprovalGraphExecutor.ts:351-355` without extending `resolveFormUserValue`
           (`ApprovalAssigneeResolver.ts:44-51`, arrays → null) resolves the node to NOBODY, and an
           author-selected `emptyAssigneePolicy:'auto-approve'` then auto-approves silently]
  OD-L2-8  When the department existence/corp check runs, given the create path passes no `orgId` (`:4794`) —
           (a)[R] on every `department` field, anchored to the create's canonical integration, accepting one
           org resolution for templates that carry the control but route on nothing (otherwise unvalidated
           uuids enter the snapshot and the print surface). **Accepted cost the owner must see before choosing
           (a):** a requester with no directory account, or an org with no integration, has NO anchor, so under
           (a) every submitted department id fails values-free and **any template merely carrying a department
           control becomes unsubmittable for that requester** — including display-only templates that route on
           nothing. Arm (b) confines that blast radius to routed fields. · (b) only when a field-derived source
           references the field, leaving unrouted values unvalidated but keeping unlinked requesters able to
           submit display-only department fields · (c) start passing `orgId` on the create path — a separate
           decision changing requester-relation resolution for every approval

Unverified at this baseline, recorded so no later document treats it as settled:
  - Whether any persisted `user` form field carries `props` today (OD-L2-2's census is a slice deliverable,
    not a finding here), and whether `is_active=false` department rows arise from the sync writer's normal
    path or only from deprovision (gate A-3 asserts the behavior either way).
  - A Lock-1 ERRATUM CANDIDATE, owner-side, with no behavior at stake and nothing re-opened. Lock-1 §K4's
    rule — a level whose manager list is empty or resolves to no linked user contributes nothing and the walk
    CONTINUES upward — is RATIFIED, is expressly marked "not an owner enum", and §L2-C above treats it as
    BINDING on the to-be-built parent-tree walker. The narrow imprecision is only in its supporting cite:
    `resolveManagerChain` (`ApprovalDirectoryOrg.ts:585-615`) walks the LEADER pointer, and `:605-608`
    evidences dense-chain continue for the hop-found-but-UNLINKED arm only; the empty-list analogue in that
    walk necessarily `break`s at `:601`, because an absent leader removes the next anchor itself. On the parent
    tree there is no such coupling — the next level comes from `external_parent_department_id` — so Lock-1's
    rule is coherent and buildable and rests on its own ratified authority rather than on that precedent.
    Recorded so the two documents are not read as disagreeing; correcting the cite is the owner's call.
  - Lock-8's MS-1…MS-13 census and its invariant 2.6 note that no FE per-type property editor exists are
    cited from a PROPOSED branch document and are not re-verified site-by-site here; the five sites §2.7
    names WERE read at this baseline.

Deltas:
Runtime authorization: NONE unless explicitly stated — ratifying this document authorizes design only. Each
  contract still needs its own PR, required checks, adversarial gate, and ledger row. No flag, no UAT, no
  deployment. `continuous_dept_heads`, `dept_head_at_level` and the downward `最高-n` variant remain
  Lock-1's; the handler node remains Lock-3's; cc rows remain deferred.
```

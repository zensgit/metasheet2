# Lock-5 — Per-Node Operation and Member-Action Policy (2026-08-17)

**Status:** RATIFIED (2026-08-17 — §4 record; design authorization only, slices still gated)
**Baseline:** `origin/main@3c5f0992ba931f9a7a1115c0e43c4d33e7a306f6`. Every anchor below was READ AT THIS
BASELINE, verified newer than every parent by `git merge-base --is-ancestor` (master `d33a6a0fa1`, Lock-4
`075d078eb4`, Lock-3 `2f4bf6ce3e` are all ancestors) — line numbers are exact here and may differ from those
documents' own citations. Unqualified `:NNNN` anchors are
`packages/core-backend/src/services/ApprovalProductService.ts`.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-5 row and §P5 — this is
that row's draft; its binding scope is *"per-node transfer/add-sign/reduce-sign/return policy, an
authoring switch for the shipped reject-comment requirement, approved after-sign semantics, and
owner-ratified requester controls"* — plus M4 (fail-closed registry), M7/M8 (enforcement before
rendering), M6 (`signaturePolicy` stays unknown/read-only *until Lock-5*, so §1.5 must dispose of it),
M9 (signature capture is a capability, not dialog chrome), M11 (scoped evidence language).
`approval-lock0-d0-interaction-delta-20260817.md` (RATIFIED, on main) L0-1/L0-2 — the `操作权限` tab
**MUST NOT render** until this lock lands ≥1 functional server-enforced per-node policy; **this document
is what un-gates it**, and Lock-0 gate A-1's "registry fixture declaring a ratified operation policy" is
the fixture this lock defines. `approval-lock1-enterprise-assignees-20260817.md` and
`approval-lock4-flow-policies-20260817.md` (both RATIFIED, on main) — Lock-4 F4-C is the same-person
transfer precedent, Lock-4 §2.3 the four-allowlist hazard restated in §2.2.
**Conditional parent (NOT on main — every seam citing it is conditional):** Lock-3
(`docs/approval-lock3-handler-node-20260817` @ `891abe56a1d78b57b0a71ae604f039bf3ee543cc`), whose §2.2
hardcodes handler transfer-allowed and names this lock's switch, and whose §1.1 `opinionRequired` is this
lock's L5-D applied to a second node type (§1.6 aligns the vocabularies).
**Non-effects:** no runtime code, no migration executed, no flag change, no tenant UAT, no deployment, no
completion label, and no activation of the fifth wizard step (M7/L0-4 keep `测试发布` fourth; master §P3-B
states that Lock-5 per-node controls do not unblock that shell). Requester-side global controls
(批量处理, 秒批提示, 快捷审批, 转发范围) are Lock-6; `readonly`/`editable` enforcement is Lock-7. Each
contract below still needs its own PR, required checks, adversarial gate, and ledger row.

## 0. Corpus evidence, and the two divergences it exposes

Corpus = the offline Feishu administrator handbook (`feishu/6933484342190538780.txt`) §4.3 操作权限 lines
1777-1817 and §5.3 审批人设置 lines 2179-2199; the member handbook (`feishu/7128306615077601308.txt`)
§转交/加签/减签/退回 lines 259-287 and 批量审批/秒批 lines 296-309. Master M11 governs the language: "the
reference corpus did not evidence", never "the competitor lacks".

| # | Corpus statement | Line | Lock-5 disposition |
|---|---|---|---|
| C-1 | 允许转交 — default CHECKED; unchecked ⇒ the approver cannot transfer and must decide themselves | 1786-1789 | L5-A `allowTransfer`, absent ≡ true |
| C-2 | 允许加/减签 — ONE admin switch, default CHECKED, hiding BOTH the 加签 and 减签 member buttons | 1792-1797, 284 | L5-A two keys behind one authoring control (OD-L5-2) |
| C-3 | 加签 modes are 前加签 / 并加签 / 后加签; 前加签 inserts a node BEFORE the current one and returns to it when that node passes | 1794, 269 | L5-B — the shipped `'before'` is a MISLABEL of this (§0.1) |
| C-4 | 后加签 = insert an approval node AFTER the current one; the current node then 自动通过 and flows to it | 271 | L5-B runtime shape (OD-L5-4) — no node-insertion mechanism exists |
| C-5 | 并加签 = add approvers to the current node; aggregation follows the node's configured 会签/或签 | 270 | MATCHES the shipped `'parallel'` behavior |
| C-6 | With ≥2 addees, 前加签/后加签 additionally require choosing 会签 or 或签 | 273-275 | L5-B `addSignAggregation` (OD-L5-5) |
| C-7 | 允许回退 — default CHECKED; two post-return flow semantics: everyone after the returned node re-approves, OR only the returned node's approver re-approves and flow jumps back to the current node | 1799-1803 | L5-A `allowReturn` + `returnReviewMode` (OD-L5-6) |
| C-8 | 退回 (member) may select MULTIPLE nodes; all re-approve, then flow continues back to the current node | 285-287 | vocabulary + arity divergence (§0.1); v1 stays single-target |
| C-9 | 手写签名 — default UNCHECKED; after 同意 the approver must sign | 1805-1809, 250-252 | L5-E — `signaturePolicy` stays declared-inert (OD-L5-10) |
| C-10 | 审批意见 — default UNCHECKED; when checked the approver must comment **whether approving or rejecting** | 1811-1815 | L5-C/L5-D as ONE tri-valued key (OD-L5-7) |
| C-11 | 不计入审批效率诊断 — default UNCHECKED (i.e. counted) | 1817 | L5-E; Lock-3 OD-L3-4 already owns the metrics split |
| C-12 | 批量处理 / 秒批提示 / 快捷审批 are TEMPLATE-level 审批人设置, not per-node | 2179-2199 | Lock-6, not this lock (L5-E names them) |

**Two divergences the table above should not let pass silently.** First, our reject-comment requirement is
STRICTER than the corpus default: C-10's switch is default-OFF while `:6698-6700` requires a reject comment
**unconditionally**, so a Feishu-shaped boolean cannot express today's behavior — hence §1.3's three-valued
enum. Second, the member vocabulary is 退回, the admin vocabulary 回退, and the arity differs (C-8
multi-select vs. our single `targetNodeKey`; the FE already ships 退回 as its button label,
`ApprovalDetailView.vue:416`); v1 keeps single-target and one vocabulary per surface.

### 0.1 Shipped surfaces this lock reuses or corrects

| Shipped surface | Anchor at this baseline | Lock-5 disposition |
|---|---|---|
| the one authored, server-enforced action switch | `RuntimePolicy.allowRevoke` (`types/approval-product.ts:242-246`, required boolean `:2687-2690`) → frozen into `policy_snapshot` at create (`:5224`) → enforced 409 `APPROVAL_REVOKE_DISABLED` (`:6615-6618`) → FE reads it strictly (`ApprovalDetailView.vue:1007` `=== true`) to hide 撤回 (`:470`) | THE PRECEDENT, copied end to end; revoke itself stays TEMPLATE-level and is not moved |
| per-node policy object with a strict normalizer | `signaturePolicy` (`types/approval-product.ts:135`, `SignaturePolicy` `:143-147`), `normalizeNodeSignaturePolicy` (`:1158-1187`) — unknown sub-keys `failValidation` at `:1167-1172` | the SHAPE template for `nodeOperationPolicy` (§1.1); its own switch stays deferred (§1.5) |
| the four allowlists | backend: `:1840-1855` rebuilds an approval node's config from a fixed spread (the `:1189-1194` comment states an un-copied field is silently dropped), re-run on every load (`asApprovalGraph:2358-2360`, `asRuntimeGraph:2708-2732`). FE: `BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS` (`templateAuthoring.ts:588-596`), linear `allowedConfigKeys` (`:759-770`), nested `BACKEND_AUTO_APPROVAL_POLICY_KEYS` (`:613`) | a key absent from the backend list survives neither publish nor reload; `signaturePolicy` is in NONE of the FE two ⇒ a template carrying it is read-only in BOTH editors today (deliberate per master M6). `nodeOperationPolicy` must land in all four in ONE slice or it inherits that fate |
| add_sign, both modes, and BOTH coercion doors | `:6488-6546`; service coercion `:6495`; route filter `routes/approvals.ts:1986-1991` (anything but `'before'`/`'parallel'` becomes `undefined`); INV-6 parallel refusal `:6503-6514` (409 `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`); assignments `executor.buildAddSignAssignments(currentNodeKey, targetUserIds, actorId)` (`ApprovalGraphExecutor.ts:907-915`); epoch PRESERVED (`:6516`) | **`'before'` is audit-metadata only.** The builder takes no mode argument and both modes insert co-signer seats at the CURRENT node in the SAME epoch, so outside a parallel region `'before'` and `'parallel'` are byte-identical runtime behavior — yet the FE ships a `前加签`/`并加签` radio (`ApprovalDetailView.vue:640-645`, testid `approval-add-sign-mode`). `'after'` is unreachable until BOTH coercion doors move (gate B-1) |
| return | `:6706-6791`; parallel refusal `:6706-6716`; single `targetNodeKey` `:6717-6720`; visited-node check `:6721-6728` (`.slice(0,-1)` also forbids self); `resolveReturnToNode` = `resolveFromNode(target)` (`ApprovalGraphExecutor.ts:834-837`); fresh epoch `:6764` | our shipped semantic is C-7's FIRST arm (resume forward). C-7's second arm has no carrier and no flag — greps for `returnMode`/`resumeFrom` find nothing |
| transfer | `:6456-6486`; only two shape checks; epoch preserved `:6466`; `buildTransferAssignments` (`ApprovalGraphExecutor.ts:907-915`) validates nothing about the target | no policy gate exists; Lock-4 F4-C's same-person rule is design text, not code (zero hits for `samePersonPolicy`) |
| the reject-comment requirement | written hardcoded `true` into `policy_snapshot` at `:5224`; read by the bridge path (`ApprovalBridgeService.ts:728-729`, `!== false`), the card path (`ApprovalCardDeliveryAction.ts:132-136`, `:193`) and four FE sites (`ApprovalDetailView.vue:1233-1238`, `ApprovalCenterView.vue:821`/`:872`, `ApprovalCardDecisionView.vue:129`); enforced on the platform path by an UNCONDITIONAL check at `:6698-6700` | two independent hardcodings that agree only by construction — §1.3 must move BOTH |
| the audit writer | `insertApprovalRecord` (`:7942-7968`), `metadata` jsonb; `approval_records_action_check` last widened to 14 members by `zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts:26-52` (template: `zzzz20260616130000_add_add_reduce_sign_actions_to_approval_records.ts`) | §1.4's denial row needs that migration; Lock-3 §2.1 contracts the same one for `'handle'` |
| the actor authorization gate, and FE gating today | `:6321-6323` — `request.action !== 'revoke' && !actorCanAct` ⇒ 403 `APPROVAL_ASSIGNMENT_REQUIRED`; on the FE, `canAct` is GLOBAL RBAC `approvals:act` (`apps/web/src/approvals/permissions.ts:45`), not per-node, and the deferred bar is additionally `!isMobileLayout` (`ApprovalDetailView.vue:404-449`) | the single choke sits immediately AFTER `:6321-6323` (§2.1), which is what makes §1.4 possible; the FE mirror is new plumbing, not a new condition on an existing one — `allowRevoke` is the only config-driven hide in the product today |

## 1. Contracts

### 1.1 L5-A — Per-node operation switches (操作权限)

**Carrier.** ONE new key on `ApprovalNodeConfig`, structurally modelled on `signaturePolicy`:

```ts
nodeOperationPolicy?: {
  allowTransfer?: boolean                                    // absent ≡ true (C-1)
  allowAddSign?: boolean                                     // absent ≡ true (C-2)
  allowReduceSign?: boolean                                  // absent ≡ true (C-2)
  allowReturn?: boolean                                      // absent ≡ true (C-7)
  returnReviewMode?: 'resume_forward' | 'jump_back_to_current' // absent ≡ 'resume_forward' (§1.2)
  commentRequired?: 'never' | 'reject_only' | 'always'         // absent ≡ the instance snapshot (§1.3)
}
```

Every field is absent-≡-today, so existing graphs are byte-stable and no migration touches stored JSON; an
all-absent object is OMITTED rather than persisted as `{}` (Lock-4 §0's `buildStepConfig` discipline).

**Why one object and not six flat keys (OD-L5-1).** Four-allowlist arithmetic (Lock-4 §2.3), not taste: each
top-level key must be added to the backend rebuild (`:1840-1855`), both FE guards
(`templateAuthoring.ts:588-596`, `:759-770`), and — if nested — its own key list beside
`BACKEND_AUTO_APPROVAL_POLICY_KEYS` (`:613`). Six flat keys is 18 allowlist edits with six chances to miss one;
one object is 3 edits plus one nested list, and it is 1:1 with the `操作权限` tab the corpus groups these settings
into. `signaturePolicy` is the shipped worked example of this shape — and of the failure mode, never having
been added to either FE guard.

**Normalizer strictness, two hazards disclosed.** Copy `normalizeNodeSignaturePolicy` (`:1158-1187`):
unknown sub-keys `failValidation` at publish; out-of-enum `returnReviewMode`/`commentRequired` rejected,
never coerced. (1) Because `normalizeApprovalGraph` also runs on every LOAD (`:2358-2360`, `:2708-2732`),
strict-on-unknown means a key written by a newer server makes the graph unloadable on an older one —
inherited from `signaturePolicy`, not introduced here; the fix, if wanted, is a forward-compatibility slice
covering both keys, never a weakening here. (2) Master M4's "unknown persisted values round-trip read-only"
is delivered by neither this normalizer nor the top-level whitelist (which silently STRIPS unknown keys,
`:1840-1855`) but by the FE drop-detection guard forcing the template read-only so no save occurs; copy
claiming otherwise is wrong about this codebase.

**Enforcement is server-side and independent of the UI.** A disabled operation is refused with 409
`APPROVAL_NODE_OPERATION_DISABLED`, details `{ nodeKey, operation }` only — one code for all four verbs,
the verb in `details.operation`. **409, not 403, deliberately:** the actor IS authorized, having held a seat
and passed `:6321-6323`, so a 403 would tell every client the wrong thing (re-authenticate) about a
template-configuration state. This matches `APPROVAL_REVOKE_DISABLED` (409, `:6615-6618`) and the
`*_UNSUPPORTED` refusals (`:6510`, `:6714`).

**Scope, and what stays put.** The switches govern the four member verbs only: `approve`, `reject` and
`comment` are never switchable (a node whose approver may not decide is not an approval node), and `revoke`
keeps its template-level carrier — moving it per-node would create a second precedence rule for one semantic,
the shape Lock-4 OD-L4-4 rejected. **In-flight instances also keep their policy:** an instance pins
`published_definition_id` (`:5456-5466`; the `:4077` comment — the runtime graph comes "from the instance's own
frozen `published_definition_id`, never from the parent"), so a flip reaches only instances created after the
next publish. Byte-stable and correct, but the authoring copy must say so or an administrator reads the
checkbox as immediate (A-4).

### 1.2 L5-A(ii) — The two return semantics

`'resume_forward'` is today's behavior verbatim: `resolveReturnToNode` re-enters the target and the flow
walks forward again, so every node after it re-approves (C-7 first arm).

`'jump_back_to_current'` (C-7 second arm, and what the member handbook describes at C-8) needs state the
instance does not carry: the origin node must be remembered across the returned node's decision and consumed
exactly once. The recommended shape adds no column — the `return` audit row already records
`{ nodeKey, targetNodeKey, nextNodeKey }` (`:6772-6776`), so the origin is recoverable from append-only
history, and the one-shot jump lands on the existing admin jump path (`:5456-5480`) rather than a second
forward-walk implementation. Two consequences must be gated, not assumed: the jump must be idempotent under
a re-return to the same node, and it must respect the fresh epoch minted at `:6764` so a prior round's votes
never satisfy the re-entered node.

**This composes with an OPEN Lock-4 decision.** OD-L4-10(a) scopes dedup history to the current post-return
round via `nodeEntryEpoch`; until it lands, `'jump_back_to_current'` inherits the return-nullification
reading Lock-4 §F4-D records (with `mergeAdjacentApprover` on, a returned node can be auto-approved by a
pre-return approval). **This document did not execute that trace either.** Locked ordering: no
`returnReviewMode` control renders before OD-L4-10 is implemented or disclosed in copy.

### 1.3 L5-C / L5-D — The comment requirement, one key for both sides

`commentRequired: 'never' | 'reject_only' | 'always'`. Absent ≡ the instance's snapshot value, which is `true`
for every instance created before this slice, i.e. `'reject_only'` ≡ today — ONE rule, not a literal default
racing the fallback below. Three values, not two booleans: the corpus's single switch (C-10) has two states
and neither is our default (OFF ⇒ `'never'`, ON ⇒ `'always'`; today's reject-only asymmetry is expressible in
neither), and four boolean states over a three-state semantic is the shape Lock-4 OD-L4-6 rejected for dedup
tiers, for the same reason: the audit row cannot report which state was configured.

**Both hardcodings move in the same slice, and the shipped error code does not change.** `:6698-6700` must
read the effective policy instead of always requiring a comment, and `:5224` must stop writing a literal
`true`. Either alone is a defect: leaving `:6698` strict makes the switch inert on the platform path;
leaving `:5224` hardcoded makes the bridge and card paths and all four FE sites disagree with the node.
Reject-side denials keep emitting `APPROVAL_ERROR_CODES.REJECT_COMMENT_REQUIRED` — existing clients key on
it — while the approve side gets a NEW `APPROVAL_COMMENT_REQUIRED`, so no shipped client's error handling
changes meaning.

**Level: NODE, with the instance snapshot as fallback (OD-L5-8).** Enforcement reads the node's
`commentRequired` from the instance's frozen runtime graph and, when absent, falls back to
`policy_snapshot.rejectCommentRequired` (byte-stable, no backfill). Node level is where the corpus puts it,
and the only level that can differ per node.

### 1.4 Denied-attempt audit

**Recommended: one `approval_records` row per policy denial** (`action:'policy_denied'`, `actor_id` = the denied
actor, `from_status`/`to_status` unchanged, `metadata: { nodeKey, nodeEntryEpoch, operation, policyKey }`, no
comment), plus the CHECK migration in the `zzzz20260702110000_…_admin_scopes.ts:26-52` pattern. Two facts:

1. **A denial today survives nothing.** Every refusal in `dispatchAction` throws inside the transaction
   opened at `:6238` and is rolled back. The single choke (§2.1) sits after the authorization gate
   `:6321-6323` and **before the first verb branch `:6440`**, where the transaction holds only a
   `SELECT … FOR UPDATE` and has written nothing — so the denial path INSERTs the row, `COMMIT`s that
   records-only transaction, and throws: one connection, atomic, no post-rollback second write. This is
   available only at that position.
2. **Row placement matters because six readers are not action-filtered.** Four are `actor_id`-keyed and
   grant or scope on a row's mere existence — attachment authorization
   (`approval-attachment-runtime.ts:231`), the metrics participant check (`routes/approval-metrics.ts:207`,
   otherwise 403 `Not a participant`), bridge participation scoping (`ApprovalBridgeService.ts:423`, `:505`)
   — and two are unfiltered full-timeline reads (`routes/approval-history.ts:84`/`:99`,
   `ApprovalBridgeService.ts:976`). Because the gate runs strictly AFTER `:6321-6323`, a denial row's actor
   already holds an active seat and is already a participant by the assignment clause, so the `actor_id`
   readers gain nothing — an invariant to pin (D-2), not a coincidence to rely on. The two timeline readers
   must exclude `'policy_denied'` in the same slice, or a refused click appears in the member timeline and
   shifts its pagination count. Action-filtered readers need no change but must be shown not to move (D-4).

### 1.5 L5-E — Deferred capabilities, named so no later document treats them as covered

| Capability | Why it is not in this lock | Owner slice |
|---|---|---|
| 手写签名 (C-9) | `signaturePolicy` stays DECLARED-INERT and unrendered — a switch whose runtime never blocks is M8 theater, and enforcing it means capture, upload ownership, retention, download and audit: an M9-shaped capability. Master M6's "read-only until Lock-5" is discharged as **still read-only, now with a named owner slice**; that slice owns the `appliesTo: 'approve' \| 'approve_reject'` vocabulary on `SignaturePolicy` (`:143-147`), which §1.3 deliberately does not reuse (a signature and a comment are different artifacts with different retention) | OD-L5-10 |
| 秒批标记 (C-12) | needs a client-supplied dwell signal with no server-authoritative source, and a policy may not rest on an unattested client measurement | Lock-6, if at all |
| 快捷审批 (C-12) | template-level; the card path already reads `policy_snapshot` (`ApprovalCardDeliveryAction.ts:193`) | Lock-6 |
| 批量处理 (C-12) | template-level; the shipped batch verbs are `'approve' \| 'reject'` only (`ApprovalCenterView.vue:747-773`) | Lock-6 |
| 不计入审批效率诊断 (C-11) | node-level, but the metrics split is Lock-3 OD-L3-4's and must be decided once, there | Lock-3 |
| multi-target 退回 (C-8), action attachments (M9) | named, not designed; neither has a carrier at this baseline | own slices |
| requester controls, named in the §P5 charter clause quoted above | master §3 assigns "requester and global approval/document policy" to Lock-6; this lock mints nothing narrower rather than pre-empting that registry row, and the routing is recorded here so the dropped clause is not read as an omission | Lock-6 |

### 1.6 L5-F — Lock-3 handler alignment

Conditional on Lock-3 landing. A handler node admits **`allowTransfer` and `commentRequired` only**;
`allowAddSign`, `allowReduceSign` and `allowReturn` are rejected at the authoring choke with Lock-3's
`APPROVAL_HANDLER_CONFIG_INVALID`, because Lock-3 §2.2 already 409s those verbs at a handler node — a switch
over an impossible verb is theater by M8. `allowTransfer` absent ≡ true replaces Lock-3's hardcoded
transfer-allowed with no behavior change.

**Vocabulary alignment, not a fork (OD-L5-7).** Lock-3 §1.1 declares `opinionRequired?: boolean` (absent ≡
false); the recommendation is that its slice instead adopts `commentRequired` restricted to `'never' |
'always'`, absent ≡ `'never'` — OD-L3-3's default preserved exactly, one key for both node types. Per-type
admitted sets and absent-defaults are the registry's job (§2.5); Lock-3 is not on main, so this costs an edit
to an unmerged document, not a migration.

## 2. Cross-cutting invariants

**2.1 One choke, one exported table, enforcement before rendering (M7/M8).** The gate is a single
inert-by-default check placed immediately after `:6321-6323` and before `:6440` — not one per verb branch.
Verb branches are scattered (`comment:6440`, `transfer:6456`, `add_sign:6488`, `reduce_sign:6548`,
`revoke:6615`) and all five return early **before** the `pending` check at `:6690`, so a gate placed near the
reject-comment check would silently miss four of the five. The choke reads one exported `ACTION_POLICY_KEYS`
map from verb to policy key and every assertion iterates that map rather than naming verbs by hand (A-1):
per-verb hand-written negatives are the enumeration anti-pattern this program has been bitten by, and a
table plus exhaustiveness is the convergent form.

**2.2 One key, four allowlists, ONE slice (§1.1, Lock-4 §2.3).** All four move together or the key is dropped
on save/reload (backend rebuild) or forces every carrying template READ-ONLY (either FE guard) —
`signaturePolicy`'s live state. The bar is "stays EDITABLE", not "round-trips safely" (A-3).

**2.3 UI hiding and server refusal are two doors and must be proved independently.** The FE mirror derives from
the SAME config the server enforces — no second predicate — but the gate must neuter each separately and see a
distinct named failure: hide-only leaves a direct-HTTP bypass, deny-only leaves a button that always errors,
and one test asserting "hidden and denied" proves nothing about door-level exclusivity (A-2). Do not compound
the pre-existing divergence at `returnableNodes` (`ApprovalDetailView.vue:1209-1223`, derived from history
metadata rather than the graph): `allowReturn` hides the button; `:6721-6728` stays the authority.

**2.4 Values-free errors, with a live counterexample in the same method.** `ServiceError.details` IS serialized
to clients (`routes/approvals.ts:229-237`) and the threshold error at `:6996-7001` already leaks
`{ instanceId, nodeKey, threshold, approvedCount }`. Every error this lock adds stays 3-arg or carries
`{ nodeKey, operation }` only — never an actor id, target id, seat count, or form value.

**2.5 The registry is what renders the tab, per node type (M4 / L0-2).** `操作权限` renders only for a node
type whose registry entry declares ≥1 ratified, implemented, server-enforced policy: an `approval` node gets
the six §1.1 fields; a `handler` node (conditional on Lock-3) gets two (§1.6); `start`, `end`, `cc`,
`condition` and `parallel` get no tab and reject the key at the AUTHORING choke (`normalizeApprovalGraph`,
distinct from §2.1's dispatch choke). Nothing is hand-written per type, and no field appears before its
enforcement lands — a partially-implemented lock renders a partial tab, never a disabled one. No tab strip
exists today (`ApprovalCanvasNodeInspector.vue:162-163` is one hardcoded `节点设置` label plus a slot), so the
strip is Lock-0's L0-1 work and this lock supplies its first non-empty third tab.

## 3. Acceptance gates

Every absence assertion carries a positive control; an absence test without one is green against nothing. Every
mutation row must name the test it turns red and assert the anchor was hit. Backend gates land in the required
backend lane; frontend gates extend `apps/web/scripts/run-required-web-tests.sh`, never an ungated file.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| A-1 | Choke exhaustiveness | `ACTION_POLICY_KEYS` partitions `APPROVAL_ACTION_TYPES` (`types/approval-product.ts:19-29`) by EXACT SET EQUALITY into 4 policy-gated and 4 by-decision-ungated verbs; the suite iterates the map, and each of the four disabled verbs is refused 409 `APPROVAL_NODE_OPERATION_DISABLED` | adding a 9th verb to the union with no map entry fails the equality test; each verb with its switch ABSENT succeeds — refusal is switch-selected |
| A-2 | Two doors, separately | neutering ONLY the server check leaves a direct-HTTP call succeeding (red); neutering ONLY the FE derivation leaves the button visible with the server still refusing (red). Each mutation reds a DIFFERENT named test | the unneutered build passes both; a switch left absent shows the button AND succeeds |
| A-3 | Key stays editable, not merely round-trip-safe | a template carrying `nodeOperationPolicy` survives publish AND reload (`:1840-1855`, `:2358-2360`) and stays EDITABLE in BOTH editors | a template carrying `signaturePolicy` still goes read-only in both — proving the allowlists widened for this key rather than the guard being removed |
| A-4 | In-flight freeze | an instance created before a switch flip keeps the old policy; one created after the next publish gets the new one | the same flip with no republish changes nothing at all |
| A-5 | Placement | `nodeOperationPolicy` on `start`/`end`/`cc`/`condition`/`parallel` fails publish 400 | the identical key on an `approval` node publishes — rejection is type-selected |
| A-6 | Shape strictness and emptiness | an unknown sub-key and an out-of-enum `returnReviewMode`/`commentRequired` fail publish, neither coerced; authoring all-default switches leaves the persisted config byte-identical (no `nodeOperationPolicy` key at all) | a valid object with the same surrounding graph publishes, and setting one switch to `false` DOES change the bytes |
| A-7 | Add/reduce projection (OD-L5-2) | the combined 允许加/减签 checkbox writes BOTH keys; a persisted mixed state (`allowAddSign:true, allowReduceSign:false`) renders read-only and round-trips unchanged; flipping the checkbox never clears a sibling `nodeOperationPolicy` field | a matched pair renders editable — read-only is state-selected |
| B-1 | Add-sign mode is explicit at BOTH doors | `'after'` reaches the service as `'after'` (route `:1986-1991` widened) and an unknown mode is 400 `APPROVAL_ADD_SIGN_MODE_INVALID`; reverting EITHER door alone turns a named test red | `'parallel'` and `'before'` behave exactly as today — the change is value-selected |
| B-2 | `'before'` honesty | a test pins that pre-slice `'before'` and `'parallel'` produce identical assignments/epoch outside a parallel region, and that the FE label no longer claims an unimplemented semantic | the parallel-region case still diverges (409 for `'before'`), proving the pin is not vacuous |
| B-3 | After-sign runtime shape | the ratified OD-L5-4 arm executes: the appended round activates, the actor's seat is consumed, and the instance does NOT terminate early. Cannot be written before OD-L5-4 is decided | the same fixture with `'parallel'` keeps one node and one epoch |
| B-4 | After-sign in a parallel region | `'after'` inside a parallel region is refused, reusing `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED` | `'after'` on a linear node succeeds — placement-selected, and no new error code appears |
| B-5 | ≥2-addee aggregation | with ≥2 addees the ratified `addSignAggregation` governs the appended round; `'all'` requires every addee, `'any'` the first | a single addee needs no aggregation choice and is unaffected |
| CR-1 | Comment enum, platform path | `'never'` lets a bare reject through; `'always'` refuses a bare approve with `APPROVAL_COMMENT_REQUIRED`; `'reject_only'` and absent both reproduce today exactly, still emitting `REJECT_COMMENT_REQUIRED` | mutating `:6698-6700` back to unconditional reds the `'never'` test — the enum, not the FE, is enforcing |
| CR-2 | Snapshot fallback | an instance created before this slice (no node key, `policy_snapshot.rejectCommentRequired:true`) still requires a reject comment | an instance whose node says `'never'` does not — the fallback is presence-selected |
| CR-3 | All four FE sites agree | detail dialog, batch reject, per-row reject and the card view all derive from the effective policy, not a literal | with `'always'`, the approve dialog also requires a comment — the approve side is wired, not just relabelled |
| D-1 | Denial row, durable and isolated | a refused operation writes exactly one `action:'policy_denied'` row carrying `{ nodeKey, nodeEntryEpoch, operation, policyKey }`, the CHECK accepts it, `'policy_deniedx'` is still DB-rejected, and the records-only commit survives while the operation's own effects do NOT (no assignment, epoch bump, version bump or status change) | reverting only the migration reds the insert (the CHECK is exercised, not just the TS union), and the allowed path in the same fixture commits all those effects |
| D-2 | Denial cannot widen access | the denied actor gains no capability from the row: `approval-attachment-runtime.ts:231`, `routes/approval-metrics.ts:207`, `ApprovalBridgeService.ts:423`/`:505` return the same verdict before and after | a non-participant attempting the same operation is refused at `:6321-6323` and writes NO row — proving the gate order, not just the row shape |
| D-3 | Timeline exclusion | `routes/approval-history.ts:84`/`:99` and `ApprovalBridgeService.ts:976` omit denial rows AND their pagination `total` is unchanged | a `transfer` row in the same instance IS listed — the exclusion is action-selected |
| D-4 | Action-filtered readers unmoved | `loadApprovalHistory` (`:3220`, `action='approve'`), the revoke window (`:6634`, `IN ('approve','reject','transfer')`), the threshold tally (`:6943-6977`) and `DECISION_ACTIONS` (`multitable/approval-record-projection-service.ts:357`) produce byte-identical results with and without denial rows | injecting a real `approve` row DOES move each — the invariance is not vacuous |
| E-1 | Registry-driven tab | an `approval` node renders `操作权限` with exactly the implemented fields; `start`/`end`/`cc`/`condition`/`parallel` render no such element; a `handler` node (if Lock-3 landed) renders exactly two fields | a registry fixture with zero ratified policies renders NO third tab — Lock-0 A-1/A-2 still hold, and this lock's fixture is what satisfies A-1's positive control |
| E-2 | No inert control | every rendered field's server enforcement, when neutered, reds a named test; `signaturePolicy` renders NO control anywhere | the unneutered build passes those tests, and the `signaturePolicy` absence assertion is paired with E-1's rendered fields so it is not green against an empty tab |
| F-1 | Handler alignment (conditional) | `allowAddSign`/`allowReduceSign`/`allowReturn` on a handler node fail publish; `allowTransfer:false` refuses a handler transfer 409 | `allowTransfer` absent still permits it (Lock-3 §2.2 behavior preserved) — the switch is value-selected |
| X-1 | Values-free | every new error carries `{ nodeKey, operation }` at most, on both the HTTP body and the log line | assert the SAME path DOES carry `nodeKey` — the check is not passing on an empty payload |
| X-2 | Old-graph compatibility | a corpus of pre-Lock-5 published graphs round-trips save → publish → preview → execute → version-compare → restore byte-for-byte | mutate one `nodeOperationPolicy` field in a new-format fixture and assert the version diff SHOWS it |
| X-3 | Browser check, per surface | real-browser (not jsdom): the AUTHORING `操作权限` tab is reachable, operable and state-announced at 1440×900, 1024×768 and 390×844; the MEMBER bar mirrors a disabled operation at the two desktop widths ONLY — the deferred verbs are `!isMobileLayout`-gated (`ApprovalDetailView.vue:404-449`), so the four switches have no mobile affordance to hide and 390×844 instead asserts approve/reject/comment unchanged | a node with all switches at default shows every deferred affordance at both desktop widths, and the mobile bar is byte-identical under both configurations |

## 4. Owner ratification block

```text
Decision: RATIFY
Owner: zensgit — goal-set in-session instruction (2026-08-17), executing recorded recommendations;
  recorded by the executing session with this provenance; reversible before implementation lands.
Date: 2026-08-17
Document SHA: drafted 799a3a6efa; this record lands on top. — independent pre-ratify review:
  Claude (fable) — spot-verified the add-sign placebo finding (addSignMode stored only in metadata
  :6538; buildAddSignAssignments takes no mode) and the rejectCommentRequired double-hardcode;
  drafted by opus.
Decisions required ([R] = this document's recommendation; rejected options listed so they are not re-proposed):

  OD-L5-1  L5-A carrier — (a)[R] one `nodeOperationPolicy` object on ApprovalNodeConfig, modelled on
           signaturePolicy · (b) six flat config keys (18 allowlist edits) · (c) fields on template-level
           RuntimePolicy [rejected §1.1: a per-node semantic on a template carrier cannot differ per node]
  OD-L5-2  L5-A add/reduce granularity — (a)[R] two keys, ONE authoring checkbox writing both (C-2), a
           persisted mixed state rendered read-only and honestly labelled (the Lock-4 OD-L4-6 projection
           pattern) · (b) one key for both verbs (cannot express a mixed persisted state) · (c) two
           independent checkboxes (widens beyond the corpus)
  OD-L5-3  L5-A defaults — (a)[R] every switch absent ≡ ALLOWED (byte-stable, corpus-default ON) ·
           (b) absent ≡ denied [rejected §1.1: silently changes every existing instance]
  OD-L5-4  L5-B after-sign runtime shape — no shipped path inserts a node (`buildAddSignAssignments` takes
           no mode; both modes seat at the current node, §0.1) and the instance runtime graph is frozen via
           published_definition_id. (a) append a synthetic node to that frozen graph [a NEW mutation
           surface — its own lock] · (b)[R] a deferred same-node round: the actor's seat is consumed as an
           approval, the addees activate as a fresh nodeEntryEpoch round at the SAME node, and the node
           advances when it completes — no graph mutation, existing machinery · (c) defer after-sign,
           shipping only the B-1/B-2 honesty fixes. Under (b) or (c) no copy may claim corpus 后加签
           semantics (当前节点自动通过并流转至新增节点): the node is not skipped
  OD-L5-5  L5-B ≥2-addee sub-mode — (a)[R] `addSignAggregation: 'all'|'any'` supplied at action time,
           required when ≥2 addees for before/after, ABSENT for parallel (which inherits the node mode
           per C-5, today's behavior) · (b) always inherit the node mode (cannot express C-6) ·
           (c) a per-node authored default
  OD-L5-6  L5-A(ii) return semantics — (a)[R] ship `'resume_forward'` only in v1 (today's behavior) and
           defer `'jump_back_to_current'` to a slice ordered AFTER Lock-4 OD-L4-10 · (b) both values now,
           with the §1.2 origin-recovery and idempotence gates · (c) omit the key [rejected §1.2: the
           corpus documents both arms and a boolean cannot hold the choice]
  OD-L5-7  L5-C/L5-D shape and cross-lock alignment — (a)[R] one `commentRequired:
           'never'|'reject_only'|'always'`, absent ≡ 'reject_only', AND Lock-3 adopts the same key
           restricted to 'never'|'always', absent ≡ 'never' (preserving OD-L3-3) · (b) this enum here,
           Lock-3 keeps `opinionRequired: boolean` (two vocabularies — accepted residual) · (c) two
           booleans here [rejected §1.3: four states over a three-state semantic]
  OD-L5-8  L5-C level and fallback — (a)[R] node-level, falling back to the instance's
           policy_snapshot.rejectCommentRequired when the node key is absent (byte-stable, no backfill) ·
           (b) node-level, no fallback, plus a backfill migration · (c) template-level only [rejected
           §1.3: the corpus places it per node and it could not then differ between nodes]
  OD-L5-9  denied-attempt audit — (a)[R] an `action:'policy_denied'` row on the existing approval_records
           table via the §1.4 records-only commit, WITH the CHECK migration and the two timeline exclusions
           in the same slice · (b) silent typed 409 plus a structured server log and counter only — no row,
           no migration, tenant-invisible · (c) reuse an existing action value [rejected §1.4: fabricates
           decision history and would be counted by the action-filtered readers]
  OD-L5-10 L5-E 手写签名 / signaturePolicy — (a)[R] stays DECLARED-INERT and unrendered, M6's read-only
           status discharged as "still read-only, now with a named owner slice" · (b) render it now
           [rejected §1.5: M8 theater] · (c) enforce it here [rejected §1.5: M9-shaped capability]
  OD-L5-11 L5-F handler width (conditional on Lock-3 landing) — (a)[R] handler admits allowTransfer +
           commentRequired only, the other three rejected at the authoring choke · (b) handler admits all
           six [rejected §1.6: Lock-3 §2.2 already 409s those verbs, so the switches are theater]

Decisions recorded: OD-L5-1 (a) · OD-L5-2 (a) · OD-L5-3 (a) · OD-L5-4 (b) deferred same-node
  round with the honesty-copy constraint · OD-L5-5 (a) · OD-L5-6 (a) · OD-L5-7 (a) unified
  commentRequired vocabulary incl. Lock-3 adoption · OD-L5-8 (a) · OD-L5-9 (a) policy_denied row +
  CHECK migration + timeline exclusions same-slice · OD-L5-10 (a) · OD-L5-11 (a) — all per this
  document's recommendations. — Deltas: (none)
Runtime authorization: NONE — ratifying this document would authorize design only. Each L5 slice still needs
  its own PR, required checks, adversarial gate, and ledger row. No flag, no UAT, no deployment, and no
  fifth wizard step (master §P3-B: Lock-5 per-node controls do not unblock that shell). Gates B-3 and B-5
  cannot be written before OD-L5-4/OD-L5-5 are decided, and the `操作权限` tab may not render before at
  least one field's enforcement has landed with its mutation gate green.
```

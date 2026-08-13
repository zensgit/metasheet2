# Attendance Issue #4556 W6 Group Effective-Policy Read Aggregation Design Lock

> Status: **RATIFIED** (W6-1 backend aggregate only) — see the ratification
> record in §9. The narrow delegated-non-member status correction in §10 is
> **RATIFIED** at its exact merged SHA
> `1e0d451a25ccf5b66a6b96cd992233e0f74e8d16` (PR 4876); authorization = an
> owner-confirmed decision recorded through a DISCLOSED assistant relay
> (issue #4556 comment `issuecomment-5275343727`) — see §10.
> Every W6 slice beyond W6-1 remains **HOLD**.
>
> Date: 2026-08-05 · Ratified: 2026-08-08
>
> Pinned baseline: `origin/main@db74bd8667df1084797c97d872fe53ef845e3803`
>
> Ratified proposal SHA: `2967da018ceea41b91098e14d4c15a57236eb5f8`
> (PR 4771, where the original PROPOSED design landed on `main`).
>
> Durable RATIFY-record merge: `ecf77d2433596bbdd8b67c312a37178dbc97f715`
> (PR 4821). Its resulting lock blob remained byte-identical through
> `979c619ebf0ca1dfadedff2dc9b8db69b4f6b74c`. The §10 correction is a later
> PROPOSED delta and does not rewrite either historical record.
>
> Scope: issue #4556, W6 only (锁 §9.7 group effective-policy workspace 的
> read-only 聚合面)
>
> Authorization: on 2026-08-05 the owner authorized **W6 preparation only**
> (design-lock draft, contract draft, fixtures, UI shell). On 2026-08-08 the
> owner RATIFIED the SHA above and authorized **the W6-1 backend aggregate
> slice only**, Draft/HOLD, stopping after a fresh exact-head gate (§9).
> This document still authorizes **no** W6-2/W6-3/W6-4 runtime, no merge, no
> staging, no soak, no flag change, no deployment, no production/customer data
> use, and no closure of issue 4556. Each of those remains a separate owner act.

## 0. Purpose and authority

The RATIFIED parent lock
`attendance-shift-group-advanced-capability-design-lock-20260723.md`
defines W6 in §9.7 as the **group effective-policy workspace**:

- values-free aggregate read model;
- source/effect labels;
- authoritative editor navigation;
- no new universal write.

The remaining-slice plan
`attendance-issue-4556-w4-remaining-slice-plan-20260726.md` §6 restates the
same sequence: W5 单段 flex → **W6 组有效策略只读聚合** → W7 组策略核算切换 →
W8 验证与收口, and records that W6 preparation itself required a separate
owner authorization (granted 2026-08-05, preparation only).

This document turns parent-lock §3.5 (group effective-policy read model),
§4.3 (no hidden group-policy mutation), and §5.1 (group workspace labels)
into an implementable W6 contract. It changes **no** semantics decided in the
parent lock or in the RATIFIED W4 lock
(`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`);
where this document and a RATIFIED lock disagree, the RATIFIED lock wins and
this document must be amended.

W6 is a **read layer**. Winner selection, policy precedence, and any
calculation-chain consumption of group policy remain W7
(parent lock §2.3 of the W4 lock: "W6/W7 calculation-group winner selection
or policy precedence" is OUT of W4; §9.8 gives precedence/cutover to W7).

## 1. Verified current-state spine

Evidence checked against the pinned baseline. Symbols, not raw line numbers,
are the stable anchors.

| Area | Current fact | Evidence |
| --- | --- | --- |
| Group row | `attendance_groups.attendance_type` is CHECK-constrained to `fixed_shift`, `scheduled_shift`, `free_time`. | `zzzz20260529213000_add_attendance_group_type.ts`; `ATTENDANCE_GROUP_TYPES` in `plugins/plugin-attendance/index.cjs` ~L310 |
| Managers | `attendance_group_managers.role` is CHECK-constrained to `owner`, `sub_owner`. | `zzzz20260529233000_create_attendance_group_managers.ts` |
| W1 membership | `attendance_calculation_group_memberships` is effective-dated with an org/user/date uniqueness guard; operations are logged in `attendance_calculation_group_membership_operations`. | `zzzz20260723140000_create_attendance_calculation_group_memberships.ts` |
| W3/W4 posture | `SEGMENT_CALCULATION_IMPLEMENTED = false` in the canonical shift service; org rollout state lives in `attendance_calculation_rollout_state` (`legacy <-> shadow <-> eligible -> authoritative <-> suspended`, `scope='synthetic_staging'`). | `attendance-shift-service.cjs` ~L60; `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts` |
| W5 flex | Landed on main (#4748, merge `7da5d9e55b0f7c9b0a6ca471d38c3aa0115037ab`): `AttendanceFlexPolicyV1` (`strict | flex_required_duration`), single-segment only, authoring-validated core hours. | `packages/core-backend/src/attendance/w5-flex-policy.ts`; `zzzz20260804120000_attendance_shift_flex_policy.ts` |
| Fixed-schedule effectiveness | One derivation exists: `deriveAttendanceGroupFixedScheduleEffectiveness` / `createAttendanceGroupFixedScheduleEffectivenessService`; the FSER lock declares it "the only source for group, employee, trace, and report projections". | `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs`; FSER lock §5 |
| FSER routes | `GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness` (admin) and `PUT .../fixed-schedule/config` exist; the member-safe `/effectiveness/me` projection is a PROPOSED FSER-4 amendment on runtime HOLD. | `plugins/plugin-attendance/index.cjs` ~L44372, ~L44406; `attendance-4709-fser4-member-projection-contract-amendment-20260804.md` |
| Group navigation | #4711 R2 landed: closed route family `/attendance/admin/groups/:groupId/{schedule|calendar|rules}` with closed per-step `surface` tables; `basics` and `people` remain ordinary group-editor stages outside that family; the host must not duplicate the effectiveness query or cache a second status. | `attendance-4711-group-context-routes-design-lock-20260801.md` §3.1; `attendance-4711-r2-drawer-routes-development-verification-20260804.md` |
| Group workspace | The live editor already has the four-stage union `basics | people | schedule | policies`. | `AttendanceGroupWorkflowStage` in `apps/web/src/views/AttendanceView.vue` ~L10964 |
| Per-group punch policy | OD-4556-9 (RATIFIED): org-inherited/read-only in this line. | parent lock §8 |

## 2. Scope and explicit non-goals

### 2.1 W6 delivers

1. one org-scoped, GET-only, values-free **group effective-policy aggregate**
   read endpoint (§4);
2. one closed **source/effect label** union rendered across the existing
   four-stage group workspace (§5);
3. a closed **conflict inventory** where every item carries an exact
   authoritative-editor reference reusing existing navigation (§4.4);
4. UI mount of the aggregate panel behind a default-OFF gate.

### 2.2 W6 reuses without redefining

- the FSER effectiveness state machine, reason codes, and single-source rule;
- the #4711 route family, closed step/surface tables, and authorization-probe
  contract;
- W1 membership uniqueness semantics and the
  `ATTENDANCE_CALCULATION_GROUP_CONFLICT` posture (parent lock §3.4);
- W3 segment limits and the preview-only guard; W5 flex policy shapes;
- the W4 rollout state machine as a **read-only posture input**.

### 2.3 OUT (unchanged by this document)

- W7 winner selection, policy precedence, and calculation cutover;
- any write endpoint, including a universal group save (parent R4,
  OD-4556-10);
- per-group punch-policy enforcement (OD-4556-9);
- employee/self projection of the aggregate (OD-W6-5 below);
- production enablement, staging, soak, deployment, UAT, and #4556 closure;
- changes to FSER-4 (`/effectiveness/me`), which stays its own gated line.

## 3. Non-negotiable red lines

| ID | Rule | Required negative proof |
| --- | --- | --- |
| W6-R1 | The aggregate surface is GET-only; W6 adds zero write endpoints and zero write side effects (no audit-log write, no cache row, no `last_*` column touch). | Route inventory shows no new non-GET route; a DML sweep of the aggregate call path finds zero INSERT/UPDATE/DELETE in both query syntaxes. |
| W6-R2 | The aggregate response is values-free at the member level: counts, closed enums, config-source IDs, and dates only. It never serializes a member list, user ID, punch value, or secret. | Exact-key response assertions on every fixture shape; a leak fixture carrying `memberIds`/`userId` keys fails the contract test. |
| W6-R3 | Authorization precedes every aggregate SQL read: org identity comes only from the authenticated principal; a delegated attendance admin must also hold active membership in the target org; missing and inaccessible groups share one 404 shape. | Cross-org probe, delegated-non-member probe, and spoofed `x-org-id`/query-org probes fail before scoped SQL; removing the guard makes the two-org real-DB leg red. |
| W6-R4 | Fixed-schedule effectiveness has exactly one derivation: the aggregate composes the existing FSER service. W6 introduces no second predicate, no re-derivation, and no cached second status. | A mechanical inventory pins every caller of the FSER derivation; adding a parallel derivation or persisted status cache fails the inventory assertion. |
| W6-R5 | No calculation writer consumes the W6 aggregate. W6 never selects a winner among conflicting policies and never mutates rollout state. | Import graph proves zero calculation-path imports of the W6 module; the membership-overlap fixture must surface `conflict_action_required`, and a choose-first/choose-latest mutation fails. |
| W6-R6 | Label, state, and reason-code enums are closed and enum-strict end to end: unknown input values are rejected 4xx at the boundary; unknown internal states fail closed rather than mapping to a default label. | Every enum field has an invalid-value negative; a silent-fallback mutation (unknown → `needs_configuration` or unknown → default) turns a test red. |
| W6-R7 | Labels derive only from persisted configuration facts plus org rollout posture. Client-supplied hints, query flags, or headers cannot alter a label. | A request carrying label/state override fields is rejected before aggregate SQL; authorization middleware may perform its own RBAC reads before the route handler. Label assertions are byte-exact per fixture. |
| W6-R8 | Editor navigation reuses the existing authoritative surfaces: the #4711 closed route family for `schedule|calendar|rules` and the existing group-editor stage union for `basics|people`. W6 mints no second navigation spelling and no caller-supplied section IDs. | The editor-reference union is closed; an out-of-table step/surface value fails parsing; the UI builder test proves each reference resolves through the existing #4711 builder or stage selector. |
| W6-R9 | PROPOSED authorizes no runtime work. The W6-0 preparation PR is byte-inert: deleting its contract, fixtures, and shell files leaves every existing test green. | **Procedural violation, contained rather than erased:** W6-1 branch commits in PR 4814 predate this durable RATIFY record, so the original "RATIFY predates the first runtime commit" criterion was not met. Those commits remained Draft/HOLD and no W6 runtime reached `main`. The §9 decision is prospective only: after this record lands it authorizes reviewing and repairing the complete W6-1 inventory against fresh `main`; it does not retroactively authorize the earlier commits or authorize their merge. |

## 4. Aggregate read-model contract (draft)

### 4.1 Endpoint

```text
GET /api/attendance/groups/:groupId/effective-policy
```

- Permission: `attendance:admin` in v1 (aligned with the FSER v1 read route).
- Org identity: authenticated principal only; the #4711 §3.2 rules apply
  verbatim (no `getOrgId(req)`, no `DEFAULT_ORG_ID`, byte-equal-or-403 client
  selectors, authenticated-but-unscoped 403 before aggregate SQL).
- Delegated attendance admins must additionally hold active membership in the
  target org (parent lock §3.5, final paragraph).
- Unknown group, cross-org group, and inaccessible group share one values-free
  404 shape.
- The route accepts no state-bearing body and no state-selecting query
  parameter. Any label/state/posture override input is rejected with a typed
  400 before aggregate SQL; an empty JSON object carries no state and is not
  represented as a stronger "no body bytes" guarantee.

### 4.2 Closed enums

Field-by-field provenance: every row below names the ratified clause it
implements; rows marked **RATIFIED** are W6 decisions resolved in §9.

| Enum | Closed values | Provenance |
| --- | --- | --- |
| `AttendanceGroupEffectivePolicySourceLabelV1` | `effective`, `org_inherited`, `preview_only`, `needs_configuration`, `conflict_action_required` | parent §5.1 five display states (exact machine spelling **RATIFIED**, OD-W6-3) |
| `AttendanceGroupEffectivePolicyDomainV1` | `basics`, `membership`, `schedule`, `segments`, `flex`, `rules`, `punch_method`, `request_posture` | parent §3.5 item list (grouping **RATIFIED**, OD-W6-4) |
| `AttendanceGroupEffectivePolicyConflictCodeV1` | `CALCULATION_GROUP_MEMBERSHIP_OVERLAP`, `FIXED_SCHEDULE_CONFIGURATION_CHANGED`, `FIXED_SCHEDULE_PENDING_APPLY`, `FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW`, `SCHEDULE_STRATEGY_INCOMPLETE`, `RULE_SOURCE_MISSING`, `TIMEZONE_MISSING` | v1 closed inventory (**RATIFIED**, OD-W6-4); overlap posture from parent §3.4 |
| `editorRef` union | `{ kind: 'group_stage', stage: 'basics'|'people'|'schedule'|'policies' }` or `{ kind: 'group_context_route', step: 'schedule'|'calendar'|'rules', surface?: <closed per-step table> }` | #4711 §3.1 closed tables + parent §5.1 (union shape **RATIFIED**, OD-W6-9) |

Reason codes inside the embedded fixed-schedule object are the FSER lock's
closed list, unchanged and in FSER order. W6 adds no FSER reason code.

### 4.3 Response shape (draft, exact-key)

The canonical machine-readable copy of this shape is
`packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml`
(not merged into the OpenAPI build in W6-0) and
`packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts`
(types only in W6-0). Summary:

```json
{
  "ok": true,
  "data": {
    "groupId": "uuid",
    "groupType": "fixed_shift",
    "timezone": "Asia/Shanghai",
    "activeMemberCount": 12,
    "managerPosture": { "ownerCount": 1, "subOwnerCount": 2 },
    "calculationPosture": "legacy",
    "domains": {
      "membership": { "label": "effective", "reasonCodes": [], "editorRef": { "kind": "group_stage", "stage": "people" } },
      "schedule": {
        "label": "effective",
        "strategy": "fixed_shift",
        "reasonCodes": [],
        "sourceRefs": [{ "kind": "shift", "id": "uuid" }],
        "fixedSchedule": { "state": "effective", "reasonCodes": ["EFFECTIVE"], "desired": { "shiftId": "uuid", "startDate": "2026-08-01", "endDate": "2026-08-31", "revision": 2 }, "coverage": { "targetMembers": 12, "matchingMembers": 12, "missingMembers": 0, "nonMemberTargets": 0, "differentKeyRows": 0 }, "drift": { "unconfiguredManagedRows": 0, "unpublishedManagedRows": 0, "managedSets": [] }, "evaluatedAt": "2026-08-05T00:00:00.000Z" },
        "editorRef": { "kind": "group_context_route", "step": "schedule", "surface": "assignments" }
      },
      "segments": { "label": "preview_only", "reasonCodes": ["SEGMENT_CALCULATION_NOT_AUTHORITATIVE"], "editorRef": { "kind": "group_context_route", "step": "schedule", "surface": "shifts" } },
      "flex": { "label": "preview_only", "mode": "flex_required_duration", "reasonCodes": ["SEGMENT_CALCULATION_NOT_AUTHORITATIVE"], "editorRef": { "kind": "group_context_route", "step": "schedule", "surface": "shifts" } },
      "rules": { "label": "org_inherited", "source": "org_default", "sourceRefs": [], "reasonCodes": [], "editorRef": { "kind": "group_context_route", "step": "rules", "surface": "rule-sets" } },
      "punchMethod": { "label": "org_inherited", "source": "org_inherited", "reasonCodes": [], "editorRef": { "kind": "group_stage", "stage": "policies" } },
      "requestPosture": { "label": "org_inherited", "overtime": "org_inherited", "makeupPunch": "org_inherited", "outdoor": "org_inherited", "reasonCodes": [], "editorRef": { "kind": "group_stage", "stage": "policies" } }
    },
    "conflicts": [],
    "evaluatedAt": "2026-08-05T00:00:00.000Z"
  }
}
```

Field provenance against parent §3.5:

| §3.5 item | Field(s) |
| --- | --- |
| group type, timezone, active member count, manager posture | `groupType`, `timezone`, `activeMemberCount`, `managerPosture` (counts only) |
| schedule strategy and whether fully configured | `domains.schedule` incl. embedded FSER object for `fixed_shift` groups |
| rule source, effective or preview-only | `domains.rules.source` + `label` |
| punch method source (`org_inherited` in v1) | `domains.punchMethod` (OD-4556-9) |
| overtime, makeup-punch, outdoor posture | `domains.requestPosture` |
| unresolved conflicts + exact editor route each | `conflicts[]` with `code` + `editorRef` |
| effective date and source IDs, no secrets or member list | `sourceRefs`, dates; W6-R2 forbids member data |

`calculationPosture` mirrors the org's W4 rollout state (`legacy | shadow |
eligible | authoritative | suspended`) as a read-only input for the
`preview_only` labeling of `segments`/`flex`; W6 never writes that state.

### 4.4 Conflict semantics

Every `conflicts[]` item is `{ code, domain, label:
'conflict_action_required', editorRef }`. The aggregate reports; it never
resolves. In particular, a user with two effective calculation-group
memberships on one date is surfaced as
`CALCULATION_GROUP_MEMBERSHIP_OVERLAP` with a **count** of affected
users — never their IDs — and the `people` stage as `editorRef`. Runtime
winner selection stays W7 and stays fail-closed per parent R2.

## 5. UI contract (draft)

1. The existing four-stage group workspace gains one label chip per §5.1
   summary row, rendered from the closed
   `AttendanceGroupEffectivePolicySourceLabelV1` union. Display strings map
   1:1 from the machine union; no free-text status is composed in the view.
2. The aggregate panel (W6-0 shell:
   `apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue`)
   mounts inside the group workspace only behind a default-OFF gate decided in
   OD-W6-7; while OFF the workspace is byte-identical to today.
3. Every conflict row renders one action that resolves through the existing
   #4711 builder (`group_context_route`) or the existing stage selector
   (`group_stage`). No second full editor is nested in the group page
   (parent §5.1).
4. The panel issues exactly one aggregate GET per explicit open/refresh; it
   keeps no second cached status (#4711 host rule) and issues zero writes.
5. New FE logic that is testable (label mapping, editorRef resolution) lives
   in a standalone `.ts` module, not in `AttendanceView.vue` or inside a
   `<script setup>` SFC export; its specs are wired into the required
   `attendance-web-guard` run list **and** both path filters.

## 6. Decision points (owner menu, resolved in §9)

| ID | Question | Options (recommended first) |
| --- | --- | --- |
| OD-W6-1 | Aggregate endpoint path/permission | **(a)** `GET /api/attendance/groups/:groupId/effective-policy` under `attendance:admin`, org from principal, delegated-admin active-membership check (parent §3.5). (b) Fold into the existing group detail response — rejected by default: it widens an existing surface and complicates the values-free proof. |
| OD-W6-2 | Fixed-schedule effectiveness composition | **(a)** Call the existing FSER service inside the aggregate; embed its object verbatim for `fixed_shift` groups; `null` for other types. (b) Link-only (no embed) — weaker: the workspace would need a second fetch and #4711 forbids a second cached status. |
| OD-W6-3 | Machine spelling of the §5.1 label union | **(a)** `effective / org_inherited / preview_only / needs_configuration / conflict_action_required`. (b) Other spellings — any choice must remain a closed 5-value union. |
| OD-W6-4 | v1 conflict/domain closed inventory | **(a)** The §4.2 seven-code conflict list and eight-domain list. (b) Narrower v1 (drop `TIMEZONE_MISSING`, `SCHEDULE_STRATEGY_INCOMPLETE`) — acceptable; any addition later is a contract amendment, not a silent extension. |
| OD-W6-5 | Employee/self projection | **(a)** OUT of W6. The FSER-4 amendment already proved fetch-and-hide is a data-minimization defect; a member-safe self projection needs its own contract and gate. (b) Include a `/me` aggregate — rejected by default for v1. |
| OD-W6-6 | `preview_only` derivation for segments/flex | **(a)** A single-segment `strict` shift is `effective` under any posture (its envelope is the authoritative legacy input, parent R8). Multi-segment shifts and `flex_required_duration` are `preview_only` unless the org rollout posture is `authoritative` and `SEGMENT_CALCULATION_IMPLEMENTED` is true — matching the W3 preview-only guard and the W5 hold. (b) Posture-only derivation for all shifts — mislabels every current single-segment org as preview. |
| OD-W6-7 | UI gate for the panel | **(a)** Org-opt-in setting + env gate, default OFF, `disabled = byte-identical` acceptance. (b) Env gate only. |
| OD-W6-8 | Membership-overlap detection cost | **(a)** Bounded per-group query on current date only, count-of-users output. (b) Date-range scan — deferred; needs its own performance budget. |
| OD-W6-9 | `editorRef` union shape | **(a)** The §4.2 two-kind union (`group_stage` + `group_context_route`), because `basics|people` are outside the #4711 route family by that lock's own §3.1. (b) Extend the #4711 family with `basics|people` routes — that is a #4711 amendment, not a W6 decision. |

## 7. Completion gates (skeleton)

### 7.1 W6-0 preparation (this PR's scope)

- design-lock draft (this file), OpenAPI draft outside the build, types-only
  contract module, fixture pack with per-fixture clause mapping, unmounted UI
  shell;
- zero-behavior proof: OpenAPI `dist/` byte-identical after a rebuild; zero
  runtime imports of the new modules; deletion-green test run recorded;
- merged as Draft/HOLD; owner RATIFY of the exact merged SHA gates W6-1
  (**satisfied prospectively by §9 when this record lands**).

### 7.2 W6-1 backend aggregate (prospectively authorized Draft/HOLD; merge separately gated)

- service + route per §4; real-DB legs in the existing attendance integration
  gate file set, fixture IDs file-namespaced;
- matrix: every §4.3 fixture shape reproduced from seeded rows with exact-key
  deepEqual; two-org isolation; delegated-non-member 404; spoofed org
  selectors 403 before aggregate SQL; unknown group 404 shape parity; invalid enum
  negatives for every enum field;
- mutation legs, each individually red: drop the auth guard; add a second
  FSER derivation; collapse membership overlap to first/latest; silent-map an
  unknown internal state to a label; add any DML to the aggregate path;
- FSER single-source inventory assertion extended to pin the new caller.

### 7.3 W6-2 contract wiring

- move the draft YAML into `packages/openapi/src/paths/`, rebuild dist, SDK
  regen, and the existing attendance OpenAPI contract gate stays green;
- enum values in OpenAPI, TS contract module, and runtime service are proven
  equal by one mechanical comparison test (no hand-copied second list).

### 7.4 W6-3 UI

- labels + panel + conflict navigation per §5, behind the OD-W6-7 gate;
- specs added to `attendance-web-guard.yml` run list and both path filters
  (F1 lesson, #3487); gate-OFF byte-identical assertion; browser evidence on
  the workspace route;
- pure logic in standalone `.ts` modules with exact-shape specs.

### 7.5 W6-4 verification

- development & verification MD with the per-red-line evidence table;
- independent adversarial review; owner review of the completed W6 scope.
- W6 completion claims stop at "code landed, gates green"; enablement,
  staging, soak, and #4556 closure remain separately owner-gated.

## 8. Landing sequence

1. **Completed 2026-08-05:** merge this document (with the W6-0 contract
   draft, fixtures, and shell) as **PROPOSED / Draft / HOLD** after exact-head
   independent review.
2. **Completed prospectively by the merge of this record:** owner RATIFYs the
   exact merged SHA and answers OD-W6-1..9. The contained pre-anchor W6-1
   branch inventory remains disclosed under W6-R9; this step does not make it
   retroactively authorized.
3. W6-1 backend aggregate proceeds as its own gated PR and stops after its
   fresh exact-head gate for a separate owner merge decision.
4. W6-2 contract wiring lands as its own gated PR.
5. W6-3 UI lands as its own gated PR.
6. W6-4 verification MD closes the W6 code scope.
7. Stop. Staging, flags, soak, W7, and #4556 closure each require separate
   owner authorization; no gate in this document auto-triggers them.

## 9. Owner decision — RATIFICATION RECORD (2026-08-08)

This section exists because a PR body cannot be its own authorization source.
On 2026-08-08, after reviewing PR 4821 as the proposed durable record of the
decision table and narrow scope below, the owner explicitly instructed
`合入 #4821`. That merge instruction confirms the resolutions recorded here;
it does not manufacture an earlier verbatim quote or make the authorization
retroactive. **The merge of this document is the durable anchor**; if any line
below misstates the confirmed resolutions, it must not be merged.

Resolved decisions:

| ID | Resolution |
| --- | --- |
| OD-W6-0 | **采纳 / adopt this lock** |
| OD-W6-1 | (a) dedicated `GET /api/attendance/groups/:groupId/effective-policy`, `attendance:admin`, org from the authenticated principal, delegated-admin active-membership check |
| OD-W6-2 | (a) compose the existing FSER service inside the aggregate; embed verbatim for `fixed_shift`, `null` otherwise |
| OD-W6-3 | (a) `effective / org_inherited / preview_only / needs_configuration / conflict_action_required` |
| OD-W6-4 | (a) the §4.2 seven-code conflict list and eight-domain list |
| OD-W6-5 | (a) employee/self projection is OUT of W6 |
| OD-W6-6 | (a) single-segment `strict` = `effective` under any posture; multi-segment and `flex_required_duration` = `preview_only` unless posture is `authoritative` **and** `SEGMENT_CALCULATION_IMPLEMENTED` is true |
| OD-W6-7 | (a) org opt-in setting + env gate, default OFF |
| OD-W6-8 | (a) bounded per-group current-date-only query, count output |
| OD-W6-9 | (a) the §4.2 two-kind `editorRef` union |

**Scope of what the ratification authorizes:** the **W6-1 backend aggregate
slice only**, Draft/HOLD, stopping after a fresh exact-head gate. W6-2 contract
wiring, W6-3 UI, W6-4 verification, any merge, staging, soak, flag change,
deployment, and closure of issue 4556 each remain separate, un-granted owner
acts — §8's landing sequence is unchanged by this record.

## 10. Correction — delegated non-member status (RATIFIED 2026-08-13)

**Status: RATIFIED at exact merged SHA
`1e0d451a25ccf5b66a6b96cd992233e0f74e8d16` (PR 4876).** This section cannot
ratify itself; a PR body is not its own authorization source. The authorization
is an **owner-confirmed decision recorded through a DISCLOSED assistant relay** —
NOT a comment authored from the owner's own client:

- issue #4556 comment `issuecomment-5275343727` (2026-08-13T02:48:23Z) carries
  the owner's verbatim RATIFY text and openly discloses that the assistant posted
  it under the owner's account at the owner's explicit `代贴` instruction;
  https://github.com/zensgit/metasheet2/issues/4556#issuecomment-5275343727
- owner first-person confirmation: **PENDING** — the owner is to post a
  first-person confirmation from their own GitHub client, referencing
  `5275343727`; this record will cite that second comment once it exists. Until
  then the posting attribution rests on account-attribution + the relay
  disclosure, not on an independent owner-client act.

That comment RATIFIES `1e0d451a25…` — approving ONLY the §10 delegated-non-member
403→404 erratum and a docs-only ledger sync from fresh `main` — and this record
merely references it (the authorization is not reproduced here as self-proof).
The merged SHA's lineage was verified: sole parent
`525f47e78ba0815a1f3c0e49aac10035bcbd2d14` (the last renewed baseline), docs-only
(this design-lock plus the unpublished OpenAPI draft), and an ancestor of `main`.
Per that comment the ratification is narrow: it authorizes no PR 4849 catch-up or
merge, no W6-2/W6-3/W6-4, no runtime work, flags, deployment, staging, soak,
production/customer data, or closure of issue 4556.

The RATIFIED W6-R3 and §4.1 require missing and inaccessible groups to share
one values-free 404 shape. The former §7.2 matrix line instead required a 403
for a delegated attendance admin without active target-org membership. That
line contradicted the governing rule and the same document's endpoint
contract.

This correction is deliberately narrow:

1. §7.2 now requires the delegated-non-member leg to return the shared
   values-free 404 shape. Spoofed org selectors remain 403 before aggregate
   SQL.
2. The unpublished OpenAPI draft moves delegated non-membership out of the 403
   description and into the shared inaccessible-group 404 description.
3. No runtime behavior changes here. W6-R3 and §4.1 already selected 404, and
   the W6-1 candidate is reviewed against that existing governing behavior.

On 2026-08-12 the owner initially authorized this independent docs-only
correction to merge as PROPOSED against exact baseline
`979c619ebf0ca1dfadedff2dc9b8db69b4f6b74c`. After unrelated PR 4877 advanced
`main`, the owner renewed the same narrow authorization against exact baseline
`51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f`. After unrelated PR 4874 advanced
`main` again, the owner renewed it against exact baseline
`525f47e78ba0815a1f3c0e49aac10035bcbd2d14`. After merge, the exact correction
SHA must be presented for a separate owner RATIFY. This authorization does not
grant PR 4849 merge, W6-2/W6-3/W6-4, further runtime work, flags, deployment,
staging, soak, production/customer data use, or closure of issue 4556.

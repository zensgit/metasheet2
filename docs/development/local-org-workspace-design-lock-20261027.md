# Local organization workspace design-lock — 2026-10-27

Base: origin/main5b9ec081bba822c6c4f4668552c274ecc906a7e4 (refreshed with all candidate bytes preserved). Own branch codex/local-org-workspace-20261027.
User direction: MetaSheet owns organization truth; external DingTalk directories match/bind to it. Reuse directory_* local provider, never a second tree. Deliver Draft only; no live writes, enablement, merge, deployment or R71 change.

## Finite deliverable
A discoverable /admin/organization admin page: native departments (create/rename/reparent/order/archive), members (find/page, name edit, read-only directory title and explicit-impact archive), explicit department membership/primary/direct-manager/head maintenance, and safe representation of already-active current-org platform members. Native read snapshot and candidate APIs share server default org authority. Existing admin-directory-local CRUD bodies/guards and SliceC account-create refusal remain byte-identical.

Head toggles use Draft6589's dedicated membership endpoint, once for the selected membership, with tri-state loading/error. This branch is fresh main and does not copy that implementation or probe an absent DB column. The complete UI requires6589; a real owned combined runtime proof is mandatory before claiming head UI works. No parent green/ancestor fiction.

## Read seam
GET /api/admin/directory/local/workspace: existing local anchor only, no bootstrap/reactivation; one active anchor, or the sole disabled anchor as read-only. Multiple disabled anchors without an active winner ->409 LOCAL_ORG_ANCHOR_AMBIGUOUS, never latest-row guessing. Return minimal integration/departments, no config/raw/secrets/corp data.
GET /members and /member-candidates: strict page/pageSize/q and required integrationId as expected-anchor precondition. Server independently resolves default local anchor and refuses mismatches409; request org/corp/unknown keys invalid. Repeatable-read READ ONLY transaction; identifiers constrain writes but names/username are display labels. Page25 default/max100. Return total on empty pages.
Members have explicit memberships/primary/isManager; no department head field is fabricated. Selected head state comes from6589. Candidates are active platform users with active current-org membership, no globally applied event/effect, and no existing local projection; advisory only, write rechecks.

## Active-member representation
Dedicated POST /member-projections accepts only {integrationId,localUserId}. It is not the old join-default-org operation. Require exact active user/current-org membership and no applied event OR effect anywhere, after canonical users mutex in separate fresh statements. Existing active local anchor only; FOR SHARE NOWAIT after users mutex avoids reverse blocking against anchor-first writers. Stale anchor ->409; unavailable ->404; protected/partial/inactive/inconsistent projection ->409, never repair/revive.
Create only a missing local account and its linked local_explicit link with existing provider/key/NULL-corp shape. Advance generation atomically via the canonical access-graph helper under the no-applied precondition: both evidence UPDATE statements match zero rows; evidence rows stay byte-identical. Do not claim zero evidence DML statements. No org/role/permission/session/identity/grant/activation/profile changes; users only generation/updated_at. Complete active idempotent projection returns same ID/created=false with no writes or generation increment, after safety checks.
This local sibling participates in existing deprovision candidacy. Prove projection-before-apply sees fresh sibling and apply-before-projection refuses, not a nonexistent stale-preview409 API.

## UI behavior
Independent view/components; do not expand directory-sync megafile beyond a navigation link. Native controls/labels, responsive1366/768/390, errors fixed/values-free, no console dump. Empty/archived/read-only states remain usable. Primary is explicit, not first membership. Job title never grants approvals:act.
Pin read context and session identity; clear selected member/role/private data on reload403, context switch or unmount. Late reads cannot replace newer data/errors/loading. Capture write target before await, serialize writes, no automatic replay; unmount prevents post-write refresh/state effects. Head unknown/error disables its toggle.
No new environment switch or new permission. No broad employee handler grant, real account assignment, template publication, external sync/reconciliation apply or secret read.

## Required proof
Actual original missing UI/read route and active-member oldPOST409 controls; native real-auth HTTP read-only fingerprints, strict input/tenant/provider/evidence/idempotent/G+1/rollback cases, deterministic user/anchor barriers and matching mutations with unchanged budgets. Both event-only and effect-only/global evidence negatives.
Frontend new specs in approval-web-guard AND required-web script/manifests, route/admin gate and current main-entry synthetic browser exercise/screenshot of three widths, real keyboard, failure/race/context controls. A subset does not close the whole UI contract.
Focused affected neighbors, original oldPOST/refusal/pinned plugin workflow source exact, type/lint/validateall and generated-token guard. Dedicated native whole-file CI plus no-DB exclusion/unit wiring guard. Fresh current-head required checks + target execution/final SHA/body/readback.
Keep old failures and per-phase source applicability. Local green is not CI or owner/production acceptance. Whole DingTalk goal, owner/manual/frozen/live gates and two unanswered semantics remain open.


## 2026-10-27 approved representation and review disposition

The human approved the named active-member projection exception for Draft only. The new POST represents an already-active same-org member with no globally applied deprovision evidence. It preserves the old join POST and its Slice C refusal byte-for-byte. It never joins/reactivates an organization, grants roles/permissions/login, copies job titles, or supersedes any evidence row. The canonical helper still executes both empty evidence UPDATE legs and increments generation exactly once on creation; a complete idempotent projection is a no-op. Users mutex then fresh READ COMMITTED reads precede existing active anchor SHARE NOWAIT and account/link NOWAIT locks.

The current source audit keeps existing archive/primary/anchor contracts unchanged. The new UI must accurately expose their consequences and require explicit archive acknowledgement; no detach-only promise. Job title remains read-only here pending the user's requested Astra/ultra unification feasibility review. No title-source migration or remote write is authorized. R74 compatibility packaging is a separate exact-base delivery for the user's unreachable test server, not deployment.

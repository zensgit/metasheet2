# Attendance explicit organization session: development

Written during the **2026-09-09 delivery window**. The filename retains the September 8 slice identifier; this is not a backdated completion claim.

## Product outcome and authority

The owner explicitly authorized users to select an organization to which they belong and receive a newly issued session. This slice closes the organization/session mismatch encountered in the attendance multitable-cleaning user journey. It does not broaden cleaning authority, grant membership, or change ordinary login/default organization-hint selection.

Existing ACP-1A/ACP-1B ratifications govern the cleaning projection and reviewed correction. This slice reuses that contract: users edit a proposal through the actual multitable UI; the same-organization authorized reviewer explicitly applies an eligible correction. Raw punch and leave/travel facts are not directly overwritten. Creating a custom field uses the existing synthetic setup actor's sheet-only authority, not additional reviewer permissions.

## Call chain and boundaries

1. `AttendanceSessionOrgSwitcher.vue` / `useSessionOrg.ts` list active memberships and POST an explicit selection.
2. The authenticated `/api/auth/session-orgs` and `/api/auth/session-org` routes in `packages/core-backend/src/routes/auth.ts` use `AuthService.listActiveMembershipOrgIds`. The POST rechecks active membership and issues a session for the same actor and selected tenant. Nonmembers/revoked members are refused; DB failures remain fixed, values-free errors.
3. `useAuth.ts` installs explicit-session metadata through `explicitSessionOrg.ts`. Both token aliases, actor, tenant, expiry and switch epoch must agree. Invalid/changing metadata fails closed. Normal login hints retain their original meaning; they are not explicit-session authority.
4. `authPrincipal.ts` includes tenant and epoch for explicit sessions. API headers, cached bootstrap/principal answers and approval-capability consumers cannot reuse the prior explicit session's identity. Ordinary subject-keyed behavior is retained.
5. `useAttendanceSessionGuard.ts` captures an immutable page scope. Group host creates the scope; descendants inherit it. Child disposal does not destroy a parent's scope. Non-root UI consumers require a provider. Guards check before send, after response and after body delivery; read consumers also check error/finally state paths.
6. A changed session makes the old page stale/inert without automatically discarding drafts. Explicit discard/reload is the transition into the new session. An old actual confirmation callback remains blocked even if invoked programmatically.

The localStorage marker protocol is **not atomic multi-key CAS**. Ownership checks, readback and fail-closed markers address tested interleavings; browser evidence covers the recorded scenarios, not every possible multi-process interleaving. Rejecting an already-sent result is not rollback of server-side work. Real authorization remains server-side.

## Source provenance

| Layer | Exact source |
| --- | --- |
| Original R1 base | `df8ebfb6f7ea4d62d1186fbb88e0a493a6670e36` |
| Initial R1 checkpoint | `fdea00d8e9a4a87ce2e0be5008ead86bc430f399` |
| Session isolation checkpoint, 29 files | `5f4b643b786bc3986a6398989e7839bfc223eea9` |
| Full-app dependency | #5566 `67dfe774bfb93bc329122d59b5effb1b52e293d8` |
| Strict tenant read dependency | #5564 `10f12e5ae41534e053af0900075d86897ea0762a` |
| Component-to-DB dependency | #5559 `5f006a9e0cc4ba5dce2e7f2b77495f0452cf3ada` |
| Browser-tested combined | `e007096c1af1de5012b2897fb2ea474be3dc6f47` |
| Delivery main pin | `97dc5cefaef6ac11020d83851312f7fc0a812435` |
| Delivery integration | `d20466b4d5ebfcc5aa7fc8efbd50ef29bc7ba308` |

The browser-tested combined has ordered parents `bf05de8bf8a92b669b6f0041acb024d0dc401b9e`, then `5f4b643b786bc3986a6398989e7839bfc223eea9`; tree `3d454202dd1a628b8aace20426bcd85362ecb396`.

Delivery integration is a true merge with ordered parents `e007096c1af1de5012b2897fb2ea474be3dc6f47`, then the exact main pin; tree `bed9ba77cd6e304799933ac613715b92295e91b6`. The 29 checkpoint paths, initial R1 AuthService/routes/switcher/composable, and strict tenant index/resolver were independently compared and remained byte-identical. The frozen combined branch still points to e007096c. Main's automation-rerun-execution required-test addition is retained.

This delivery includes the dependency history, not just the 29-file checkpoint. It does not cherry-pick or modify #5145 (`d9d8f3d8427932d2d25634b3ad3268e02784eb90`, OWNER-HOLD). #5559/#5564/#5566 remain independent OPEN Draft dependencies at the last readback; no merge into main is authorized here.

## CI tail

The authorized tail changes only three CI/test files, plus this document and its verification companion:

- `.github/workflows/attendance-web-guard.yml`: exact shared session sources/specs in both main-push paths and PR changed-file classifier; separate small session test invocation.
- `apps/web/scripts/run-required-web-tests.sh`: same four-spec session group, preserving every prior command and main's added automation token.
- `apps/web/tests/attendance-web-guard-workflow.spec.ts`: parsed workflow run/argv, exact required command and both selectors. Mutation tests remove tokens/triggers independently.

Existing API and approval specs retain their actual required invocation positions. Admin and self-service suites are not newly combined into a single fork. No workflow dispatch or remote rerun is part of this local tail.

## Delivery status

See [verification](attendance-session-org-cleaning-verification-20260908.md) for evidence and failures. Local source and fixed-combined synthetic browser validation are separate from remote exact-head CI, main runtime, user-site UAT, deployment and flag state. No such downstream state is inferred from source. Publication is pending coordination; no push, new PR, Ready, merge, deployment or persistent flag change was performed in this tail.
